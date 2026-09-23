use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use chrono::Utc;
use derive::{DeriveConfig, derive_options_router};
use futures::StreamExt;
use reqwest::Client;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tracing_test::traced_test;
use url::Url;

struct TestServer {
    url: Url,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Venue {
    expiries: [i64; 2],
    pause_asset: AtomicBool,
    asset_entered: Notify,
    release_asset: Notify,
    catalogue_status: AtomicU16,
    ticker_status: AtomicU16,
}

struct Fixture {
    venue: Arc<Venue>,
    application: TestServer,
    _rest: TestServer,
    _websocket: TestServer,
    client: Client,
}

fn logs_contain_at(level: tracing::Level, snippets: &[&str]) -> bool {
    let buffer = tracing_test::internal::global_buf()
        .lock()
        .expect("test log buffer");
    let logs = String::from_utf8_lossy(&buffer);
    logs.lines().any(|line| {
        line.contains(level.as_str()) && snippets.iter().all(|snippet| line.contains(snippet))
    })
}

async fn serve_http(router: Router) -> TestServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("HTTP listener");
    let url = Url::parse(&format!(
        "http://{}",
        listener.local_addr().expect("HTTP address")
    ))
    .expect("HTTP URL");
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("HTTP server");
    });
    TestServer { url, task }
}

async fn instruments(
    State(venue): State<Arc<Venue>>,
    Json(request): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let asset = request["currency"].as_str().expect("currency");
    if asset == "ETH" && venue.pause_asset.load(Ordering::SeqCst) {
        venue.asset_entered.notify_one();
        venue.release_asset.notified().await;
    }
    let status = if asset == "ETH" {
        StatusCode::from_u16(venue.catalogue_status.load(Ordering::SeqCst)).expect("fixture status")
    } else {
        StatusCode::OK
    };
    (
        status,
        Json(
            json!({"result": venue.expiries.iter().enumerate().map(|(index, expiry)| json!({
        "instrument_name": format!("{asset}-{index}-C"), "is_active": true,
        "option_details": {"option_type": "C", "strike": "65000", "expiry": expiry}
    })).collect::<Vec<_>>()}),
        ),
    )
}

async fn tickers(
    State(venue): State<Arc<Venue>>,
    Json(request): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let asset = request["currency"].as_str().expect("currency");
    let tickers = venue.expiries.iter().enumerate().map(|(index, _)| (
        format!("{asset}-{index}-C"),
        json!({"A": "1", "B": "1", "a": "13", "b": "11", "I": "64000", "M": "12", "t": 1, "option_pricing": null}),
    )).collect::<serde_json::Map<_, _>>();
    (
        StatusCode::from_u16(venue.ticker_status.load(Ordering::SeqCst)).expect("fixture status"),
        Json(json!({"result": {"tickers": tickers}})),
    )
}

