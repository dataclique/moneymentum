use clap::Parser;
use moneymentum::{Config, rocket};

#[derive(Parser)]
struct Env {
    #[arg(long, env = "CONFIG_PATH", default_value = "config.toml")]
    config_path: String,
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,
}

#[rocket::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = Env::parse();
    let config = Config::load(&env.config_path)?;
    rocket(config)?.launch().await?;
    Ok(())
}
