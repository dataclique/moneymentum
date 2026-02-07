use clap::Parser;
use moneymentum::{Config, rocket};

#[derive(Parser)]
struct Env {
    #[arg(long = "config", env)]
    config_path: String,
    #[arg(long, env)]
    database_url: String,
}

#[rocket::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = Env::parse();
    let config = Config::load(&env.config_path)?;
    rocket(config)?.launch().await?;
    Ok(())
}
