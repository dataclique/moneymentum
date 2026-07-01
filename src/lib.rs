mod candle;
mod dataframe;
pub mod derive;
mod factors;
mod finance;
mod funding;
mod hyperliquid;
mod ingestion;
mod market_metadata;
mod readonly_portfolio;
mod screener;
mod timeframe;

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use apalis::prelude::{Monitor, TaskSink, WorkerBuilder};
use apalis_sqlite::SqliteStorage;
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

use crate::hyperliquid::HyperliquidClients;
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
    hyperliquid_testnet_base_url: Option<url::Url>,
    log_level: LogLevel,
    max_concurrent_requests: usize,
    max_retries: usize,
    pub derive: Option<derive::DeriveConfig>,
}

impl Config {
    /// Load configuration from a TOML file on disk.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError::Io`] if the file cannot be read or
    /// [`ConfigError::Toml`] if the contents are not valid TOML.
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
    #[error("the [derive] config section is required to run the derive server")]
    MissingDeriveConfig,
}

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

#[post("/screener/<timeframe>", data = "<body>")]
async fn post_screener(
    config: &State<Config>,
    timeframe: Timeframe,
    body: Json<screener::ScreenerRequest>,
) -> Result<RawJson<Vec<u8>>, Status> {
    match screener::screen(&config.data_dir, timeframe, &body).await {
        Ok(json) => Ok(RawJson(json)),
        Err(screener::ScreenerError::Factors(factors::ReturnsError::NoData { .. })) => {
            Err(Status::NotFound)
        }
        Err(err) => {
            error!(error = %err, "failed to screen perps");
            Err(Status::InternalServerError)
        }
    }
}

struct MarketsJson(Json<market_metadata::MarketsApiResponse>);

/// Seconds until the next UTC midnight, for `Cache-Control: max-age`.
///
/// Markets refresh on a daily midnight schedule; bounding shared-cache TTL to
/// the next midnight keeps GET responses from outliving the ledger refresh.
fn markets_cache_max_age_seconds(unix_now: u64) -> u64 {
    const SECONDS_PER_DAY: u64 = 86_400;
    let seconds_into_day = unix_now % SECONDS_PER_DAY;
    (SECONDS_PER_DAY - seconds_into_day).max(1)
}

impl<'request> Responder<'request, 'static> for MarketsJson {
    fn respond_to(
        self,
        request: &'request rocket::request::Request<'_>,
    ) -> rocket::response::Result<'static> {
        let max_age = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(86_400, |duration| {
                markets_cache_max_age_seconds(duration.as_secs())
            });
        Response::build_from(self.0.respond_to(request)?)
            .raw_header(
                "Cache-Control",
                format!("private, max-age={max_age}, must-revalidate"),
            )
            .ok()
    }
}

fn markets_ledger_from_query(
    network: Option<&str>,
) -> Result<market_metadata::MarketsLedger, Status> {
    network.map_or(Ok(market_metadata::MarketsLedger::Mainnet), |value| {
        market_metadata::MarketsLedger::parse_query(value).ok_or(Status::BadRequest)
    })
}

#[get("/hyperliquid/markets?<network>")]
async fn get_hyperliquid_markets(
    network: Option<&str>,
    markets_store: &State<Arc<market_metadata::MarketsStore>>,
) -> Result<MarketsJson, Status> {
    let ledger = markets_ledger_from_query(network)?;
    markets_store
        .api_response(ledger)
        .await
        .map_or(Err(Status::ServiceUnavailable), |response| {
            Ok(MarketsJson(Json(response)))
        })
}

