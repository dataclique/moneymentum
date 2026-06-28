use clap::Parser;
use moneymentum::{Config, rocket};
use std::path::PathBuf;

#[derive(Parser)]
struct Env {
    #[arg(long = "config", env)]
    config_path: String,
    #[arg(long = "markets-refresh-token-publish-path")]
    markets_refresh_token_publish_path: Option<PathBuf>,
}

#[rocket::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = Env::parse();
    let config = Config::load(
        &env.config_path,
        env.markets_refresh_token_publish_path.as_deref(),
    )?;
    rocket(config).await?.launch().await?;
    Ok(())
}
