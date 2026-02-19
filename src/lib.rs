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

use apalis::prelude::{Monitor, Storage, WorkerBuilder, WorkerFactoryFn};
use apalis_sql::sqlite::SqliteStorage;
use cqrs_es::persist::GenericQuery;
use rocket::config::Config as RocketConfig;
use rocket::http::Status;
use rocket::request::FromParam;
use rocket::response::content::RawJson;
use rocket::serde::json::Json;
use rocket::{Rocket, State, get, post, routes};
use serde::Deserialize;
use sqlx::SqlitePool;
use thiserror::Error;
use tracing::{debug, error, info};
use tracing_subscriber::EnvFilter;

use beta::ReturnsError;
use ingestion::{Ingestion, IngestionId, IngestionJob, IngestionServices, IngestionStatus};
use timeframe::Timeframe;
use wire::{Cons, Nil, UnwiredQuery};

impl<'r> FromParam<'r> for Timeframe {
    type Error = &'r str;

    fn from_param(param: &'r str) -> Result<Self, Self::Error> {
        Self::from_interval_string(param).ok_or(param)
    }
}

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
    port: u16,
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
type IngestionJobQueue = SqliteStorage<IngestionJob>;
type QueryDeps = Cons<Ingestion, Nil>;

#[get("/health")]
fn health() -> &'static str {
    "ok"
}

#[get("/candles/<timeframe>")]
async fn get_candles(
    config: &State<Config>,
    timeframe: Timeframe,
) -> Result<RawJson<Vec<u8>>, Status> {
    candle::read_candles_json(&config.data_dir, timeframe)
        .await
        .map_err(|err| {
            error!(error = %err, "failed to read candles");
            Status::InternalServerError
        })?
        .map(RawJson)
        .ok_or(Status::NotFound)
}

#[post("/ingest")]
async fn start_ingestion(job_queue: &State<IngestionJobQueue>) -> Status {
    if let Err(err) = job_queue.inner().clone().push(IngestionJob).await {
        error!(error = %err, "failed to queue ingestion job");
        return Status::InternalServerError;
    }
    Status::Accepted
}