#[post("/ingest")]
async fn start_ingestion(
    pool: &State<SqlitePool>,
    apalis_pool: &State<apalis_sqlite::SqlitePool>,
) -> Status {
    let run_id = match ingestion::create_run(pool).await {
        Ok(run_id) => run_id,
        Err(IngestionRunError::AlreadyRunning) => return Status::Conflict,
        Err(err) => {
            error!(error = %err, "failed to create ingestion run");
            return Status::InternalServerError;
        }
    };

    let mut job_queue = SqliteStorage::<IngestionJob, (), ()>::new(apalis_pool.inner());
    if let Err(err) = job_queue.push(IngestionJob::new(run_id.clone())).await {
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

    ensure_shared_database(&config.database_url)?;

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

    // We own the apalis `Jobs`/`Workers` tables as consumer migrations rather
    // than calling apalis-sqlite's own migrator, which would compete with ours
    // over the shared `_sqlx_migrations` table. `ignore_missing` tolerates the
    // apalis-sql 0.7 migration records left in databases provisioned before the
    // upgrade, so those rows do not fail the migrator.
    let mut migrations = sqlx::migrate!("./migrations");
    migrations.set_ignore_missing(true).run(&pool).await?;
    debug!(count = migrations.iter().count(), "migrations applied");

    ingestion::recover_abandoned_runs(&pool).await?;

    // apalis-sqlite is built against sqlx 0.8, so its storage needs its own
    // pool distinct from the sqlx 0.9 `pool` the event store and ledger use.
    // Both address the same SQLite file; WAL is already enabled on it by the
    // pool above, and `busy_timeout` lets the two writers wait out the single
    // writer lock instead of failing with "database is locked".
    let apalis_options = apalis_sqlite::SqliteConnectOptions::from_str(&config.database_url)?
        .busy_timeout(std::time::Duration::from_secs(5));
    let apalis_pool = apalis_sqlite::SqlitePool::connect_with(apalis_options).await?;
    debug!("apalis storage pool connected");

    let hyperliquid_clients = HyperliquidClients::from_config(
        config.hyperliquid_base_url.as_ref(),
        config.hyperliquid_testnet_base_url.as_ref(),
        config.max_retries,
    )
    .await?;
    let markets_store = market_metadata::MarketsStore::load_from_disk(&config.data_dir).await;
    market_metadata::refresh_startup_markets(
        &hyperliquid_clients,
        &config.data_dir,
        &markets_store,
    )
    .await?;
    market_metadata::spawn_nightly_refresh(
        hyperliquid_clients.clone(),
        config.data_dir.clone(),
        Arc::clone(&markets_store),
    );
    let services = Arc::new(IngestionServices {
        hyperliquid: Arc::clone(&hyperliquid_clients.mainnet),
        data_dir: config.data_dir.clone(),
        max_concurrent_requests: config.max_concurrent_requests,
    });

    // Spawn apalis worker
    tokio::spawn({
        let pool = pool.clone();
        let apalis_pool = apalis_pool.clone();
        let services = Arc::clone(&services);
        async move {
            let monitor = Monitor::new().register(move |_worker_index| {
                WorkerBuilder::new("ingestion")
                    .backend(SqliteStorage::<IngestionJob, (), ()>::new(&apalis_pool))
                    .data(pool.clone())
                    .data(services.clone())
                    .build(IngestionJob::run)
            });
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
        .manage(apalis_pool)
        .manage(hyperliquid_clients)
        .manage(markets_store)
        .mount(
            "/",
            routes![
                health,
                get_candles,
                get_factors,
                post_screener,
                start_ingestion,
                get_ingestion_status,
                post_beta,
                post_portfolio_readonly_btc,
                post_portfolio_exposure,
                get_hyperliquid_markets,
            ],
        ))
}

/// The event store and the apalis worker each open their own pool against
/// `database_url` (sqlx 0.9 and sqlx 0.8 respectively, which cannot share a
/// pool). An in-memory SQLite URL gives each pool a *private* database, so the
/// worker never sees the migrated tables -- the queue silently breaks. Only a
/// file-backed database keeps the two pools pointed at the same data.
#[derive(Debug, thiserror::Error)]
#[error(
    "in-memory SQLite database_url is unsupported: the event store and the apalis worker open separate pools, and an in-memory URL gives each its own private database; use a file-backed database_url"
)]
struct InMemoryDatabaseUnsupported;

fn ensure_shared_database(database_url: &str) -> Result<(), InMemoryDatabaseUnsupported> {
    let normalized = database_url.to_ascii_lowercase();
    if normalized.contains(":memory:") || normalized.contains("mode=memory") {
        return Err(InMemoryDatabaseUnsupported);
    }
    Ok(())
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
    use tracing_test::traced_test;

    fn test_rocket(data_dir: &std::path::Path) -> rocket::Rocket<rocket::Build> {
        let config = Config {
            port: 0,
            data_dir: data_dir.to_path_buf(),
            database_url: "sqlite::memory:".to_string(),
            hyperliquid_base_url: None,
            hyperliquid_testnet_base_url: None,
            log_level: LogLevel::Info,
            max_concurrent_requests: 3,
            max_retries: 5,
            derive: None,
        };
        rocket::build().manage(config).mount(
            "/",
            routes![health, get_candles, get_factors, post_screener],
        )
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
    fn markets_ledger_from_query_defaults_to_mainnet_when_absent() {
        assert_eq!(
            markets_ledger_from_query(None).unwrap(),
            market_metadata::MarketsLedger::Mainnet
        );
    }

    #[test]
    fn markets_ledger_from_query_parses_known_network_values() {
        assert_eq!(
            markets_ledger_from_query(Some("mainnet")).unwrap(),
            market_metadata::MarketsLedger::Mainnet
        );
        assert_eq!(
            markets_ledger_from_query(Some("testnet")).unwrap(),
            market_metadata::MarketsLedger::Testnet
        );
    }

    #[test]
    fn markets_ledger_from_query_rejects_unknown_network_values() {
        assert_eq!(
            markets_ledger_from_query(Some("banana")),
            Err(Status::BadRequest)
        );
        assert_eq!(markets_ledger_from_query(Some("")), Err(Status::BadRequest));
    }

    #[test]
    fn markets_cache_max_age_seconds_reaches_next_utc_midnight() {
        const SECONDS_PER_DAY: u64 = 86_400;
        let noon_utc = 12 * 60 * 60;
        assert_eq!(markets_cache_max_age_seconds(noon_utc), 12 * 60 * 60);
        assert_eq!(markets_cache_max_age_seconds(SECONDS_PER_DAY - 1), 1);
        assert_eq!(markets_cache_max_age_seconds(0), SECONDS_PER_DAY);
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

    #[traced_test]
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
                .is_some_and(|value| value.is_null() || value.as_f64().is_some())),
            "every row carries sma as a number or null"
        );
        assert!(
            rows.iter().all(|row| row
                .get("mean_return")
                .is_some_and(|value| value.is_null() || value.as_f64().is_some())),
            "every row carries mean_return as a number or null"
        );
        assert!(
            rows.iter().all(|row| row
                .get("price_zscore")
                .is_some_and(|value| value.is_null() || value.as_f64().is_some())),
            "every row carries price_zscore as a number or null"
        );
        assert!(
            rows.iter().all(|row| row
                .get("annualized_return")
                .and_then(serde_json::Value::as_f64)
                .is_some()),
            "every row carries annualized_return as a number (the fixture's closes are clean)"
        );
        assert!(
            rows.iter().all(|row| row
                .get("sharpe")
                .and_then(serde_json::Value::as_f64)
                .is_some()),
            "every row carries sharpe as a number (the fixture's closes all vary)"
        );
        assert!(
            rows.iter().all(|row| row
                .get("sortino")
                .and_then(serde_json::Value::as_f64)
                .is_some()),
            "every row carries sortino as a number (every fixture ticker has downside)"
        );
        assert!(
            rows.iter().all(|row| row
                .get("autocorrelation")
                .and_then(serde_json::Value::as_f64)
                .is_some()),
            "every row carries autocorrelation as a number (the fixture's returns all vary)"
        );
        assert!(
            rows.iter().all(|row| row
                .get("information_discreteness")
                .and_then(serde_json::Value::as_f64)
                .is_some()),
            "every row carries information_discreteness as a number (the fixture's returns all vary)"
        );
        // The fixture ships no funding data, so carry is legitimately null --
        // but the key itself must stay in the schema for every row.
        assert!(
            rows.iter()
                .all(|row| row.get("carry").is_some_and(serde_json::Value::is_null)),
            "carry key is present and null for every row without funding data"
        );

        assert!(
            rows.iter().all(|row| row
                .get("beta")
                .and_then(serde_json::Value::as_f64)
                .is_some()),
            "every row carries beta as a number (prices vary and BTC is the benchmark)"
        );
        assert!(
            rows.iter().all(|row| row
                .get("volume_24h")
                .and_then(serde_json::Value::as_f64)
                .is_some()),
            "every row carries volume_24h as a number (every fixture ticker has current candles)"
        );
        assert_btc_factor_values_are_real(&rows);

        assert!(logs_contain_at(
            tracing::Level::DEBUG,
            &["factors computed"]
        ));
    }

    /// Key presence alone would pass if every factor serialized as null; pin
    /// BTC's values so a serialization regression fails the factors route test.
    fn assert_btc_factor_values_are_real(rows: &[serde_json::Value]) {
        let btc_row = rows
            .iter()
            .find(|row| row.get("ticker").and_then(|ticker| ticker.as_str()) == Some("BTC"))
            .expect("BTC is present in the factor scores");

        let btc_volatility = btc_row["annualized_volatility"]
            .as_f64()
            .expect("BTC annualized_volatility is a number");
        assert!(
            btc_volatility > 0.0,
            "BTC annualized_volatility must be positive, got {btc_volatility}"
        );
        for factor_key in [
            "cum_return",
            "sma",
            "mean_return",
            "price_zscore",
            "annualized_return",
            "sharpe",
            "sortino",
            "autocorrelation",
            "information_discreteness",
            "beta",
            "volume_24h",
        ] {
            let value = btc_row[factor_key].as_f64();
            assert!(
                value.is_some_and(f64::is_finite),
                "BTC {factor_key} must be a finite number, got {value:?}"
            );
        }

        // Pin the unit conversion: the fixture's latest BTC candle is 1400
        // base units against a ~$46.7k close, so notional must be tens of
        // millions -- a raw base-unit sum (~1400) fails this by four orders
        // of magnitude.
        let btc_volume = btc_row["volume_24h"]
            .as_f64()
            .expect("BTC volume_24h is a number");
        assert!(
            btc_volume > 1e6,
            "volume_24h must be quote notional, not base units, got {btc_volume}"
        );
        // No funding fixture is staged, so carry serializes as null - the
        // documented no-funding-data behavior.
        assert!(
            btc_row["carry"].is_null(),
            "carry must be null without funding data, got {:?}",
            btc_row["carry"]
        );
    }

    #[test]
    fn post_screener_returns_404_when_no_data() {
        let data_dir = TempDir::new().unwrap();
        let client = Client::tracked(test_rocket(data_dir.path())).unwrap();
        let response = client
            .post("/screener/1d")
            .header(rocket::http::ContentType::JSON)
            .body(r#"{"factor":"sharpe"}"#)
            .dispatch();

        assert_eq!(response.status(), Status::NotFound);
    }

    #[test]
    fn post_screener_returns_ranked_rows_with_missing_flags() {
        let data_dir = TempDir::new().unwrap();
        std::fs::copy(
            std::path::Path::new("fixtures/ohlcv_1d_beta.csv"),
            data_dir.path().join("ohlcv_1d.csv"),
        )
        .unwrap();

        let client = Client::tracked(test_rocket(data_dir.path())).unwrap();
        let response = client
            .post("/screener/1d")
            .header(rocket::http::ContentType::JSON)
            .body(r#"{"factor":"sharpe"}"#)
            .dispatch();

        assert_eq!(response.status(), Status::Ok);
        let body = response.into_string().unwrap();
        let rows: Vec<serde_json::Value> =
            serde_json::from_str(&body).expect("screener body is a JSON array");
        assert!(!rows.is_empty(), "expected ranked rows");
        assert!(
            rows.iter().all(|row| row.get("missing").is_some()),
            "every ranked row carries a missing flag"
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

    #[test]
    fn ensure_shared_database_rejects_in_memory_urls() {
        for url in [
            "sqlite::memory:",
            "sqlite://:memory:",
            ":memory:",
            "sqlite:file:store.db?mode=memory&cache=shared",
        ] {
            assert!(
                ensure_shared_database(url).is_err(),
                "expected {url} to be rejected as in-memory"
            );
        }
    }

    #[test]
    fn ensure_shared_database_accepts_file_backed_urls() {
        assert!(ensure_shared_database("sqlite:./moneymentum.db?mode=rwc").is_ok());
        assert!(ensure_shared_database("sqlite://data/moneymentum.db").is_ok());
    }

    #[tokio::test]
    async fn reconcile_migration_preserves_existing_snapshots() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        // Stand up the pre-reconcile event store (snapshots without the
        // `snapshot_version` column) and seed a snapshot from the cqrs-es era.
        sqlx::raw_sql(include_str!(
            "../migrations/20260208011202_cqrs_event_store.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r"
            INSERT INTO snapshots
                (aggregate_type, aggregate_id, last_sequence, payload, timestamp)
            VALUES ('Portfolio', 'portfolio-1', 7, '{}', '2026-01-01T00:00:00Z')
            ",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::raw_sql(include_str!(
            "../migrations/20260618052212_reconcile_event_store_for_event_sorcery.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();

        let (last_sequence, snapshot_version): (i64, i64) = sqlx::query_as(
            r"
            SELECT last_sequence, snapshot_version
            FROM snapshots
            WHERE aggregate_id = 'portfolio-1'
            ",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(last_sequence, 7);
        assert_eq!(snapshot_version, 0);
    }
}
