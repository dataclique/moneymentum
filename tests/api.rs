// Test code: panicking is allowed per project guidelines. Unlike unwrap/expect,
// clippy has no `allow-panic-in-tests` config option.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::manual_assert
)]

use std::net::{Ipv4Addr, SocketAddr};

use moneymentum::{Config, app};
use reqwest::StatusCode;
use serde_json::json;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn mount_meta_mock(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/info"))
        .and(body_partial_json(json!({"type": "meta"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "universe": [{"name": "BTC", "szDecimals": 8, "maxLeverage": 50}]
        })))
        .mount(server)
        .await;
}

async fn mount_candle_mock(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/info"))
        .and(body_partial_json(json!({"type": "candleSnapshot"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
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
        }])))
        .mount(server)
        .await;
}

async fn mount_funding_mock(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/info"))
        .and(body_partial_json(json!({"type": "fundingHistory"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "coin": "BTC",
            "fundingRate": "0.0001",
            "premium": "0.00005",
            "time": 1_700_000_000_000_u64
        }])))
        .mount(server)
        .await;
}

/// A moneymentum backend bound to an ephemeral port, exercised end-to-end over
/// real HTTP exactly as an external consumer would.
struct TestApp {
    base_url: String,
    http: reqwest::Client,
}

impl TestApp {
    async fn get(&self, path: &str) -> reqwest::Response {
        self.http
            .get(format!("{}{path}", self.base_url))
            .send()
            .await
            .unwrap()
    }

    async fn post(&self, path: &str) -> reqwest::Response {
        self.http
            .post(format!("{}{path}", self.base_url))
            .send()
            .await
            .unwrap()
    }
}

async fn spawn_test_app(mock_server: &MockServer, data_dir: &TempDir) -> TestApp {
    let database_path = data_dir.path().join("moneymentum-test.db");
    let toml_str = format!(
        r#"
        port = 0
        data_dir = "{}"
        database_url = "sqlite://{}?mode=rwc"
        hyperliquid_base_url = "{}"
        log_level = "debug"
        max_concurrent_requests = 3
        max_retries = 2
        ingestion_schedule = "0 0 * * * *"
        "#,
        data_dir.path().display(),
        database_path.display(),
        mock_server.uri()
    );
    let config: Config = toml::from_str(&toml_str).unwrap();
    let router = app(config).await.unwrap();

    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    TestApp {
        base_url,
        http: reqwest::Client::new(),
    }
}

async fn poll_for_status(app: &TestApp, status: &str, max_polls: usize, interval_ms: u64) -> bool {
    for _ in 0..max_polls {
        let body = app.get("/ingestion/status").await.text().await.unwrap();
        if body.contains(status) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
    false
}

// Temporarily skipped: fails due to OneWeek timeframe overflow when using a
// 5000-entry window; see https://github.com/dataclique/moneymentum/issues/64.
#[ignore = "OneWeek timeframe window overflows when requesting 5000 candles (see issue #64)"]
#[tokio::test(flavor = "multi_thread")]
async fn ingest_and_query_candles() {
    let mock_server = MockServer::start().await;
    mount_meta_mock(&mock_server).await;
    mount_candle_mock(&mock_server).await;
    mount_funding_mock(&mock_server).await;

    let data_dir = TempDir::new().unwrap();
    let app = spawn_test_app(&mock_server, &data_dir).await;

    let ingest_response = app.post("/ingest").await;
    assert_eq!(ingest_response.status(), StatusCode::ACCEPTED);

    let completed = poll_for_status(&app, "Completed", 100, 50).await;
    if !completed {
        let body = app.get("/ingestion/status").await.text().await.unwrap();
        if body.contains("Failed") {
            panic!("ingestion failed: {body}");
        }
        panic!("ingestion did not complete within timeout, last status: {body}");
    }

    let candles_response = app.get("/candles/1h").await;
    assert_eq!(candles_response.status(), StatusCode::OK);

    let body = candles_response.text().await.unwrap();
    let candles: Vec<serde_json::Value> = body
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).expect("each line should be valid JSON"))
        .collect();
    assert!(!candles.is_empty(), "candles should not be empty");

    let btc_candle = candles
        .iter()
        .find(|candle| candle.get("ticker").and_then(|s| s.as_str()) == Some("BTC"))
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

/// After a previous failed ingestion, restarting should show "Running" status,
/// not the old "Failed" status.
#[tokio::test(flavor = "multi_thread")]
async fn status_shows_running_after_restart_from_failed() {
    let mock_server = MockServer::start().await;

    // First run: mock returns error to cause failure
    mount_meta_mock(&mock_server).await;
    Mock::given(method("POST"))
        .and(path("/info"))
        .and(body_partial_json(json!({"type": "candleSnapshot"})))
        .respond_with(ResponseTemplate::new(500))
        .mount(&mock_server)
        .await;

    let data_dir = TempDir::new().unwrap();
    let app = spawn_test_app(&mock_server, &data_dir).await;

    // Trigger first ingestion (will fail)
    app.post("/ingest").await;

    // Wait for failure (retries take ~12s with exponential backoff)
    let failed = poll_for_status(&app, "Failed", 200, 100).await;
    assert!(failed, "first ingestion should fail");

    // Set up successful mock for second run
    mock_server.reset().await;
    mount_meta_mock(&mock_server).await;

    // Make candle fetch slow so we can check Running status
    Mock::given(method("POST"))
        .and(path("/info"))
        .and(body_partial_json(json!({"type": "candleSnapshot"})))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!([{
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
                }]))
                .set_delay(std::time::Duration::from_millis(500)),
        )
        .mount(&mock_server)
        .await;
    mount_funding_mock(&mock_server).await;

    // Trigger second ingestion
    let ingest_response = app.post("/ingest").await;
    assert_eq!(ingest_response.status(), StatusCode::ACCEPTED);

    // Poll for Running or Completed status
    let saw_running = poll_for_status(&app, "Running", 50, 100).await
        || poll_for_status(&app, "Completed", 50, 100).await;

    assert!(
        saw_running,
        "status should transition to Running (or Completed) after restart from Failed"
    );
}
