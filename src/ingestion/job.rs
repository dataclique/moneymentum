use chrono::{DateTime, Utc};
use event_sorcery::{Job, Label, Projection, ProjectionError, SendError, Store};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::hyperliquid::{CandleIngester, FundingRateIngester, Hyperliquid};
use crate::market_catalog::MarketCatalog;
use crate::market_enablement::MarketEnablement;
use crate::market_metadata::RefreshError;
use crate::timeframe::Timeframe;

use super::orchestration::LOST_RACE_REASON;
use super::run::{
    IngestionRun, IngestionRunCommand, IngestionRunStatus, complete_run, fail_run, running_runs,
};
use super::run_id::IngestionRunId;
use super::services::IngestionServices;

#[derive(Debug, thiserror::Error)]
enum IngestionJobError {
    #[error(transparent)]
    Send(#[from] SendError<IngestionRun>),
    #[error(transparent)]
    Projection(#[from] ProjectionError<IngestionRun>),
}

const TIMEFRAMES: &[Timeframe] = &[
    Timeframe::FifteenMin,
    Timeframe::OneHour,
    Timeframe::OneDay,
    Timeframe::OneWeek,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IngestionJob {
    run_id: IngestionRunId,
}

impl IngestionJob {
    pub(crate) fn new(run_id: IngestionRunId) -> Self {
        Self { run_id }
    }
}

/// Everything the ingestion worker needs to drive a run to a terminal state:
/// the run's own event store (to load state and record completion or failure)
/// and the fetch/catalog services that do the ingestion work. Built once at
/// startup and shared as the worker's [`Job::Input`].
pub(crate) struct IngestionJobContext {
    pub(crate) run_store: Arc<Store<IngestionRun>>,
    pub(crate) run_projection: Arc<Projection<IngestionRun>>,
    pub(crate) services: IngestionServices,
}

impl Job for IngestionJob {
    type Input = IngestionJobContext;
    type Output = ();
    type Error = IngestionJobError;

    const WORKER_NAME: &'static str = "ingestion";
    const KIND: &'static str = "ingestion";

    fn label(&self) -> Label {
        Label::new(format!("ingestion:{}", self.run_id))
    }

    async fn perform(&self, context: &IngestionJobContext) -> Result<(), IngestionJobError> {
        let store = &context.run_store;
        let services = &context.services;

        // A run abandoned by startup recovery must not resurrect: skip the work
        // and leave its terminal state untouched.
        match store.load(&self.run_id).await {
            Ok(Some(run)) if run.status == IngestionRunStatus::Running => {}
            Ok(_) => {
                warn!(run_id = %self.run_id, "skipping ingestion for a finished run");
                return Ok(());
            }
            // A load failure leaves the run's state unknown -- surface it so the
            // worker retries rather than silently marking the job done.
            Err(err) => {
                error!(error = %err, run_id = %self.run_id, "failed to load ingestion run");
                return Err(err);
            }
        }

        // Both concurrent `create_run` losers and winners enqueue a job atomically
        // with `Start`. The aggregate can still read Running for a loser until its
        // `Abandon` commits, so verify this run_id is the projection's sole winner
        // before any ingestion I/O.
        let holds_slot = match holds_one_running_slot(&context.run_projection, &self.run_id).await {
            Ok(holds_slot) => holds_slot,
            Err(err) => {
                error!(
                    error = %err,
                    run_id = %self.run_id,
                    "failed to verify the one-running slot"
                );
                return Err(err.into());
            }
        };
        if !holds_slot {
            match store.load(&self.run_id).await {
                Ok(Some(run)) if run.status == IngestionRunStatus::Running => {
                    store
                        .send(
                            &self.run_id,
                            IngestionRunCommand::Abandon {
                                reason: LOST_RACE_REASON.to_string(),
                                reconciled_at: Utc::now(),
                            },
                        )
                        .await?;
                }
                Ok(_) => {}
                Err(err) => {
                    error!(
                        error = %err,
                        run_id = %self.run_id,
                        "failed to load ingestion run before abandoning race loser"
                    );
                    return Err(err);
                }
            }
            warn!(
                run_id = %self.run_id,
                "skipping ingestion for a run that lost the one-running race"
            );
            return Ok(());
        }

        let candle_ingester = CandleIngester::new(
            Arc::clone(&services.hyperliquid),
            services.max_concurrent_requests,
        );
        let funding_ingester = FundingRateIngester::new(
            Arc::clone(&services.hyperliquid),
            services.max_concurrent_requests,
        );

        match ingest_all(
            services.hyperliquid.as_ref(),
            &candle_ingester,
            &funding_ingester,
            &services.data_dir,
            &services.market_catalog,
            &services.market_catalog_projection,
            &services.market_enablement_projection,
        )
        .await
        {
            Ok(last_record) => {
                // The run stays Running until this commits; surface a
                // terminalization failure so the worker retries instead of
                // leaving the slot wedged until the next startup reconcile.
                if let Err(err) = complete_run(store, &self.run_id, last_record).await {
                    error!(error = %err, run_id = %self.run_id, "failed to record ingestion completion");
                    return Err(err);
                }
                info!(run_id = %self.run_id, "ingestion complete");
            }
            Err(err) => {
                error!(error = %err, run_id = %self.run_id, "ingestion failed");
                // If we cannot even record the failure the run stays Running;
                // surface it so the worker retries rather than wedging the slot.
                if let Err(record_err) = fail_run(store, &self.run_id, &err.to_string()).await {
                    error!(
                        error = %record_err,
                        run_id = %self.run_id,
                        "failed to record ingestion failure"
                    );
                    return Err(record_err);
                }
            }
        }

        Ok(())
    }
}

async fn ingest_all(
    client: &dyn Hyperliquid,
    candle_ingester: &CandleIngester<dyn Hyperliquid>,
    funding_ingester: &FundingRateIngester<dyn Hyperliquid>,
    data_dir: &Path,
    market_catalog: &Store<MarketCatalog>,
    market_catalog_projection: &Projection<MarketCatalog>,
    market_enablement_projection: &Projection<MarketEnablement>,
) -> Result<DateTime<Utc>, RefreshError> {
    let markets = crate::market_metadata::refresh_markets(
        client,
        market_catalog,
        market_catalog_projection,
        market_enablement_projection,
    )
    .await?;

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

async fn holds_one_running_slot(
    projection: &Projection<IngestionRun>,
    run_id: &IngestionRunId,
) -> Result<bool, ProjectionError<IngestionRun>> {
    Ok(matches!(
        running_runs(projection).await?.as_slice(),
        [(winner, _)] if winner == run_id
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use event_sorcery::Job;
    use tracing::Level;
    use tracing_test::traced_test;

    use super::IngestionJob;
    use crate::ingestion::fixtures::{
        MockHyperliquid, ingestion_store, instant, job_context, test_services,
        test_services_with_hyperliquid,
    };
    use crate::ingestion::orchestration::{create_run, latest_status, recover_abandoned_runs};
    use crate::ingestion::run::running_runs;
    use crate::ingestion::run::{IngestionRunCommand, IngestionRunStatus};
    use crate::logs_contain_at;

    #[traced_test]
    #[tokio::test]
    async fn stale_job_for_recovered_run_does_not_execute() {
        let (store, projection, pool) = ingestion_store().await;
        let run_id = create_run(&store, &projection).await.unwrap();
        recover_abandoned_runs(&store, &projection).await.unwrap();
        let job = IngestionJob::new(run_id.clone());
        let context = job_context(&store, &projection, test_services().await);

        job.perform(&context).await.unwrap();

        let status = latest_status(&pool).await.unwrap();

        assert_eq!(status, Some(IngestionRunStatus::Abandoned));
        let run_id = run_id.to_string();
        assert!(logs_contain_at(
            Level::WARN,
            &["skipping ingestion for a finished run", run_id.as_str()]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn job_completes_a_running_run_and_logs() {
        let (store, projection, pool) = ingestion_store().await;
        let run_id = create_run(&store, &projection).await.unwrap();
        let job = IngestionJob::new(run_id.clone());
        let context = job_context(&store, &projection, test_services().await);

        job.perform(&context).await.unwrap();

        let status = latest_status(&pool).await.unwrap();

        assert_eq!(status, Some(IngestionRunStatus::Completed));
        let run_id = run_id.to_string();
        assert!(logs_contain_at(
            Level::INFO,
            &["ingestion complete", run_id.as_str()]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn race_loser_job_skips_ingestion_before_winner_runs() {
        let fetch_market_metadata_calls = Arc::new(AtomicU32::new(0));
        let (store, projection, _pool) = ingestion_store().await;
        let services = test_services_with_hyperliquid(Arc::new(
            MockHyperliquid::with_call_counter(Arc::clone(&fetch_market_metadata_calls)),
        ))
        .await;
        let context = job_context(&store, &projection, services);

        // Simulate the post-Start race window: both streams committed `Start`
        // (and enqueued jobs) but the partial unique index left only one winner
        // in the projection.
        let shared_start = instant();
        let shared_micros = shared_start.timestamp_micros();
        let first_id = format!("ingestion-{shared_micros}-00000000000000000000000000000001")
            .parse()
            .unwrap();
        let second_id = format!("ingestion-{shared_micros}-00000000000000000000000000000002")
            .parse()
            .unwrap();

        store
            .send(
                &first_id,
                IngestionRunCommand::Start {
                    run_id: first_id.clone(),
                    started_at: shared_start,
                },
            )
            .await
            .unwrap();
        store
            .send(
                &second_id,
                IngestionRunCommand::Start {
                    run_id: second_id.clone(),
                    started_at: shared_start,
                },
            )
            .await
            .unwrap();

        let running = running_runs(&projection).await.unwrap();
        assert_eq!(running.len(), 1, "projection must admit exactly one winner");
        let winner_id = running[0].0.clone();
        let loser_id = if winner_id == first_id {
            second_id
        } else {
            first_id
        };

        // Run the loser's job first -- the ordering that previously duplicated work.
        IngestionJob::new(loser_id.clone())
            .perform(&context)
            .await
            .unwrap();
        IngestionJob::new(winner_id.clone())
            .perform(&context)
            .await
            .unwrap();

        assert_eq!(
            fetch_market_metadata_calls.load(Ordering::SeqCst),
            1,
            "only the projection winner may execute ingestion"
        );

        let loser = store.load(&loser_id).await.unwrap().unwrap();
        let winner = store.load(&winner_id).await.unwrap().unwrap();
        assert_eq!(loser.status, IngestionRunStatus::Abandoned);
        assert_eq!(winner.status, IngestionRunStatus::Completed);

        let loser_id = loser_id.to_string();
        assert!(logs_contain_at(
            Level::WARN,
            &[
                "skipping ingestion for a run that lost the one-running race",
                loser_id.as_str()
            ]
        ));
        let winner_id = winner_id.to_string();
        assert!(logs_contain_at(
            Level::INFO,
            &["ingestion complete", winner_id.as_str()]
        ));
    }
}
