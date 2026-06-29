use clap::Parser;
use derive::derive_rocket;
use moneymentum::Config;

#[derive(Parser)]
struct Env {
    #[arg(long = "config", env)]
    config_path: String,
}

#[rocket::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = Env::parse();
    let config = Config::load(&env.config_path, None)?;
    let derive_config = config
        .derive
        .ok_or(moneymentum::ConfigError::MissingDeriveConfig)?;
    derive_rocket(derive_config).await?.launch().await?;
    Ok(())
}
