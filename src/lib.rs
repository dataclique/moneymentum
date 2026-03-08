mod beta;
mod candle;
mod dataframe;
mod finance;
mod funding;
mod hyperliquid;
mod ingestion;
mod lifecycle;
mod timeframe;
mod wire;

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use apalis::prelude::{Monitor, TaskSink, WorkerBuilder};
use apalis_board::axum::framework::{ApiBuilder, RegisterRoute};
use apalis_board::axum::ui::ServeUI;
use apalis_codec::json::JsonCodec;
use apalis_sqlite::fetcher::SqliteFetcher;
use apalis_sqlite::{CompactType, SqliteStorage};
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::{Router, routing};
use cqrs_es::persist::GenericQuery;
use serde::Deserialize;
use sqlx::SqlitePool;
use thiserror::Error;
use tokio::net::TcpListener;
use tracing::{debug, error, info};
use tracing_subscriber::EnvFilter;

use ingestion::{Ingestion, IngestionId, IngestionJob, IngestionServices, IngestionStatus};
use timeframe::Timeframe;
use wire::{Cons, Nil, UnwiredQuery};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Config {
    pub port: u16,
    board_port: u16,
    data_dir: PathBuf,
    database_url: String,
    hyperliquid_base_url: Option<url::Url>,
    log_level: LogLevel,
    max_concurrent_requests: usize,
    max_retries: usize,
}

impl Config {
    /// Load configuration from a TOML file on disk.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError::Io`] if the file cannot be read, or
    /// [`ConfigError::Toml`] if the contents are not valid TOML for [`Config`].
    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path.as_ref())?;
        Ok(toml::from_str(&content)?)
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Toml(#[from] toml::de::Error),
}

type IngestionCqrs = Arc<wire::Cqrs<Ingestion>>;
type IngestionView = wire::View<Ingestion>;
type IngestionJobQueue = SqliteStorage<IngestionJob, JsonCodec<CompactType>, SqliteFetcher>;
type QueryDeps = Cons<Ingestion, Nil>;

pub(crate) struct AppState {
    config: Config,
    view: IngestionView,
    job_queue: IngestionJobQueue,
}

async fn health() -> &'static str {
    "ok"
}

