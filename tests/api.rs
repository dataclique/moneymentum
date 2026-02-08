// Test code: panicking is allowed per project guidelines. Unlike unwrap/expect,
// clippy has no `allow-panic-in-tests` config option.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::manual_assert
)]

use moneymentum::{Config, rocket};
use rocket::http::Status;
use rocket::local::asynchronous::Client;
use serde_json::json;
use sqlx::PgPool;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const DATABASE_URL: &str = env!("DATABASE_URL");

#[rocket::async_test]
async fn ingest_and_query_candles() {
    let pool = PgPool::connect(DATABASE_URL).await.unwrap();
    sqlx::query("DELETE FROM events WHERE aggregate_type = 'ingestion'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM ingestion_view")
        .execute(&pool)
        .await
        .unwrap();
    drop(pool);

    let mock_server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/info"))
        .and(body_partial_json(json!({"type": "meta"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "universe": [
                {"name": "BTC", "szDecimals": 8},
                {"name": "ETH", "szDecimals": 8}
            ]
        })))
        .mount(&mock_server)
        .await;

    Mock::given(method("POST"))
        .and(path("/info"))
        .and(body_partial_json(json!({"type": "candleSnapshot"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {
                "t": 1_700_000_000_000_u64,
                "T": 1_700_003_600_000_u64,
                "s": "BTC",
                "i": "1h",
                "o": "42000.0",
                "c": "42500.0",
                "h": "43000.0",
                "l": "41500.0",
                "v": "1000.0",
                "n": 500
            }
        ])))
        .mount(&mock_server)
        .await;

    let data_dir = TempDir::new().unwrap();
    let toml_str = format!(
        r#"
        port = 0
        data_dir = "{}"
        hyperliquid_base_url = "{}"
        log_level = "debug"
        database_url = "{DATABASE_URL}"
        "#,
        data_dir.path().display(),
        mock_server.uri()
    );
    let config: Config = toml::from_str(&toml_str).unwrap();

    let client = Client::tracked(rocket(config).await.unwrap())
        .await
        .unwrap();

    let ingest_response = client.post("/ingest").dispatch().await;
    assert_eq!(ingest_response.status(), Status::Ok);
    assert_eq!(ingest_response.into_string().await.unwrap(), r#""started""#);

    // Poll status until ingestion completes
    let mut last_body = String::new();
    let mut completed = false;
    for _ in 0..100 {
        let status_response = client.get("/ingestion/status").dispatch().await;
        last_body = status_response.into_string().await.unwrap();
        if last_body.contains("Completed") {
            completed = true;
            break;
        }
        if last_body.contains("Failed") {
            panic!("ingestion failed: {last_body}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if !completed {
        panic!("ingestion did not complete within timeout, last status: {last_body}");
    }

    let candles_response = client.get("/candles/1h").dispatch().await;
    assert_eq!(candles_response.status(), Status::Ok);

    // Response is newline-delimited JSON (NDJSON) from polars JsonWriter
    let body = candles_response.into_string().await.unwrap();
    let candles: Vec<serde_json::Value> = body
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).expect("each line should be valid JSON"))
        .collect();
    assert!(!candles.is_empty(), "candles should not be empty");

    let btc_candle = candles
        .iter()
        .find(|candle| candle.get("symbol").and_then(|s| s.as_str()) == Some("BTC"))
        .expect("should have a BTC candle");

    let open = btc_candle
        .get("open")
        .and_then(serde_json::Value::as_f64)
        .expect("should have open field");
    assert!(
        (open - 42000.0).abs() < 0.01,
        "open price should be 42000, got {open}"
    );
}
