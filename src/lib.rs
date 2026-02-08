mod ingestion;
mod ingestion_aggregate;
mod lifecycle;
mod wire;

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;

use cqrs_es::persist::GenericQuery;
use rocket::config::Config as RocketConfig;
use rocket::http::Status;
use rocket::request::FromParam;
use rocket::response::content::RawJson;
use rocket::serde::json::Json;
use rocket::{Rocket, State, get, post, routes};
use serde::Deserialize;
use sqlx::PgPool;
use thiserror::Error;
use tracing::{error, warn};
use tracing_subscriber::EnvFilter;
use url::Url;

use ingestion::Timeframe;
use ingestion_aggregate::{
    Ingestion, IngestionCommand, IngestionId, IngestionServices, IngestionStatus,
};
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
    database_url: Url,
    hyperliquid_base_url: Option<Url>,
    log_level: LogLevel,
}

impl Config {
    pub fn load(path: &str) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path)?;
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

#[get("/health")]
fn health() -> &'static str {
    "ok"
}

#[get("/candles/<timeframe>")]
fn get_candles(config: &State<Config>, timeframe: Timeframe) -> Result<RawJson<Vec<u8>>, Status> {
    ingestion::read_candles_json(&config.data_dir, timeframe)
        .map_err(|err| {
            error!(error = %err, "failed to read candles");
            Status::InternalServerError
        })?
        .map(RawJson)
        .ok_or(Status::NotFound)
}

#[post("/ingest")]
async fn start_ingestion(
    config: &State<Config>,
    cqrs: &State<IngestionCqrs>,
) -> Result<&'static str, Status> {
    cqrs.execute::<IngestionId>((), IngestionCommand::Start)
        .await
        .map_err(|err| {
            warn!(error = %err, "failed to start ingestion");
            Status::Conflict
        })?;

    let data_dir = config.data_dir.clone();
    let base_url = config.hyperliquid_base_url.clone();
    let cqrs = Arc::clone(cqrs.inner());

    tokio::spawn(async move {
        let result = ingestion::ingest_all_candles(&data_dir, base_url.as_ref()).await;

        let command = match result {
            Ok(()) => IngestionCommand::Complete,
            Err(err) => IngestionCommand::Fail {
                reason: err.to_string(),
            },
        };

        if let Err(err) = cqrs.execute::<IngestionId>((), command).await {
            error!(error = %err, "failed to update ingestion status");
        }
    });

    Ok("started")
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

pub async fn rocket(
    config: Config,
) -> Result<Rocket<rocket::Build>, Box<dyn std::error::Error + Send + Sync>> {
    let filter = EnvFilter::new(format!("moneymentum={}", config.log_level.as_str()));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .try_init()?;

    let rocket_config = RocketConfig {
        port: config.port,
        address: Ipv4Addr::UNSPECIFIED.into(),
        ..RocketConfig::default()
    };

    let pool = PgPool::connect(config.database_url.as_str()).await?;
    let view: IngestionView = wire::View::new(pool.clone());
    let query = GenericQuery::new(view.repo());

    type QueryDeps = Cons<Ingestion, Nil>;
    let unwired = UnwiredQuery::<_, QueryDeps>::new(query);
    let (postgres_cqrs, (_wired, ())) = wire::CqrsBuilder::<Ingestion>::new(pool)
        .wire(unwired)
        .build(IngestionServices);

    let cqrs: IngestionCqrs = Arc::new(wire::Cqrs::new(postgres_cqrs));

    Ok(rocket::custom(rocket_config)
        .manage(config)
        .manage(cqrs)
        .manage(view)
        .mount(
            "/",
            routes![health, get_candles, start_ingestion, get_ingestion_status],
        ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use rocket::local::blocking::Client;
    use tempfile::TempDir;

    const TEST_DATABASE_URL: &str = env!("DATABASE_URL");

    fn test_rocket(data_dir: &std::path::Path) -> rocket::Rocket<rocket::Build> {
        let config = Config {
            port: 0,
            data_dir: data_dir.to_path_buf(),
            database_url: TEST_DATABASE_URL.parse().unwrap(),
            hyperliquid_base_url: None,
            log_level: LogLevel::Info,
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
                database_url = "{TEST_DATABASE_URL}"
                log_level = "info"
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
}
