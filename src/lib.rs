mod candle;
mod dataframe;
mod factors;
mod finance;
mod funding;
mod hyperliquid;
mod ingestion;
mod readonly_portfolio;
mod timeframe;

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use apalis::prelude::{Monitor, Storage, WorkerBuilder, WorkerFactoryFn};
use apalis_sql::sqlite::SqliteStorage;
use rocket::config::Config as RocketConfig;
use rocket::http::Status;
use rocket::request::FromParam;
use rocket::response::content::RawJson;
use rocket::response::status::Custom;
use rocket::response::{Responder, Response};
use rocket::serde::json::Json;
use rocket::{Rocket, State, get, post, routes};
use serde::Deserialize;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use thiserror::Error;
use tracing::{debug, error, info};
use tracing_subscriber::EnvFilter;

use ingestion::{IngestionJob, IngestionRunError, IngestionServices, IngestionStatus};
use timeframe::Timeframe;

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

type IngestionJobQueue = SqliteStorage<IngestionJob>;

#[get("/health")]
fn health() -> HealthJson {
    HealthJson(Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Debug, serde::Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

struct HealthJson(Json<HealthResponse>);

impl<'request> Responder<'request, 'static> for HealthJson {
    fn respond_to(
        self,
        request: &'request rocket::request::Request<'_>,
    ) -> rocket::response::Result<'static> {
        Response::build_from(self.0.respond_to(request)?)
            .raw_header("Cache-Control", "no-store")
            .ok()
    }
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

#[get("/factors/<timeframe>")]
async fn get_factors(
    config: &State<Config>,
    timeframe: Timeframe,
) -> Result<RawJson<Vec<u8>>, Status> {
    match factors::compute_factors_json(&config.data_dir, timeframe).await {
        Ok(json) => Ok(RawJson(json)),
        Err(factors::ReturnsError::NoData { .. }) => Err(Status::NotFound),
        Err(err) => {
            error!(error = %err, "failed to compute factors");
            Err(Status::InternalServerError)
        }
    }
}

#[post("/ingest")]
async fn start_ingestion(job_queue: &State<IngestionJobQueue>, pool: &State<SqlitePool>) -> Status {
    let run_id = match ingestion::create_run(pool).await {
        Ok(run_id) => run_id,
        Err(IngestionRunError::AlreadyRunning) => return Status::Conflict,
        Err(err) => {
            error!(error = %err, "failed to create ingestion run");
            return Status::InternalServerError;
        }
    };

    if let Err(err) = job_queue
        .inner()
        .clone()
        .push(IngestionJob::new(run_id.clone()))
        .await
    {
        error!(error = %err, "failed to queue ingestion job");
        if let Err(record_err) =
            ingestion::fail_run(pool, &run_id, "failed to queue ingestion job").await
        {
            error!(error = %record_err, "failed to record ingestion queue failure");
        }
        return Status::InternalServerError;
    }

    Status::Accepted
}

#[get("/ingestion/status")]
async fn get_ingestion_status(
    pool: &State<SqlitePool>,
) -> Result<Json<Option<IngestionStatus>>, Status> {
    let status = ingestion::latest_status(pool).await.map_err(|err| {
        error!(error = %err, "failed to load ingestion status");
        Status::InternalServerError
    })?;

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
    excluded_symbols: Vec<String>,
    effective_weights: std::collections::BTreeMap<String, f64>,
    data_age_hours: i64,
}

#[derive(Debug, serde::Serialize)]
struct ApiErrorResponse {
    error: String,
}

#[post("/portfolio/readonly/btc", data = "<body>")]
async fn post_portfolio_readonly_btc(
    body: Json<readonly_portfolio::ReadonlyBtcBalancesRequest>,
) -> Result<Json<readonly_portfolio::ReadonlyBtcBalancesResponse>, Custom<Json<ApiErrorResponse>>> {
    let http_client = reqwest::Client::new();
    let btc_base_url = readonly_portfolio::default_btc_base_url().map_err(|err| {
        error!(error = %err, "failed to resolve btc explorer base url");
        Custom(
            Status::InternalServerError,
            Json(ApiErrorResponse {
                error: "failed to resolve btc explorer base url".to_string(),
            }),
        )
    })?;
    let blockchain_info_base_url =
        readonly_portfolio::default_blockchain_info_base_url().map_err(|err| {
            error!(error = %err, "failed to resolve blockchain.info base url");
            Custom(
                Status::InternalServerError,
                Json(ApiErrorResponse {
                    error: "failed to resolve blockchain.info base url".to_string(),
                }),
            )
        })?;

    readonly_portfolio::load_readonly_btc_balances(
        &http_client,
        &btc_base_url,
        &blockchain_info_base_url,
        &body,
    )
    .await
    .map(Json)
    .map_err(|err| {
        error!(error = %err, "failed to load readonly btc balances");
        let status = match err {
            readonly_portfolio::ReadonlyPortfolioError::InvalidBtcAddress(_)
            | readonly_portfolio::ReadonlyPortfolioError::EmptyAddressList => Status::BadRequest,
            _ => Status::InternalServerError,
        };
        Custom(
            status,
            Json(ApiErrorResponse {
                error: err.to_string(),
            }),
        )
    })
}

#[post("/portfolio/exposure", data = "<body>")]
async fn post_portfolio_exposure(
    config: &State<Config>,
    body: Json<readonly_portfolio::PortfolioExposureRequest>,
) -> Result<Json<readonly_portfolio::PortfolioExposureResponse>, Custom<Json<ApiErrorResponse>>> {
    let http_client = reqwest::Client::new();
    let btc_base_url = readonly_portfolio::default_btc_base_url().map_err(|err| {
        error!(error = %err, "failed to resolve btc explorer base url");
        Custom(
            Status::InternalServerError,
            Json(ApiErrorResponse {
                error: "failed to resolve btc explorer base url".to_string(),
            }),
        )
    })?;
    let blockchain_info_base_url =
        readonly_portfolio::default_blockchain_info_base_url().map_err(|err| {
            error!(error = %err, "failed to resolve blockchain.info base url");
            Custom(
                Status::InternalServerError,
                Json(ApiErrorResponse {
                    error: "failed to resolve blockchain.info base url".to_string(),
                }),
            )
        })?;

    readonly_portfolio::load_portfolio_exposure(
        &http_client,
        &btc_base_url,
        &blockchain_info_base_url,
        config.hyperliquid_base_url.as_ref(),
        &body,
    )
    .await
    .map(Json)
    .map_err(|err| {
        error!(error = %err, "failed to load portfolio exposure");
        let status = match err {
            readonly_portfolio::ReadonlyPortfolioError::InvalidBtcAddress(_)
            | readonly_portfolio::ReadonlyPortfolioError::EmptyAddressList
            | readonly_portfolio::ReadonlyPortfolioError::InvalidNotional { .. } => {
                Status::BadRequest
            }
            _ => Status::InternalServerError,
        };
        Custom(
            status,
            Json(ApiErrorResponse {
                error: err.to_string(),
            }),
        )
    })
}

#[post("/beta", data = "<body>")]
async fn post_beta(
    config: &State<Config>,
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
        sorted_weights
            .sort_unstable_by(|(left_ticker, _), (right_ticker, _)| left_ticker.cmp(right_ticker));
        sorted_weights
    };

    match factors::compute_portfolio_beta_report(&config.data_dir, &weights, &body.benchmark).await
    {
        Ok(report) => Ok(Json(BetaResponse {
            beta: report.beta,
            excluded_symbols: report.excluded_tickers,
            effective_weights: report.effective_weights,
            data_age_hours: report.data_age_hours,
        })),
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

    let database_options = SqliteConnectOptions::from_str(&config.database_url)?
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePool::connect_with(database_options).await?;
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
    let apalis_tables_exist: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='Jobs')",
    )
    .fetch_one(&pool)
    .await?;

    if apalis_tables_exist == 0 {
        SqliteStorage::setup(&pool).await?;
    }
    let mut migrations = sqlx::migrate!("./migrations");
    migrations.set_ignore_missing(true).run(&pool).await?;
    debug!(count = migrations.iter().count(), "migrations applied");

    let job_queue = SqliteStorage::<IngestionJob>::new(pool.clone());
    ingestion::recover_abandoned_runs(&pool).await?;

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

    // Spawn apalis worker
    tokio::spawn({
        let pool = pool.clone();
        let services = Arc::clone(&services);
        let job_queue = job_queue.clone();
        async move {
            let monitor = Monitor::new().register(
                WorkerBuilder::new("ingestion")
                    .data(pool)
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
        .manage(pool)
        .manage(job_queue)
        .mount(
            "/",
            routes![
                health,
                get_candles,
                get_factors,
                start_ingestion,
                get_ingestion_status,
                post_beta,
                post_portfolio_readonly_btc,
                post_portfolio_exposure
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
            .mount("/", routes![health, get_candles, get_factors])
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
    fn health_returns_json_contract() {
        let rocket = rocket::build().mount("/", routes![health]);
        let client = Client::tracked(rocket).unwrap();
        let response = client.get("/health").dispatch();

        assert_eq!(response.status(), Status::Ok);
        assert_eq!(
            response.content_type(),
            Some(rocket::http::ContentType::JSON)
        );
        assert_eq!(
            response.headers().get_one("Cache-Control"),
            Some("no-store")
        );

        let body = response.into_string().unwrap();
        let payload: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(
            payload.get("status").and_then(serde_json::Value::as_str),
            Some("ok")
        );
        assert_eq!(
            payload.get("version").and_then(serde_json::Value::as_str),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn get_candles_returns_404_when_no_data() {
        let data_dir = TempDir::new().unwrap();
        let client = Client::tracked(test_rocket(data_dir.path())).unwrap();
        let response = client.get("/candles/1h").dispatch();

        assert_eq!(response.status(), Status::NotFound);
    }

    #[test]
    fn get_factors_returns_404_when_no_data() {
        let data_dir = TempDir::new().unwrap();
        let client = Client::tracked(test_rocket(data_dir.path())).unwrap();
        let response = client.get("/factors/1d").dispatch();

        assert_eq!(response.status(), Status::NotFound);
    }

    #[test]
    fn get_factors_returns_per_ticker_factor_scores_json() {
        let data_dir = TempDir::new().unwrap();
        std::fs::copy(
            std::path::Path::new("fixtures/ohlcv_1d_beta.csv"),
            data_dir.path().join("ohlcv_1d.csv"),
        )
        .unwrap();

        let client = Client::tracked(test_rocket(data_dir.path())).unwrap();
        let response = client.get("/factors/1d").dispatch();

        assert_eq!(response.status(), Status::Ok);
        let body = response.into_string().unwrap();
        let rows: Vec<serde_json::Value> =
            serde_json::from_str(&body).expect("factors body is a JSON array");
        assert!(!rows.is_empty(), "expected a row per ticker");
        assert!(
            rows.iter()
                .all(|row| row.get("annualized_volatility").is_some()),
            "every row carries annualized_volatility"
        );
        assert!(
            rows.iter().all(|row| row.get("cum_return").is_some()),
            "every row carries cum_return"
        );
        assert!(
            rows.iter().all(|row| row
                .get("sma")
                .map(|value| value.is_null() || value.as_f64().is_some())
                .unwrap_or(false)),
            "every row carries sma as a number or null"
        );
        assert!(
            rows.iter().all(|row| row
                .get("mean_return")
                .map(|value| value.is_null() || value.as_f64().is_some())
                .unwrap_or(false)),
            "every row carries mean_return as a number or null"
        );
        assert!(
            rows.iter().all(|row| row
                .get("price_zscore")
                .map(|value| value.is_null() || value.as_f64().is_some())
                .unwrap_or(false)),
            "every row carries price_zscore as a number or null"
        );
        assert!(
            rows.iter()
                .any(|row| row.get("ticker").and_then(|t| t.as_str()) == Some("BTC")),
            "BTC is present in the factor scores"
        );
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