#[get("/ingestion/status")]
async fn get_ingestion_status(
    view: &State<IngestionView>,
) -> Result<Json<Option<IngestionStatus>>, Status> {
    let lifecycle = view.load::<IngestionId>(()).await.map_err(|err| {
        error!(error = %err, "failed to load ingestion view");
        Status::InternalServerError
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

#[post("/beta", data = "<body>")]
async fn post_beta(
    config: &State<Config>,
    services: &State<Arc<IngestionServices>>,
    job_queue: &State<IngestionJobQueue>,
    body: Json<BetaRequest>,
) -> Result<Json<BetaResponse>, Status> {
    if body.benchmark.trim().is_empty() {
        return Err(Status::BadRequest);
    }
    if body.weights.is_empty() {
        return Err(Status::BadRequest);
    }
    if body.weights.values().any(|weight| !weight.is_finite()) {
        return Err(Status::BadRequest);
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

    match beta::compute_portfolio_beta(&config.data_dir, &weights, &body.benchmark).await {
        Ok(beta) => Ok(Json(BetaResponse { beta })),
        Err(ReturnsError::NoData { path }) => {
            info!(path = %path.display(), "daily candles CSV missing, fetching from API");
            let beta = beta::fetch_daily_candles_and_compute_beta(
                services.hyperliquid.as_ref(),
                &weights,
                &body.benchmark,
            )
            .await
            .map_err(|err| {
                error!(error = %err, "API-based beta calculation failed");
                Status::InternalServerError
            })?;

            // Kick off ingestion so CSV exists for future requests
            if let Err(err) = job_queue.inner().clone().push(IngestionJob).await {
                error!(error = %err, "failed to queue ingestion after beta fallback");
            }

            Ok(Json(BetaResponse { beta }))
        }
        Err(err) => {
            error!(error = %err, "beta calculation failed");
            Err(Status::InternalServerError)
        }
    }
}

/// Build and configure the Rocket HTTP server for the moneymentum backend.
///
/// # Errors
///
/// Returns an error if the database connection, migrations, Hyperliquid client,
/// or Rocket initialization fail.
pub async fn rocket(
    config: Config,
) -> Result<Rocket<rocket::Build>, Box<dyn std::error::Error + Send + Sync>> {
    let filter = EnvFilter::new(format!("moneymentum={}", config.log_level.as_str()));
    // Ignore error if subscriber already set (e.g., multiple tests running)
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();

    let rocket_config = RocketConfig {
        port: config.port,
        address: Ipv4Addr::UNSPECIFIED.into(),
        ..RocketConfig::default()
    };

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
    let apalis_tables_exist: bool = sqlx::query_scalar!(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='Jobs')"
    )
    .fetch_one(&pool)
    .await?
        != 0;

    if !apalis_tables_exist {
        SqliteStorage::setup(&pool).await?;
    }
    sqlx::migrate!().set_ignore_missing(true).run(&pool).await?;
    debug!("migrations applied");

    let job_queue = SqliteStorage::<IngestionJob>::new(pool.clone());

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
            let monitor = Monitor::new().register(
                WorkerBuilder::new("ingestion")
                    .data(cqrs)
                    .data(services)
                    .backend(job_queue)
                    .build_fn(IngestionJob::run),
            );
            if let Err(err) = monitor.run().await {
                error!(error = %err, "ingestion monitor crashed");
            }
        }
    });
    debug!("ingestion worker started");

    info!(port = config.port, "moneymentum ready");
    Ok(rocket::custom(rocket_config)
        .manage(config)
        .manage(services)
        .manage(cqrs)
        .manage(view)
        .manage(job_queue)
        .mount(
            "/",
            routes![
                health,
                get_candles,
                start_ingestion,
                get_ingestion_status,
                post_beta
            ],
        ))
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
    use proptest::prelude::*;
    use rocket::local::blocking::Client;
    use tempfile::TempDir;

    fn test_rocket(data_dir: &std::path::Path) -> rocket::Rocket<rocket::Build> {
        let config = Config {
            port: 0,
            data_dir: data_dir.to_path_buf(),
            database_url: "sqlite::memory:".to_string(),
            hyperliquid_base_url: None,
            log_level: LogLevel::Info,
            max_concurrent_requests: 3,
            max_retries: 5,
        };
        rocket::build()
            .manage(config)
            .mount("/", routes![health, get_candles])
    }

    proptest! {
        #[test]
        fn port_round_trips_through_toml(port in 1u16..=65535u16) {
            let toml = format!(r#"
                port = {port}
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
        assert_eq!(config.data_dir, PathBuf::from("data"));
    }

    #[test]
    fn config_load_returns_error_for_missing_file() {
        let result = Config::load("/nonexistent/path.toml");
        assert!(matches!(result, Err(ConfigError::Io(_))));
    }

    #[test]
    fn health_returns_ok() {
        let rocket = rocket::build().mount("/", routes![health]);
        let client = Client::tracked(rocket).unwrap();
        let response = client.get("/health").dispatch();

        assert_eq!(response.status(), Status::Ok);
        assert_eq!(response.into_string(), Some("ok".to_owned()));
    }

    #[test]
    fn get_candles_returns_404_when_no_data() {
        let data_dir = TempDir::new().unwrap();
        let client = Client::tracked(test_rocket(data_dir.path())).unwrap();
        let response = client.get("/candles/1h").dispatch();

        assert_eq!(response.status(), Status::NotFound);
    }

    #[test]
    fn get_candles_returns_422_for_invalid_timeframe() {
        let data_dir = TempDir::new().unwrap();
        let client = Client::tracked(test_rocket(data_dir.path())).unwrap();
        let response = client.get("/candles/invalid").dispatch();

        assert_eq!(response.status(), Status::UnprocessableEntity);
    }

    #[test]
    fn get_candles_returns_written_csv_as_json() {
        let data_dir = TempDir::new().unwrap();

        // Write a CSV file in the expected format
        let csv_content = "timestamp,open,high,low,close,volume,symbol\n\
                           1700000000000,42000.0,43000.0,41500.0,42500.0,1000.0,BTC\n\
                           1700000000000,2000.0,2100.0,1900.0,2050.0,500.0,ETH\n";
        std::fs::write(data_dir.path().join("ohlcv_1h.csv"), csv_content).unwrap();

        let client = Client::tracked(test_rocket(data_dir.path())).unwrap();
        let response = client.get("/candles/1h").dispatch();

        assert_eq!(response.status(), Status::Ok);

        let body = response.into_string().unwrap();
        let candles: Vec<serde_json::Value> = body
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