async fn get_candles(
    State(state): State<Arc<AppState>>,
    AxumPath(timeframe_str): AxumPath<String>,
) -> Result<(StatusCode, Vec<u8>), StatusCode> {
    let timeframe =
        Timeframe::from_interval_string(&timeframe_str).ok_or(StatusCode::UNPROCESSABLE_ENTITY)?;

    candle::read_candles_json(&state.config.data_dir, timeframe)
        .await
        .map_err(|err| {
            error!(error = %err, "failed to read candles");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .map(|bytes| (StatusCode::OK, bytes))
        .ok_or(StatusCode::NOT_FOUND)
}

async fn start_ingestion(State(state): State<Arc<AppState>>) -> StatusCode {
    if let Err(err) = state.job_queue.clone().push(IngestionJob).await {
        error!(error = %err, "failed to queue ingestion");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::ACCEPTED
}

async fn get_ingestion_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Option<IngestionStatus>>, StatusCode> {
    let lifecycle = state.view.load::<IngestionId>(()).await.map_err(|err| {
        error!(error = %err, "failed to load ingestion view");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let status = lifecycle
        .as_ref()
        .and_then(|lifecycle| lifecycle.live().ok())
        .map(|state| state.status);

    Ok(Json(status))
}

#[derive(Debug, Deserialize)]
struct BetaRequest {
    weights: std::collections::HashMap<String, f64>,
    benchmark: String,
}

#[derive(Debug, serde::Serialize)]
struct BetaResponse {
    beta: Option<f64>,
}

async fn post_beta(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BetaRequest>,
) -> Result<Json<BetaResponse>, StatusCode> {
    if body.benchmark.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if body.weights.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if body.weights.values().any(|weight| !weight.is_finite()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let weights: Vec<(String, f64)> = {
        let mut sorted_weights: Vec<_> = body
            .weights
            .iter()
            .map(|(ticker, weight)| (ticker.clone(), *weight))
            .collect();
        sorted_weights.sort_by(|(left_ticker, _), (right_ticker, _)| left_ticker.cmp(right_ticker));
        sorted_weights
    };

    match beta::compute_portfolio_beta(&state.config.data_dir, &weights, &body.benchmark).await {
        Ok(beta) => Ok(Json(BetaResponse { beta })),
        Err(err) => {
            error!(error = %err, "beta calculation failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// Build and configure the axum HTTP server for the moneymentum backend.
///
/// # Errors
///
/// Returns an error if the database connection, migrations, Hyperliquid client,
/// or router initialization fail.
pub async fn app(
    config: Config,
) -> Result<(Router, u16), Box<dyn std::error::Error + Send + Sync>> {
    let filter = EnvFilter::new(format!("moneymentum={}", config.log_level.as_str()));
    // Ignore error if subscriber already set (e.g., multiple tests running)
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();

    let pool = SqlitePool::connect(&config.database_url).await?;
    debug!("database connected");

    // IMPORTANT: Migration ordering matters here.
    //
    // Both apalis and our code use sqlx migrations, which share a single
    // `_sqlx_migrations` table. Each migrator validates that all previously
    // applied migrations exist in its own migration set. If we run our
    // migrations first, apalis's migrator will fail with `VersionMissing`
    // because it doesn't recognize our migrations.
    //
    // Solution: Run apalis first (if not already set up), then our migrations
    // with `ignore_missing` so we don't fail on apalis's migrations.
    let apalis_tables_exist: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='Jobs')",
    )
    .fetch_one(&pool)
    .await?;

    if !apalis_tables_exist {
        SqliteStorage::setup(&pool).await?;
    }
    sqlx::migrate!().set_ignore_missing(true).run(&pool).await?;
    debug!("migrations applied");

    let job_queue: IngestionJobQueue = SqliteStorage::new(&pool);

    let view: IngestionView = wire::View::new(pool.clone());
    let query = GenericQuery::new(view.repo());

    let hyperliquid_client = hyperliquid::HyperliquidClient::new(
        config.hyperliquid_base_url.as_ref(),
        config.max_retries,
    )
    .await?;
    let services = Arc::new(IngestionServices {
        hyperliquid: Arc::new(hyperliquid_client),
        data_dir: config.data_dir.clone(),
        max_concurrent_requests: config.max_concurrent_requests,
    });

    let unwired = UnwiredQuery::<_, QueryDeps>::new(query);
    let (cqrs, (wired, ())) = wire::CqrsBuilder::<Ingestion>::new(pool)
        .wire(unwired)
        .build(IngestionServices {
            hyperliquid: Arc::clone(&services.hyperliquid),
            data_dir: services.data_dir.clone(),
            max_concurrent_requests: services.max_concurrent_requests,
        });

    // Proves all query dependencies are satisfied at compile time
    drop(wired.into_inner());

    let cqrs: IngestionCqrs = Arc::new(cqrs);

    // Spawn apalis worker
    tokio::spawn({
        let cqrs = Arc::clone(&cqrs);
        let services = Arc::clone(&services);
        let job_queue = job_queue.clone();
        async move {
            let monitor = Monitor::new().register(move |_worker_id| {
                WorkerBuilder::new("ingestion")
                    .backend(job_queue.clone())
                    .data(cqrs.clone())
                    .data(services.clone())
                    .build(IngestionJob::run)
            });
            if let Err(err) = monitor.run().await {
                error!(error = %err, "ingestion monitor crashed");
            }
        }
    });
    debug!("ingestion worker started");

    // Spawn apalis-board dashboard
    let board_port = config.board_port;
    {
        let board_api = ApiBuilder::new(Router::new())
            .register(job_queue.clone())
            .build();
        let board_router = Router::new()
            .nest("/api/v1", board_api)
            .fallback_service(ServeUI::new());

        tokio::spawn(async move {
            let addr = (Ipv4Addr::UNSPECIFIED, board_port);
            match TcpListener::bind(addr).await {
                Ok(listener) => {
                    debug!(port = board_port, "apalis board ready");
                    if let Err(err) = axum::serve(listener, board_router).await {
                        error!(error = %err, "apalis board crashed");
                    }
                }
                Err(err) => error!(error = %err, port = board_port, "failed to bind board"),
            }
        });
    }

    let state = Arc::new(AppState {
        config,
        view,
        job_queue,
    });

    let router = Router::new()
        .route("/health", routing::get(health))
        .route("/candles/{timeframe}", routing::get(get_candles))
        .route("/ingest", routing::post(start_ingestion))
        .route("/ingestion/status", routing::get(get_ingestion_status))
        .route("/beta", routing::post(post_beta))
        .with_state(state);

    info!(port = board_port, "moneymentum ready");
    Ok((router, board_port))
}

/// Asserts that a log line at the given level contains all snippets.
///
/// Use with `tracing_test::traced_test` to verify observability.
#[cfg(test)]
pub(crate) fn logs_contain_at(level: tracing::Level, snippets: &[&str]) -> bool {
    let logs = {
        let buf = tracing_test::internal::global_buf().lock().unwrap();
        String::from_utf8_lossy(&buf).into_owned()
    };

    let level_str = match level {
        tracing::Level::TRACE => "TRACE",
        tracing::Level::DEBUG => "DEBUG",
        tracing::Level::INFO => "INFO",
        tracing::Level::WARN => "WARN",
        tracing::Level::ERROR => "ERROR",
    };

    logs.lines().any(|line| {
        line.contains(level_str) && snippets.iter().all(|snippet| line.contains(snippet))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use cqrs_es::persist::GenericQuery;
    use proptest::prelude::*;
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::candle::Candle;
    use crate::finance::Market;
    use crate::funding::FundingRate;
    use crate::hyperliquid::{Hyperliquid, HyperliquidError};
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    struct StubHyperliquid;

    #[async_trait]
    impl Hyperliquid for StubHyperliquid {
        async fn list_markets(&self) -> Result<Vec<Market>, HyperliquidError> {
            Ok(vec![])
        }

        async fn fetch_candles(
            &self,
            _market: &Market,
            _timeframe: crate::timeframe::Timeframe,
            _start: DateTime<Utc>,
        ) -> Result<Vec<Candle>, HyperliquidError> {
            Ok(vec![])
        }

        async fn fetch_funding_rates(
            &self,
            _market: &Market,
            _start: DateTime<Utc>,
        ) -> Result<Vec<FundingRate>, HyperliquidError> {
            Ok(vec![])
        }
    }

    async fn test_state(data_dir: &std::path::Path) -> Arc<AppState> {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        SqliteStorage::setup(&pool).await.unwrap();
        sqlx::migrate!()
            .set_ignore_missing(true)
            .run(&pool)
            .await
            .unwrap();
        let job_queue: IngestionJobQueue = SqliteStorage::new(&pool);
        let view: IngestionView = wire::View::new(pool.clone());
        let query = GenericQuery::new(view.repo());
        let unwired = UnwiredQuery::<_, QueryDeps>::new(query);
        let (cqrs, (wired, ())) = wire::CqrsBuilder::<Ingestion>::new(pool)
            .wire(unwired)
            .build(ingestion::IngestionServices {
                hyperliquid: Arc::new(StubHyperliquid),
                data_dir: data_dir.to_path_buf(),
                max_concurrent_requests: 1,
            });
        drop(wired.into_inner());
        let config = Config {
            port: 0,
            board_port: 0,
            data_dir: data_dir.to_path_buf(),
            database_url: "sqlite::memory:".to_string(),
            hyperliquid_base_url: None,
            log_level: LogLevel::Info,
            max_concurrent_requests: 3,
            max_retries: 5,
        };
        drop(cqrs);
        Arc::new(AppState {
            config,
            view,
            job_queue,
        })
    }

    proptest! {
        #[test]
        fn port_round_trips_through_toml(port in 1u16..=65535u16) {
            let toml = format!(r#"
                port = {port}
                board_port = 8082
                data_dir = "data"
                database_url = "sqlite::memory:"
                log_level = "info"
                max_concurrent_requests = 3
                max_retries = 5
            "#);
            let config: Config = toml::from_str(&toml).unwrap();
            prop_assert_eq!(config.port, port);
        }
    }

    #[test]
    fn example_toml_is_valid() {
        let content = include_str!("../example.toml");
        let config: Config = toml::from_str(content).unwrap();

        assert_eq!(config.port, 8000);
        assert_eq!(config.board_port, 8082);
        assert_eq!(config.data_dir, PathBuf::from("data"));
    }

    #[test]
    fn config_load_returns_error_for_missing_file() {
        let result = Config::load("/nonexistent/path.toml");
        assert!(matches!(result, Err(ConfigError::Io(_))));
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let router = Router::new().route("/health", routing::get(health));
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"ok");
    }

    #[tokio::test]
    async fn get_candles_returns_404_when_no_data() {
        let data_dir = TempDir::new().unwrap();
        let state = test_state(data_dir.path()).await;
        let router = Router::new()
            .route("/candles/{timeframe}", routing::get(get_candles))
            .with_state(state);

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/candles/1h")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn get_candles_returns_422_for_invalid_timeframe() {
        let data_dir = TempDir::new().unwrap();
        let state = test_state(data_dir.path()).await;
        let router = Router::new()
            .route("/candles/{timeframe}", routing::get(get_candles))
            .with_state(state);

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/candles/invalid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn get_candles_returns_written_csv_as_json() {
        let data_dir = TempDir::new().unwrap();

        let csv_content = "timestamp,open,high,low,close,volume,symbol\n\
                           1700000000000,42000.0,43000.0,41500.0,42500.0,1000.0,BTC\n\
                           1700000000000,2000.0,2100.0,1900.0,2050.0,500.0,ETH\n";
        std::fs::write(data_dir.path().join("ohlcv_1h.csv"), csv_content).unwrap();

        let state = test_state(data_dir.path()).await;
        let router = Router::new()
            .route("/candles/{timeframe}", routing::get(get_candles))
            .with_state(state);

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/candles/1h")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        let candles: Vec<serde_json::Value> = body_str
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).expect("each line should be valid JSON"))
            .collect();

        assert_eq!(candles.len(), 2);

        let btc_candle = candles
            .iter()
            .find(|c| c.get("symbol").and_then(|s| s.as_str()) == Some("BTC"))
            .expect("should have BTC candle");
        assert_eq!(
            btc_candle.get("open").and_then(serde_json::Value::as_f64),
            Some(42000.0)
        );

        let eth_candle = candles
            .iter()
            .find(|c| c.get("symbol").and_then(|s| s.as_str()) == Some("ETH"))
            .expect("should have ETH candle");
        assert_eq!(
            eth_candle.get("open").and_then(serde_json::Value::as_f64),
            Some(2000.0)
        );
    }
}
