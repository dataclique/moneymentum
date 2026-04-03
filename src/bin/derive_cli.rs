use moneymentum::derive::DeriveClient;
use url::Url;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let asset = "BTC".to_string();

    let base_url = "https://api.lyra.finance".to_string();

    let client = DeriveClient::new(Url::parse(&base_url)?);
    let options = client.btc_options_chain().await?;

    options.print_summary();

    Ok(())
}
