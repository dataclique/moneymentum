mod ingestion;

use std::net::Ipv4Addr;
use std::path::PathBuf;

use ingestion::Timeframe;
use rocket::config::Config as RocketConfig;
use rocket::http::Status;
use rocket::request::FromParam;
use rocket::response::content::RawJson;
use rocket::{State, get, post, routes};
use serde::Deserialize;
use thiserror::Error;
use url::Url;

impl<'r> FromParam<'r> for Timeframe {
    type Error = &'r str;

    fn from_param(param: &'r str) -> Result<Self, Self::Error> {
        Self::from_interval_string(param).ok_or(param)
    }
}

#[derive(Debug, Deserialize)]
pub struct Config {
    port: u16,
    data_dir: PathBuf,
    hyperliquid_base_url: Option<Url>,
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

#[get("/health")]
fn health() -> &'static str {
    "ok"
}

#[get("/candles/<timeframe>")]
fn get_candles(config: &State<Config>, timeframe: Timeframe) -> Result<RawJson<Vec<u8>>, Status> {
    ingestion::read_candles_json(&config.data_dir, timeframe)
        .map_err(|err| {
            tracing::error!(error = %err, "failed to read candles");
            Status::InternalServerError
        })?
        .map(RawJson)
        .ok_or(Status::NotFound)
}

#[post("/ingest/candles")]
async fn ingest_candles(config: &State<Config>) -> Result<&'static str, Status> {
    ingestion::ingest_all_candles(&config.data_dir, config.hyperliquid_base_url.as_ref())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "ingestion failed");
            Status::InternalServerError
        })?;
    Ok("ok")
}

pub fn rocket(
    config: Config,
) -> Result<rocket::Rocket<rocket::Build>, Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt::try_init()?;

    let rocket_config = RocketConfig {
        port: config.port,
        address: Ipv4Addr::UNSPECIFIED.into(),
        ..RocketConfig::default()
    };

    Ok(rocket::custom(rocket_config)
        .manage(config)
        .mount("/", routes![health, get_candles, ingest_candles]))
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
            hyperliquid_base_url: None,
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
