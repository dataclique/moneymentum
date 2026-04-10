use clap::Parser;
use moneymentum::derive::{DeriveConfig, derive_rocket};

#[derive(Parser)]
struct Env {
    #[arg(long = "config", env, default_value = "derive.example.toml")]
    config_path: String,
}

#[rocket::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = Env::parse();
    let config = DeriveConfig::load(&env.config_path)?;
    derive_rocket(config).await?.launch().await?;
    Ok(())
}
