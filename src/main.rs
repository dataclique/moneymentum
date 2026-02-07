use clap::Parser;
use rocket::config::Config as RocketConfig;
use serde::Deserialize;
use std::net::Ipv4Addr;
use thiserror::Error;

#[macro_use]
extern crate rocket;

#[derive(Parser)]
struct Env {
    #[arg(long, env = "CONFIG_PATH", default_value = "config.toml")]
    config_path: String,
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,
}

#[derive(Debug, Deserialize)]
struct Config {
    port: u16,
}

impl Config {
    fn load(path: &str) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path)?;
        Ok(toml::from_str(&content)?)
    }
}

#[derive(Debug, Error)]
enum ConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Toml(#[from] toml::de::Error),
}

#[get("/health")]
fn health() -> &'static str {
    "ok"
}

#[rocket::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env = Env::parse();
    let config = Config::load(&env.config_path)?;

    let rocket_config = RocketConfig {
        port: config.port,
        address: Ipv4Addr::UNSPECIFIED.into(),
        ..RocketConfig::default()
    };

    rocket::custom(rocket_config)
        .mount("/", routes![health])
        .launch()
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use rocket::http::Status;
    use rocket::local::blocking::Client;

    // Property test: port parsing is valid for any u16
    proptest! {
        #[test]
        fn port_round_trips_through_toml(port in 1u16..=65535u16) {
            let toml_str = format!("port = {port}");
            let config: Config = toml::from_str(&toml_str).unwrap();
            prop_assert_eq!(config.port, port);
        }
    }

    // Unit test: config parsing
    #[test]
    fn example_toml_is_valid() {
        let content = include_str!("../example.toml");
        let config: Config = toml::from_str(content).unwrap();

        assert_eq!(config.port, 8000);
    }

    // Unit test: config error handling
    #[test]
    fn config_load_returns_error_for_missing_file() {
        let result = Config::load("/nonexistent/path.toml");
        assert!(matches!(result, Err(ConfigError::Io(_))));
    }

    // Integration test: health endpoint
    #[test]
    fn health_returns_ok() {
        let rocket = rocket::build().mount("/", routes![health]);
        let client = Client::tracked(rocket).unwrap();
        let response = client.get("/health").dispatch();

        assert_eq!(response.status(), Status::Ok);
        assert_eq!(response.into_string(), Some("ok".to_owned()));
    }
}
