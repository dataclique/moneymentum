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
use std::time::Duration;

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

async fn mount_successful_ingestion_mocks(server: &MockServer) {
    mount_meta_mock(server).await;
    mount_candle_mock(server).await;
    mount_funding_mock(server).await;
}

/// A moneymentum backend bound to an ephemeral port, exercised end-to-end over
/// real HTTP exactly as an external consumer would.
struct TestApp {
    base_url: String,
    http: reqwest::Client,
    server: tokio::task::JoinHandle<()>,
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

    async fn shutdown(self) {
        self.server.abort();
        let _ = self.server.await;
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
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    TestApp {
        base_url,
        http: reqwest::Client::new(),
        server,
    }
}

async fn ingestion_status_body(app: &TestApp) -> String {
    app.get("/ingestion/status").await.text().await.unwrap()
}

async fn poll_for_status(app: &TestApp, status: &str, max_polls: usize, interval_ms: u64) -> bool {
    for _ in 0..max_polls {
        if ingestion_status_body(app).await.contains(status) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread")]
async fn ingestion_status_is_idle_on_fresh_start() {
    let mock_server = MockServer::start().await;
    mount_meta_mock(&mock_server).await;

    let data_dir = TempDir::new().unwrap();
    let app = spawn_test_app(&mock_server, &data_dir).await;

    let response = app.get("/ingestion/status").await;
    assert!(response.status().is_success());

    let body = response.text().await.unwrap();
    assert_eq!(body, "null");
}

#[tokio::test(flavor = "multi_thread")]
async fn manual_ingest_endpoint_is_not_exposed() {
    let mock_server = MockServer::start().await;
    mount_meta_mock(&mock_server).await;

    let data_dir = TempDir::new().unwrap();
    let app = spawn_test_app(&mock_server, &data_dir).await;

    let response = app.post("/ingest").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn scheduled_ingestion_completes_and_candles_are_queryable() {
    let mock_server = MockServer::start().await;
    mount_successful_ingestion_mocks(&mock_server).await;

    let data_dir = TempDir::new().unwrap();
    let app = spawn_test_app(&mock_server, &data_dir).await;

    let completed = poll_for_status(&app, "Completed", 60, 200).await;
    if !completed {
        let body = ingestion_status_body(&app).await;
        if body.contains("Failed") {
            panic!("scheduled ingestion failed: {body}");
        }
        panic!("scheduled ingestion did not complete within timeout, last status: {body}");
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

/// After a failed scheduled run, the next scheduler tick must surface `Running`
/// (or `Completed`) rather than leaving the latest status stuck on `Failed`.
#[tokio::test(flavor = "multi_thread")]
async fn status_advances_after_failed_scheduled_run() {
    let mock_server = MockServer::start().await;
    mount_meta_mock(&mock_server).await;
    Mock::given(method("POST"))
        .and(path("/info"))
        .and(body_partial_json(json!({"type": "candleSnapshot"})))
        .respond_with(ResponseTemplate::new(500))
        .mount(&mock_server)
        .await;

    let data_dir = TempDir::new().unwrap();
    let app = spawn_test_app(&mock_server, &data_dir).await;

    let failed = poll_for_status(&app, "Failed", 60, 200).await;
    assert!(failed, "first scheduled ingestion should fail");

    mock_server.reset().await;
    mount_successful_ingestion_mocks(&mock_server).await;

    let advanced = poll_for_status(&app, "Running", 60, 200).await
        || poll_for_status(&app, "Completed", 60, 200).await;

    assert!(
        advanced,
        "status should advance after a failed run, last status: {}",
        ingestion_status_body(&app).await
    );
}

/// A backend restart abandons any in-flight run so schedulers can enqueue again.
#[tokio::test(flavor = "multi_thread")]
async fn restart_abandons_running_ingestion_and_scheduler_recovers() {
    let mock_server = MockServer::start().await;
    mount_meta_mock(&mock_server).await;
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
                .set_delay(Duration::from_secs(30)),
        )
        .mount(&mock_server)
        .await;
    mount_funding_mock(&mock_server).await;

    let data_dir = TempDir::new().unwrap();
    let app = spawn_test_app(&mock_server, &data_dir).await;

    let running = poll_for_status(&app, "Running", 60, 200).await;
    assert!(running, "scheduler should enqueue a run");

    app.shutdown().await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    mock_server.reset().await;
    mount_successful_ingestion_mocks(&mock_server).await;

    let restarted = spawn_test_app(&mock_server, &data_dir).await;
    let completed = poll_for_status(&restarted, "Completed", 60, 200).await;
    assert!(
        completed,
        "restarted backend should complete ingestion after abandoning the wedged run, last status: {}",
        ingestion_status_body(&restarted).await
    );
}
