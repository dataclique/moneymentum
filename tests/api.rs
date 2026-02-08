#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use moneymentum::{Config, rocket};
use rocket::http::Status;
use rocket::local::asynchronous::Client;
use serde_json::json;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[rocket::async_test]
async fn ingest_and_query_candles() {
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
        database_url = "postgres://localhost:5432/moneymentum?sslmode=disable"
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
    assert_eq!(ingest_response.into_string().await.unwrap(), "started");

    // Poll status until ingestion completes
    for _ in 0..100 {
        let status_response = client.get("/ingestion/status").dispatch().await;
        let body = status_response.into_string().await.unwrap();
        if body.contains("Completed") {
            break;
        }
        if body.contains("Failed") {
            panic!("ingestion failed: {body}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let candles_response = client.get("/candles/1h").dispatch().await;
    assert_eq!(candles_response.status(), Status::Ok);

    let body = candles_response.into_string().await.unwrap();
    assert!(body.contains("BTC"));
    assert!(body.contains("42000"));
}
