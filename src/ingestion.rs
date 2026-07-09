//! Ingestion orchestration and run-state persistence.
//!
//! Each ingestion attempt is stored as its own row in `ingestion_runs`. This
//! makes failed and abandoned runs visible without requiring a database reset.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use apalis::prelude::Data;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;
use tracing::{debug, error, info, warn};

use crate::hyperliquid::{CandleIngester, FundingRateIngester, Hyperliquid, HyperliquidError};
use crate::market_metadata::{MarketsLedger, load_markets};
use crate::timeframe::Timeframe;

const TIMEFRAMES: &[Timeframe] = &[
    Timeframe::FifteenMin,
    Timeframe::OneHour,
    Timeframe::OneDay,
    Timeframe::OneWeek,
];
const ABANDONED_RUN_REASON: &str = "backend restarted before ingestion completed";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct IngestionRunId(String);

impl IngestionRunId {
    fn new(started_at: DateTime<Utc>) -> Self {
        Self(format!("ingestion-{}", started_at.timestamp_micros()))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for IngestionRunId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IngestionJob {
    run_id: IngestionRunId,
}

impl IngestionJob {
    pub(crate) fn new(run_id: IngestionRunId) -> Self {
        Self { run_id }
    }

    pub(crate) async fn run(
        self,
        pool: Data<SqlitePool>,
        services: Data<Arc<IngestionServices>>,
    ) -> Result<(), IngestionRunError> {
        match touch_run(&pool, &self.run_id).await {
            Ok(()) => {}
            // A stale delivery: the run already left `running` (recovered on
            // restart, completed, or cancelled), so there is nothing to do. Ack
            // the job instead of retrying a guaranteed no-op forever.
            Err(IngestionRunError::RunNotRunning { run_id }) => {
                debug!(run_id = run_id.as_str(), "skipped stale ingestion job");
                return Ok(());
            }
            // A transient failure (e.g. the database is momentarily
            // unavailable). Propagate so the worker retries rather than acking a
            // run whose heartbeat never landed.
            Err(err) => {
                error!(error = %err, run_id = self.run_id.as_str(), "failed to touch ingestion run");
                return Err(err);
            }
        }

        let candle_ingester = CandleIngester::new(
            Arc::clone(&services.hyperliquid),
            services.max_concurrent_requests,
        );
        let funding_ingester = FundingRateIngester::new(
            Arc::clone(&services.hyperliquid),
            services.max_concurrent_requests,
        );

        match ingest_all(&candle_ingester, &funding_ingester, &services.data_dir).await {
            Ok(last_record) => {
                complete_run(&pool, &self.run_id, last_record).await?;
                info!(run_id = self.run_id.as_str(), "ingestion complete");
            }
            Err(err) => {
                error!(error = %err, run_id = self.run_id.as_str(), "ingestion failed");
                fail_run(&pool, &self.run_id, &err.to_string()).await?;
            }
        }

        Ok(())
    }
}

#[derive(Debug, Error)]
enum IngestionPipelineError {
    #[error(transparent)]
    Markets(#[from] crate::market_metadata::MarketsMetadataError),
    #[error(transparent)]
    Hyperliquid(#[from] HyperliquidError),
}

async fn ingest_all(
    candle_ingester: &CandleIngester<dyn Hyperliquid>,
    funding_ingester: &FundingRateIngester<dyn Hyperliquid>,
    data_dir: &Path,
) -> Result<DateTime<Utc>, IngestionPipelineError> {
    let markets = load_markets(data_dir, MarketsLedger::Mainnet).await?;

    funding_ingester
        .ingest_with_markets(data_dir, &markets)
        .await?;

    for timeframe in TIMEFRAMES {
        candle_ingester
            .ingest_with_markets(*timeframe, data_dir, &markets)
            .await?;
    }

    Ok(Utc::now())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum IngestionStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl IngestionStatus {
    fn as_db_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn from_db_str(status: String) -> Result<Self, IngestionRunError> {
        match status.as_str() {
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(IngestionRunError::UnknownStatus { status }),
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum IngestionRunError {
    #[error("ingestion already running")]
    AlreadyRunning,
    #[error("ingestion run is not running: {run_id}")]
    RunNotRunning { run_id: IngestionRunId },
    #[error("unknown ingestion status: {status}")]
    UnknownStatus { status: String },
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

pub(crate) struct IngestionServices {
    pub(crate) hyperliquid: Arc<dyn Hyperliquid>,
    pub(crate) data_dir: PathBuf,
    pub(crate) max_concurrent_requests: usize,
}

pub(crate) async fn create_run(pool: &SqlitePool) -> Result<IngestionRunId, IngestionRunError> {
    let started_at = Utc::now();
    let run_id = IngestionRunId::new(started_at);
    let timestamp = started_at.to_rfc3339();

    match sqlx::query(
        r"
        INSERT INTO ingestion_runs (id, status, started_at, heartbeat_at)
        VALUES (?1, ?2, ?3, ?3)
        ",
    )
    .bind(run_id.as_str())
    .bind(IngestionStatus::Running.as_db_str())
    .bind(timestamp)
    .execute(pool)
    .await
    {
        Ok(_) => {}
        Err(sqlx::Error::Database(database_error)) if database_error.is_unique_violation() => {
            return Err(IngestionRunError::AlreadyRunning);
        }
        Err(err) => return Err(err.into()),
    }

    debug!(run_id = run_id.as_str(), "ingestion run created");
    Ok(run_id)
}

pub(crate) async fn recover_abandoned_runs(pool: &SqlitePool) -> Result<u64, IngestionRunError> {
    let timestamp = Utc::now().to_rfc3339();
    let affected_rows = sqlx::query(
        r"
        UPDATE ingestion_runs
        SET status = ?1,
            finished_at = ?2,
            heartbeat_at = ?2,
            failure_reason = ?3
        WHERE status = ?4
        ",
    )
    .bind(IngestionStatus::Failed.as_db_str())
    .bind(timestamp)
    .bind(ABANDONED_RUN_REASON)
    .bind(IngestionStatus::Running.as_db_str())
    .execute(pool)
    .await?
    .rows_affected();

    if affected_rows > 0 {
        warn!(runs = affected_rows, "abandoned ingestion runs failed");
    }

    Ok(affected_rows)
}

pub(crate) async fn latest_status(
    pool: &SqlitePool,
) -> Result<Option<IngestionStatus>, IngestionRunError> {
    sqlx::query_scalar(
        r"
        SELECT status
        FROM ingestion_runs
        ORDER BY started_at DESC
        LIMIT 1
        ",
    )
    .fetch_optional(pool)
    .await?
    .map(IngestionStatus::from_db_str)
    .transpose()
}

async fn touch_run(pool: &SqlitePool, run_id: &IngestionRunId) -> Result<(), IngestionRunError> {
    let timestamp = Utc::now().to_rfc3339();

    let affected_rows = sqlx::query(
        r"
        UPDATE ingestion_runs
        SET heartbeat_at = ?1
        WHERE id = ?2
          AND status = ?3
        ",
    )
    .bind(timestamp)
    .bind(run_id.as_str())
    .bind(IngestionStatus::Running.as_db_str())
    .execute(pool)
    .await?
    .rows_affected();

    if affected_rows == 0 {
        return Err(IngestionRunError::RunNotRunning {
            run_id: run_id.clone(),
        });
    }

    Ok(())
}

async fn complete_run(
    pool: &SqlitePool,
    run_id: &IngestionRunId,
    finished_at: DateTime<Utc>,
) -> Result<(), IngestionRunError> {
    let timestamp = finished_at.to_rfc3339();

    sqlx::query(
        r"
        UPDATE ingestion_runs
        SET status = ?1,
            finished_at = ?2,
            heartbeat_at = ?2
        WHERE id = ?3
          AND status = ?4
        ",
    )
    .bind(IngestionStatus::Completed.as_db_str())
    .bind(timestamp)
    .bind(run_id.as_str())
    .bind(IngestionStatus::Running.as_db_str())
    .execute(pool)
    .await?;

    debug!(run_id = run_id.as_str(), "ingestion run completed");
    Ok(())
}

pub(crate) async fn fail_run(
    pool: &SqlitePool,
    run_id: &IngestionRunId,
    reason: &str,
) -> Result<(), IngestionRunError> {
    let timestamp = Utc::now().to_rfc3339();

    sqlx::query(
        r"
        UPDATE ingestion_runs
        SET status = ?1,
            finished_at = ?2,
            heartbeat_at = ?2,
            failure_reason = ?3
        WHERE id = ?4
          AND status = ?5
        ",
    )
    .bind(IngestionStatus::Failed.as_db_str())
    .bind(timestamp)
    .bind(reason)
    .bind(run_id.as_str())
    .bind(IngestionStatus::Running.as_db_str())
    .execute(pool)
    .await?;

    debug!(run_id = run_id.as_str(), "ingestion run failed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use chrono::{DateTime, TimeZone, Utc};
    use polars::prelude::df;
    use rust_decimal_macros::dec;
    use sqlx::SqlitePool;
    use tempfile::TempDir;
    use tracing::Level;
    use tracing_test::traced_test;

    use super::*;
    use crate::candle::Candle;
    use crate::finance::{Market, Symbol, hyperliquid_swap_ccxt_symbol};
    use crate::funding::FundingRate;
    use crate::hyperliquid::HyperliquidError;
    use crate::logs_contain_at;
    use crate::market_metadata::MarketMetadata;
    use crate::timeframe::Timeframe;

    async fn write_test_markets_csv(data_dir: &std::path::Path) {
        let frame = df! {
            "symbol" => &["BTC"],
            "max_leverage" => &[50_u32],
            "asset_index" => &[0_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(data_dir.join(MarketsLedger::Mainnet.file_name()), frame)
            .await
            .unwrap();
    }

    struct MockHyperliquid;

    #[async_trait]
    impl Hyperliquid for MockHyperliquid {
        async fn fetch_market_metadata(&self) -> Result<Vec<MarketMetadata>, HyperliquidError> {
            Ok(vec![MarketMetadata {
                symbol: Market::new("BTC".into()),
                max_leverage: 50,
                asset_index: 0,
                only_isolated: false,
            }])
        }

        async fn fetch_candles(
            &self,
            market: &Market,
            _timeframe: Timeframe,
            _start: DateTime<Utc>,
        ) -> Result<Vec<Candle>, HyperliquidError> {
            Ok(vec![Candle {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
                open: 100.0,
                high: 105.0,
                low: 95.0,
                close: 102.0,
                volume: 1000.0,
                symbol: hyperliquid_swap_ccxt_symbol(market.as_str()).into_string(),
                ticker: Symbol::from_raw(market.as_str()),
            }])
        }

        async fn fetch_funding_rates(
            &self,
            market: &Market,
            _start: DateTime<Utc>,
        ) -> Result<Vec<FundingRate>, HyperliquidError> {
            Ok(vec![FundingRate {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
                rate: dec!(0.0001),
                symbol: Symbol::from_raw(market.as_str()),
            }])
        }
    }

    fn test_services() -> IngestionServices {
        IngestionServices {
            hyperliquid: Arc::new(MockHyperliquid),
            data_dir: std::env::temp_dir(),
            max_concurrent_requests: 10,
        }
    }

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r"
            CREATE TABLE ingestion_runs
            (
                id text NOT NULL,
                status text NOT NULL CHECK (
                    status IN ('running', 'completed', 'failed', 'cancelled')
                ),
                started_at text NOT NULL,
                finished_at text,
                heartbeat_at text NOT NULL,
                failure_reason text,
                PRIMARY KEY (id)
            );
            ",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r"
            CREATE UNIQUE INDEX one_running_ingestion
            ON ingestion_runs(status)
            WHERE status = 'running';
            ",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[traced_test]
    #[tokio::test]
    async fn create_run_stores_running_status_and_logs() {
        let pool = setup_pool().await;

        let run_id = create_run(&pool).await.unwrap();
        let status = latest_status(&pool).await.unwrap();

        assert_eq!(status, Some(IngestionStatus::Running));
        assert!(run_id.as_str().starts_with("ingestion-"));
        assert!(logs_contain_at(
            Level::DEBUG,
            &["ingestion run created", run_id.as_str()]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn create_run_rejects_concurrent_running_run() {
        let pool = setup_pool().await;

        let run_id = create_run(&pool).await.unwrap();
        assert!(logs_contain_at(
            Level::DEBUG,
            &["ingestion run created", run_id.as_str()]
        ));

        let duplicate = create_run(&pool).await;

        assert!(matches!(duplicate, Err(IngestionRunError::AlreadyRunning)));
    }

    #[traced_test]
    #[tokio::test]
    async fn recover_abandoned_runs_marks_running_rows_failed_and_logs() {
        let pool = setup_pool().await;

        create_run(&pool).await.unwrap();
        let recovered = recover_abandoned_runs(&pool).await.unwrap();
        let status = latest_status(&pool).await.unwrap();
        let failure_reason: String =
            sqlx::query_scalar("SELECT failure_reason FROM ingestion_runs LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(recovered, 1);
        assert_eq!(status, Some(IngestionStatus::Failed));
        assert_eq!(failure_reason, ABANDONED_RUN_REASON);
        assert!(logs_contain_at(
            Level::WARN,
            &["abandoned ingestion runs failed", "1"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn stale_job_for_recovered_run_acks_without_executing() {
        let pool = setup_pool().await;
        let run_id = create_run(&pool).await.unwrap();
        recover_abandoned_runs(&pool).await.unwrap();
        let job = IngestionJob::new(run_id.clone());

        let outcome = job
            .run(
                Data::new(pool.clone()),
                Data::new(Arc::new(test_services())),
            )
            .await;

        let status = latest_status(&pool).await.unwrap();

        assert!(outcome.is_ok());
        assert_eq!(status, Some(IngestionStatus::Failed));
        assert!(logs_contain_at(
            Level::DEBUG,
            &["skipped stale ingestion job", run_id.as_str()]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn transient_touch_failure_propagates_for_retry() {
        let pool = setup_pool().await;
        let run_id = create_run(&pool).await.unwrap();
        // A transient database outage: the pool is gone by the time the job
        // tries to record its heartbeat. The worker must see the error and
        // retry, not silently ack a run that never ran.
        pool.close().await;
        let job = IngestionJob::new(run_id.clone());

        let outcome = job
            .run(
                Data::new(pool.clone()),
                Data::new(Arc::new(test_services())),
            )
            .await;

        assert!(matches!(outcome, Err(IngestionRunError::Sqlx(_))));
        assert!(logs_contain_at(
            Level::ERROR,
            &["failed to touch ingestion run", run_id.as_str()]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn job_records_completed_run_and_logs() {
        let data_dir = TempDir::new().unwrap();
        write_test_markets_csv(data_dir.path()).await;
        let pool = setup_pool().await;
        let run_id = create_run(&pool).await.unwrap();
        let job = IngestionJob::new(run_id.clone());
        let services = IngestionServices {
            hyperliquid: Arc::new(MockHyperliquid),
            data_dir: data_dir.path().to_path_buf(),
            max_concurrent_requests: 10,
        };

        job.run(Data::new(pool.clone()), Data::new(Arc::new(services)))
            .await
            .unwrap();

        let status = latest_status(&pool).await.unwrap();

        assert_eq!(status, Some(IngestionStatus::Completed));
        assert!(logs_contain_at(
            Level::INFO,
            &["ingestion complete", run_id.as_str()]
        ));
    }
}