impl Fixture {
    async fn start() -> Self {
        let now = Utc::now().timestamp();
        let venue = Arc::new(Venue {
            expiries: [now + 3600, now + 7200],
            pause_asset: AtomicBool::new(false),
            asset_entered: Notify::new(),
            release_asset: Notify::new(),
            catalogue_status: AtomicU16::new(200),
            ticker_status: AtomicU16::new(200),
        });
        let rest = serve_http(
            Router::new()
                .route(
                    "/public/get_all_currencies",
                    post(|| async {
                        Json(json!({"result": [
                            {"currency": "BTC", "instrument_types": ["option"]},
                            {"currency": "ETH", "instrument_types": ["option"]}
                        ]}))
                    }),
                )
                .route("/public/get_instruments", post(instruments))
                .route("/public/get_tickers", post(tickers))
                .with_state(Arc::clone(&venue)),
        )
        .await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("WS listener");
        let ws_url = Url::parse(&format!(
            "ws://{}",
            listener.local_addr().expect("WS address")
        ))
        .expect("WS URL");
        let websocket = TestServer {
            url: ws_url.clone(),
            task: tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        accepted = listener.accept() => {
                            let (socket, _) = accepted.expect("WS accept");
                            connections.spawn(async move {
                                let mut websocket = tokio_tungstenite::accept_async(socket).await.expect("WS handshake");
                                while websocket.next().await.is_some() {}
                            });
                        }
                        Some(completed) = connections.join_next() => {
                            completed.expect("WS connection task");
                        }
                    }
                }
            }),
        };
        let application = serve_http(
            derive_options_router(DeriveConfig {
                port: 0,
                rest_base_url: rest.url.clone(),
                testnet_rest_base_url: rest.url.clone(),
                ws_url: ws_url.clone(),
                testnet_ws_url: ws_url,
            })
            .await
            .expect("options router"),
        )
        .await;
        let fixture = Self {
            venue,
            application,
            _rest: rest,
            _websocket: websocket,
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("client"),
        };
        for network in ["mainnet", "testnet"] {
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let snapshot: Value = fixture
                        .client
                        .get(
                            fixture
                                .application
                                .url
                                .join(&format!("derive/options/snapshot?network={network}"))
                                .expect("snapshot URL"),
                        )
                        .send()
                        .await
                        .expect("snapshot response")
                        .json()
                        .await
                        .expect("snapshot JSON");
                    if snapshot["quotes"][0]["mark"] == json!(12.0) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("initial quote seed deadline");
        }
        fixture
    }

    async fn snapshot(&self) -> Value {
        self.client
            .get(
                self.application
                    .url
                    .join("derive/options/snapshot?network=mainnet")
                    .expect("snapshot URL"),
            )
            .send()
            .await
            .expect("snapshot response")
            .json()
            .await
            .expect("snapshot JSON")
    }
}

#[traced_test]
#[tokio::test]
async fn asset_command_waits_until_the_new_snapshot_is_applied() {
    let fixture = Fixture::start().await;
    fixture.venue.pause_asset.store(true, Ordering::SeqCst);
    let client = fixture.client.clone();
    let url = fixture
        .application
        .url
        .join("derive/options/active_asset?network=mainnet")
        .expect("asset URL");
    let request = tokio::spawn(async move {
        client
            .post(url)
            .json(&json!({"asset": "ETH"}))
            .send()
            .await
            .expect("asset response")
    });
    tokio::time::timeout(
        Duration::from_secs(1),
        fixture.venue.asset_entered.notified(),
    )
    .await
    .expect("hub entered catalogue fetch");
    tokio::task::yield_now().await;
    let returned_before_apply = request.is_finished();
    fixture.venue.release_asset.notify_one();
    let response = request.await.expect("request task");
    assert!(
        !returned_before_apply,
        "204 must not mean only queue acceptance"
    );
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(fixture.snapshot().await["asset"], "ETH");
    assert!(logs_contain_at(
        tracing::Level::DEBUG,
        &["derive command applied", "ETH"]
    ));
}

#[traced_test]
#[tokio::test]
async fn failed_asset_catalogue_is_reported_without_changing_the_snapshot() {
    let fixture = Fixture::start().await;
    let original = fixture.snapshot().await;
    fixture.venue.catalogue_status.store(503, Ordering::SeqCst);
    let response = fixture
        .client
        .post(
            fixture
                .application
                .url
                .join("derive/options/active_asset?network=mainnet")
                .expect("asset URL"),
        )
        .json(&json!({"asset": "ETH"}))
        .send()
        .await
        .expect("asset response");
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(fixture.snapshot().await, original);
    assert!(logs_contain_at(
        tracing::Level::ERROR,
        &["derive command failed", "ETH"]
    ));
}

#[traced_test]
#[tokio::test]
async fn failed_expiry_seed_is_reported_without_changing_the_snapshot() {
    let fixture = Fixture::start().await;
    let original = fixture.snapshot().await;
    fixture.venue.ticker_status.store(503, Ordering::SeqCst);
    let response = fixture
        .client
        .post(
            fixture
                .application
                .url
                .join("derive/options/active_expiry?network=mainnet")
                .expect("expiry URL"),
        )
        .json(&json!({"expiry_unix": fixture.venue.expiries[1]}))
        .send()
        .await
        .expect("expiry response");
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(fixture.snapshot().await, original);
    assert!(logs_contain_at(
        tracing::Level::ERROR,
        &["derive command failed", "SetExpiry"]
    ));
}
