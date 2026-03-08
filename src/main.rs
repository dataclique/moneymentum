use std::net::Ipv4Addr;

use clap::Parser;
use moneymentum::{Config, app};
use tokio::net::TcpListener;

#[derive(Parser)]
struct Env {
    #[arg(long = "config", env)]
    config_path: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = Env::parse();
    let config = Config::load(&env.config_path)?;
    let port = config.port;
    let (router, _board_port) = app(config).await?;

    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
