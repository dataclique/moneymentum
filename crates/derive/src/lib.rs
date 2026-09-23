use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response, sse::Event, sse::Sse};
use axum::routing::{get, post};
use chrono::{DateTime, TimeZone, Utc};
use futures::{SinkExt, Stream, StreamExt, stream};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use tokio::sync::{RwLock, broadcast, mpsc, oneshot};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};
use url::Url;

const ATM_TOLERANCE: f64 = 0.005;
const DEFAULT_ASSET: &str = "BTC";
const OPTION_ASSET_PROBE_CONCURRENCY: usize = 8;
const TICKER_SLIM_INTERVAL_MS: &str = "100";
const SUBSCRIBE_CHANNELS_PER_MESSAGE: usize = 25;
const CATALOGUE_REFRESH_INTERVAL: Duration = Duration::from_mins(1);
const HTTP_USER_AGENT: &str = "moneymentum-derive/0.1";
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const OPTIONS_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(25);
const HUB_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

/// Commands the websocket hub consumes: switch expiry, switch underlying
/// asset (reload catalogue), or the timer-driven catalogue refresh that
/// drops expired expiries and picks up newly listed ones.
#[derive(Debug, Clone)]
enum HubCommand {
    SetExpiry(i64),
    SetAsset(String),
}

struct HubRequest {
    command: HubCommand,
    acknowledgment: oneshot::Sender<Result<(), DeriveError>>,
}

type DeriveWsWriter = futures::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

#[derive(Debug, Error)]
pub enum DeriveError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error("invalid expiry timestamp: {timestamp}")]
    InvalidExpiry { timestamp: i64 },
    #[error("api error: {message}")]
    Api { message: String },
    #[error(transparent)]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
}

#[derive(Debug, Deserialize)]
struct RpcResponse<T> {
    result: T,
}

#[derive(Debug, Deserialize)]
struct OptionDetailsDto {
    option_type: String,
    strike: String,
    expiry: u64,
}

#[derive(Debug, Deserialize)]
struct InstrumentDto {
    instrument_name: String,
    is_active: bool,
    option_details: Option<OptionDetailsDto>,
}

#[derive(Debug, Deserialize)]
struct CurrencyDto {
    currency: String,
    instrument_types: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct WsNotification {
    channel: Option<String>,
    data: Option<WsData>,
    params: Option<WsParams>,
}

#[derive(Debug, Deserialize, Clone)]
struct WsParams {
    channel: Option<String>,
    data: Option<WsData>,
}

/// Venue WS payloads are not uniform: some frames wrap the slim ticker, others
/// push the compact object as `data` itself (same shape as `public/get_tickers`).
#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
enum WsData {
    Wrapped {
        #[serde(rename = "instrument_ticker")]
        instrument_ticker: TickerSlimDto,
    },
    Slim(TickerSlimDto),
}

impl WsData {
    fn ticker(&self) -> &TickerSlimDto {
        match self {
            Self::Wrapped { instrument_ticker } => instrument_ticker,
            Self::Slim(ticker) => ticker,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GetTickersResult {
    tickers: HashMap<String, TickerSlimDto>,
}

#[derive(Debug, Deserialize, Clone)]
struct TickerSlimDto {
    // Both REST and WS define `t` as snapshot creation time in Unix milliseconds:
    // https://docs.derive.xyz/api-reference/channels/tickerslim
    // https://docs.derive.xyz/api-reference/market-data/publicget_tickers
    #[serde(rename = "t")]
    snapshot_timestamp_ms: u64,
    #[serde(rename = "A")]
    best_ask_size: String,
    #[serde(rename = "B")]
    best_bid_size: String,
    #[serde(rename = "a")]
    best_ask_price: String,
    #[serde(rename = "b")]
    best_bid_price: String,
    #[serde(rename = "I")]
    index_price: String,
    #[serde(rename = "M")]
    mark_price: String,
    option_pricing: Option<OptionPricingSlimDto>,
}

#[derive(Debug, Deserialize, Clone)]
struct OptionPricingSlimDto {
    #[serde(rename = "ai")]
    ask_iv: String,
    #[serde(rename = "bi")]
    bid_iv: String,
    #[serde(rename = "d")]
    delta: String,
    #[serde(rename = "g")]
    gamma: String,
    #[serde(rename = "v")]
    vega: String,
    #[serde(rename = "t")]
    theta: String,
    #[serde(rename = "i")]
    iv: String,
    #[serde(rename = "r")]
    rho: String,
    #[serde(rename = "f")]
    forward: String,
    #[serde(rename = "m")]
    model_mark: String,
    #[serde(rename = "df")]
    discount_factor: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeriveNetwork {
    Mainnet,
    Testnet,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeriveConfig {
    /// Bind port for the standalone `derive_cli` binary. Ignored when options
    /// routes are mounted on the main moneymentum server.
    pub port: u16,
    pub rest_base_url: Url,
    pub ws_url: Url,
    pub testnet_rest_base_url: Url,
    pub testnet_ws_url: Url,
}

#[derive(Debug, Deserialize)]
struct NetworkQuery {
    network: DeriveNetwork,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum OptionKind {
    #[serde(rename = "C")]
    Call,
    #[serde(rename = "P")]
    Put,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Moneyness {
    InTheMoney,
    AtTheMoney,
    OutOfTheMoney,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct OptionGreeks {
    pub bid_iv: Option<f64>,
    pub ask_iv: Option<f64>,
    pub delta: Option<f64>,
    pub gamma: Option<f64>,
    pub vega: Option<f64>,
    pub theta: Option<f64>,
    pub iv: Option<f64>,
    pub rho: Option<f64>,
    pub forward_price: Option<f64>,
    pub discount_factor: Option<f64>,
    pub option_model_mark: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptionQuote {
    pub instrument_name: String,
    pub kind: OptionKind,
    pub strike: f64,
    pub expiry: DateTime<Utc>,
    pub expiry_unix: i64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub bid_size: Option<f64>,
    pub ask_size: Option<f64>,
    pub mark: Option<f64>,
    pub spot_price: f64,
    pub moneyness: Moneyness,
    pub greeks: OptionGreeks,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptionsSnapshot {
    pub asset: String,
    pub updated_at: DateTime<Utc>,
    pub active_expiry_unix: Option<i64>,
    pub expiry_unixes: Vec<i64>,
    pub spot_price: f64,
    pub expiry_dates: Vec<DateTime<Utc>>,
    pub strikes: Vec<f64>,
    pub quotes: Vec<OptionQuote>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExpiryTabPayload {
    pub expiry_unix: i64,
    pub instruments: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptionsBootstrap {
    pub asset: String,
    pub assets: Vec<String>,
    pub default_expiry_unix: Option<i64>,
    pub tabs: Vec<ExpiryTabPayload>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActiveExpiryBody {
    pub expiry_unix: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActiveAssetBody {
    pub asset: String,
}

#[derive(Debug, Clone)]
struct InstrumentMeta {
    instrument_name: String,
    kind: OptionKind,
    strike: f64,
    expiry: DateTime<Utc>,
    expiry_unix: i64,
}

#[derive(Debug, Clone)]
struct QuoteState {
    snapshot_timestamp_ms: u64,
    bid: Option<f64>,
    ask: Option<f64>,
    bid_size: Option<f64>,
    ask_size: Option<f64>,
    mark: Option<f64>,
    spot: f64,
    greeks: OptionGreeks,
}

impl Default for QuoteState {
    fn default() -> Self {
        Self {
            snapshot_timestamp_ms: 0,
            bid: None,
            ask: None,
            bid_size: None,
            ask_size: None,
            mark: None,
            spot: 0.0,
            greeks: OptionGreeks::default(),
        }
    }
}

#[derive(Clone)]
struct OptionsCatalogue {
    instrument_by_name: HashMap<String, InstrumentMeta>,
    names_by_expiry_unix: HashMap<i64, Vec<String>>,
    expiry_unix_sorted_asc: Vec<i64>,
}

#[derive(Clone)]
struct SharedActiveOptions {
    asset: String,
    catalogue: OptionsCatalogue,
}

struct DeriveState {
    assets: Vec<String>,
    active: Arc<RwLock<SharedActiveOptions>>,
    snapshot: Arc<RwLock<OptionsSnapshot>>,
    tx: broadcast::Sender<OptionsSnapshot>,
    command_tx: mpsc::Sender<HubRequest>,
    hub_task: tokio::task::AbortHandle,
}

impl Drop for DeriveState {
    fn drop(&mut self) {
        self.hub_task.abort();
    }
}

/// Dual-network hubs: one websocket process per Derive deployment.
struct DeriveNetworksState {
    mainnet: Result<Arc<DeriveState>, DeriveError>,
    testnet: Result<Arc<DeriveState>, DeriveError>,
}

impl DeriveNetworksState {
    fn for_network(&self, network: DeriveNetwork) -> Result<&Arc<DeriveState>, StatusCode> {
        match network {
            DeriveNetwork::Mainnet => self.mainnet.as_ref(),
            DeriveNetwork::Testnet => self.testnet.as_ref(),
        }
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
    }
}

fn build_http_client() -> Result<Client, DeriveError> {
    Ok(Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()?)
}

fn apply_cors_headers(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type, Authorization"),
    );
}

async fn cors_middleware(request: Request<Body>, next: Next) -> Response {
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors_headers(&mut response);
        return response;
    }
    let mut response = next.run(request).await;
    apply_cors_headers(&mut response);
    response
}

async fn fetch_options_catalogue(
    http: &Client,
    rest_base_url: &Url,
    asset: &str,
) -> Result<OptionsCatalogue, DeriveError> {
    let rest_url = format!(
        "{}/public/get_instruments",
        rest_base_url.as_str().trim_end_matches('/')
    );
    let payload = json!({
        "currency": asset,
        "instrument_type": "option",
        "expired": false
    });

    let response: RpcResponse<Vec<InstrumentDto>> = http
        .post(&rest_url)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    catalogue_from_instruments(response.result, Utc::now().timestamp())
}

fn is_open_expiry(expiry_unix: i64, now_unix: i64) -> bool {
    expiry_unix > now_unix
}

fn catalogues_equivalent(left: &OptionsCatalogue, right: &OptionsCatalogue) -> bool {
    left.expiry_unix_sorted_asc == right.expiry_unix_sorted_asc
        && left.names_by_expiry_unix == right.names_by_expiry_unix
}

fn prune_closed_expiries(catalogue: &OptionsCatalogue, now_unix: i64) -> OptionsCatalogue {
    let expiry_unix_sorted_asc: Vec<i64> = catalogue
        .expiry_unix_sorted_asc
        .iter()
        .copied()
        .filter(|expiry_unix| is_open_expiry(*expiry_unix, now_unix))
        .collect();
    let open_expiries: HashSet<i64> = expiry_unix_sorted_asc.iter().copied().collect();
    let names_by_expiry_unix = expiry_unix_sorted_asc
        .iter()
        .filter_map(|expiry_unix| {
            catalogue
                .names_by_expiry_unix
                .get(expiry_unix)
                .cloned()
                .map(|names| (*expiry_unix, names))
        })
        .collect();
    let instrument_by_name = catalogue
        .instrument_by_name
        .iter()
        .filter(|(_name, meta)| open_expiries.contains(&meta.expiry_unix))
        .map(|(name, meta)| (name.clone(), meta.clone()))
        .collect();

    OptionsCatalogue {
        instrument_by_name,
        names_by_expiry_unix,
        expiry_unix_sorted_asc,
    }
}

fn catalogue_from_instruments(
    rows: Vec<InstrumentDto>,
    now_unix: i64,
) -> Result<OptionsCatalogue, DeriveError> {
    let mut by_expiry: BTreeMap<i64, Vec<InstrumentMeta>> = BTreeMap::new();
    let mut instrument_by_name: HashMap<String, InstrumentMeta> = HashMap::new();

    for row in rows {
        if !row.is_active {
            continue;
        }
        let Some(details) = row.option_details else {
            continue;
        };
        let timestamp = i64::try_from(details.expiry).map_err(|_| DeriveError::Api {
            message: "expiry value does not fit i64".to_string(),
        })?;
        if !is_open_expiry(timestamp, now_unix) {
            continue;
        }
        let expiry = Utc
            .timestamp_opt(timestamp, 0)
            .single()
            .ok_or(DeriveError::InvalidExpiry { timestamp })?;
        let strike = parse_required_number(&details.strike, "strike")?;
        let kind = match details.option_type.as_str() {
            "C" => OptionKind::Call,
            "P" => OptionKind::Put,
            other => {
                return Err(DeriveError::Api {
                    message: format!("unsupported option_type: {other}"),
                });
            }
        };
        let meta = InstrumentMeta {
            instrument_name: row.instrument_name.clone(),
            kind,
            strike,
            expiry,
            expiry_unix: timestamp,
        };
        instrument_by_name.insert(row.instrument_name.clone(), meta.clone());
        by_expiry.entry(timestamp).or_default().push(meta);
    }

    let mut names_by_expiry_unix: HashMap<i64, Vec<String>> = HashMap::new();
    let mut expiry_unix_sorted_asc: Vec<i64> = Vec::new();
    for (expiry_unix, mut metas) in by_expiry {
        expiry_unix_sorted_asc.push(expiry_unix);
        metas.sort_by(|left, right| {
            left.strike
                .partial_cmp(&right.strike)
                .unwrap_or(Ordering::Equal)
                .then_with(|| match (left.kind, right.kind) {
                    (OptionKind::Call, OptionKind::Put) => Ordering::Less,
                    (OptionKind::Put, OptionKind::Call) => Ordering::Greater,
                    _ => Ordering::Equal,
                })
        });
        let names = metas
            .into_iter()
            .map(|meta| meta.instrument_name)
            .collect::<Vec<_>>();
        names_by_expiry_unix.insert(expiry_unix, names);
    }

    Ok(OptionsCatalogue {
        instrument_by_name,
        names_by_expiry_unix,
        expiry_unix_sorted_asc,
    })
}

fn catalogue_has_active_options(catalogue: &OptionsCatalogue) -> bool {
    !catalogue.expiry_unix_sorted_asc.is_empty()
}

struct DiscoveredOptionAssets {
    assets: Vec<String>,
    default_catalogue: OptionsCatalogue,
}

/// Currencies Derive lists as option underlyings that currently have at least
/// one active expiry. Prefer [`DEFAULT_ASSET`] as the first entry when present.
/// The default asset's catalogue is returned so [`spawn_options_hub`] does not
/// fetch it again.
async fn fetch_option_assets(
    http: &Client,
    rest_base_url: &Url,
) -> Result<DiscoveredOptionAssets, DeriveError> {
    let rest_url = format!(
        "{}/public/get_all_currencies",
        rest_base_url.as_str().trim_end_matches('/')
    );
    let response: RpcResponse<Vec<CurrencyDto>> = http
        .post(&rest_url)
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let mut candidates = response
        .result
        .into_iter()
        .filter(|row| {
            row.instrument_types
                .iter()
                .any(|instrument_type| instrument_type == "option")
        })
        .map(|row| row.currency)
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.dedup();

    let probe_client = http.clone();
    let probe_base_url = rest_base_url.clone();
    let probed: Vec<(String, Result<OptionsCatalogue, DeriveError>)> = stream::iter(candidates)
        .map(|currency| {
            let http = probe_client.clone();
            let rest_base_url = probe_base_url.clone();
            async move {
                let catalogue = fetch_options_catalogue(&http, &rest_base_url, &currency).await;
                (currency, catalogue)
            }
        })
        .buffer_unordered(OPTION_ASSET_PROBE_CONCURRENCY)
        .collect()
        .await;

    let mut active = Vec::new();
    for (currency, catalogue_result) in probed {
        match catalogue_result {
            Ok(catalogue) if catalogue_has_active_options(&catalogue) => {
                active.push((currency, catalogue));
            }
            Ok(_) => {
                debug!(currency = %currency, "skipping option currency with no active expiries");
            }
            Err(error) => {
                warn!(
                    currency = %currency,
                    error = %error,
                    "skipping option currency after catalogue probe failed"
                );
            }
        }
    }

    if active.is_empty() {
        return Err(DeriveError::Api {
            message: "derive returned no option currencies with active instruments".to_string(),
        });
    }

    active.sort_by(|left, right| left.0.cmp(&right.0));
    if let Some(default_index) = active
        .iter()
        .position(|(asset, _catalogue)| asset == DEFAULT_ASSET)
    {
        active.swap(0, default_index);
    }

    let assets = active
        .iter()
        .map(|(asset, _catalogue)| asset.clone())
        .collect::<Vec<_>>();
    let default_catalogue = active
        .into_iter()
        .next()
        .map(|(_asset, catalogue)| catalogue)
        .ok_or_else(|| DeriveError::Api {
            message: "derive returned no option currencies with active instruments".to_string(),
        })?;

    debug!(
        count = assets.len(),
        ?assets,
        "discovered derive option assets"
    );
    Ok(DiscoveredOptionAssets {
        assets,
        default_catalogue,
    })
}

fn channel_name_for_instrument(instrument_name: &str) -> String {
    format!("ticker_slim.{instrument_name}.{TICKER_SLIM_INTERVAL_MS}")
}

fn parse_instrument_from_channel(channel: &str) -> Option<String> {
    let parts: Vec<&str> = channel.split('.').collect();
    if parts.len() != 3 || parts.first() != Some(&"ticker_slim") {
        return None;
    }
    parts.get(1).map(|name| (*name).to_string())
}

async fn send_subscribe_batch(
    writer: &mut DeriveWsWriter,
    channels: &[String],
    message_id: &mut i64,
) -> Result<(), DeriveError> {
    for chunk in channels.chunks(SUBSCRIBE_CHANNELS_PER_MESSAGE) {
        let payload = json!({
            "method": "subscribe",
            "params": { "channels": chunk },
            "id": *message_id
        });
        *message_id += 1;
        writer
            .send(Message::Text(payload.to_string().into()))
            .await?;
    }
    Ok(())
}

async fn send_unsubscribe_batch(
    writer: &mut DeriveWsWriter,
    channels: &[String],
    message_id: &mut i64,
) -> Result<(), DeriveError> {
    for chunk in channels.chunks(SUBSCRIBE_CHANNELS_PER_MESSAGE) {
        let payload = json!({
            "method": "unsubscribe",
            "params": { "channels": chunk },
            "id": *message_id
        });
        *message_id += 1;
        writer
            .send(Message::Text(payload.to_string().into()))
            .await?;
    }
    Ok(())
}

fn extract_notification_parts(notification: &WsNotification) -> Option<(String, WsData)> {
    if let (Some(channel), Some(data)) = (notification.channel.clone(), notification.data.clone()) {
        return Some((channel, data));
    }
    notification
        .params
        .as_ref()
        .and_then(|params| params.channel.clone().zip(params.data.clone()))
}

fn parse_optional_number(input: &str) -> Option<f64> {
    let value = input.parse::<f64>().ok()?;
    if value == 0.0 { None } else { Some(value) }
}

fn parse_api_decimal(input: &str) -> Option<f64> {
    input.parse::<f64>().ok()
}

fn parse_required_number(input: &str, field: &str) -> Result<f64, DeriveError> {
    input.parse::<f64>().map_err(|_| DeriveError::Api {
        message: format!("failed to parse {field}: {input}"),
    })
}

fn compute_moneyness(kind: OptionKind, strike: f64, spot: f64) -> Moneyness {
    if spot <= 0.0 {
        return Moneyness::AtTheMoney;
    }
    let ratio = (strike - spot).abs() / spot;
    if ratio < ATM_TOLERANCE {
        return Moneyness::AtTheMoney;
    }
    match kind {
        OptionKind::Call if spot > strike => Moneyness::InTheMoney,
        OptionKind::Put if spot < strike => Moneyness::InTheMoney,
        _ => Moneyness::OutOfTheMoney,
    }
}

fn expiry_date_yyyymmdd(expiry_unix: i64) -> Result<String, DeriveError> {
    Utc.timestamp_opt(expiry_unix, 0)
        .single()
        .map(|expiry| expiry.format("%Y%m%d").to_string())
        .ok_or(DeriveError::InvalidExpiry {
            timestamp: expiry_unix,
        })
}

fn quote_state_from_ticker(ticker: &TickerSlimDto) -> QuoteState {
    let greeks = build_greeks(ticker);
    let mark = parse_optional_number(&ticker.mark_price).or_else(|| {
        greeks
            .option_model_mark
            .filter(|model_mark| *model_mark != 0.0)
    });
    QuoteState {
        snapshot_timestamp_ms: ticker.snapshot_timestamp_ms,
        bid: parse_optional_number(&ticker.best_bid_price),
        ask: parse_optional_number(&ticker.best_ask_price),
        bid_size: parse_optional_number(&ticker.best_bid_size),
        ask_size: parse_optional_number(&ticker.best_ask_size),
        mark,
        spot: parse_api_decimal(&ticker.index_price).unwrap_or(0.0),
        greeks,
    }
}

fn upsert_quote(
    quote_map: &mut HashMap<String, QuoteState>,
    instrument_name: String,
    mut incoming: QuoteState,
) {
    if quote_map
        .get(&instrument_name)
        .is_some_and(|existing| incoming.snapshot_timestamp_ms <= existing.snapshot_timestamp_ms)
    {
        return;
    }
    if (!incoming.spot.is_finite() || incoming.spot <= 0.0)
        && let Some(existing) = quote_map
            .get(&instrument_name)
            .filter(|existing| existing.spot.is_finite() && existing.spot > 0.0)
    {
        incoming.spot = existing.spot;
    }
    quote_map.insert(instrument_name, incoming);
}

fn seed_quote_map(
    quote_map: &mut HashMap<String, QuoteState>,
    tickers: HashMap<String, TickerSlimDto>,
) {
    for (instrument_name, ticker) in tickers {
        upsert_quote(quote_map, instrument_name, quote_state_from_ticker(&ticker));
    }
}

async fn fetch_option_tickers(
    http: &Client,
    rest_base_url: &Url,
    asset: &str,
    expiry_unix: i64,
) -> Result<HashMap<String, TickerSlimDto>, DeriveError> {
    let expiry_date = expiry_date_yyyymmdd(expiry_unix)?;
    let rest_url = format!(
        "{}/public/get_tickers",
        rest_base_url.as_str().trim_end_matches('/')
    );
    let response: RpcResponse<GetTickersResult> = http
        .post(&rest_url)
        .json(&json!({
            "instrument_type": "option",
            "currency": asset,
            "expiry_date": expiry_date,
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(response.result.tickers)
}

async fn seed_quote_map_from_rest(
    http: &Client,
    rest_base_url: &Url,
    asset: &str,
    expiry_unix: i64,
    quote_map: &mut HashMap<String, QuoteState>,
) {
    match fetch_option_tickers(http, rest_base_url, asset, expiry_unix).await {
        Ok(tickers) => {
            let count = tickers.len();
            seed_quote_map(quote_map, tickers);
            debug!(
                asset,
                expiry_unix, count, "seeded derive option quotes from rest tickers"
            );
        }
        Err(error) => {
            warn!(
                asset,
                expiry_unix,
                error = %error,
                "derive rest ticker seed failed"
            );
        }
    }
}

fn build_greeks(ticker: &TickerSlimDto) -> OptionGreeks {
    let Some(pricing) = ticker.option_pricing.as_ref() else {
        return OptionGreeks::default();
    };
    OptionGreeks {
        bid_iv: parse_api_decimal(&pricing.bid_iv),
        ask_iv: parse_api_decimal(&pricing.ask_iv),
        delta: parse_api_decimal(&pricing.delta),
        gamma: parse_api_decimal(&pricing.gamma),
        vega: parse_api_decimal(&pricing.vega),
        theta: parse_api_decimal(&pricing.theta),
        iv: parse_api_decimal(&pricing.iv),
        rho: parse_api_decimal(&pricing.rho),
        forward_price: parse_api_decimal(&pricing.forward),
        discount_factor: parse_api_decimal(&pricing.discount_factor),
        option_model_mark: parse_api_decimal(&pricing.model_mark),
    }
}

fn build_bootstrap(
    catalogue: &OptionsCatalogue,
    asset: &str,
    assets: &[String],
) -> OptionsBootstrap {
    let tabs = catalogue
        .expiry_unix_sorted_asc
        .iter()
        .map(|expiry_unix| ExpiryTabPayload {
            expiry_unix: *expiry_unix,
            instruments: catalogue
                .names_by_expiry_unix
                .get(expiry_unix)
                .cloned()
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let default_expiry_unix = catalogue.expiry_unix_sorted_asc.first().copied();
    OptionsBootstrap {
        asset: asset.to_string(),
        assets: assets.to_vec(),
        default_expiry_unix,
        tabs,
    }
}

fn expiry_datetimes_from_catalogue(catalogue: &OptionsCatalogue) -> Vec<DateTime<Utc>> {
    catalogue
        .expiry_unix_sorted_asc
        .iter()
        .filter_map(|unix| Utc.timestamp_opt(*unix, 0).single())
        .collect()
}

fn build_tab_snapshot(
    asset: &str,
    catalogue: &OptionsCatalogue,
    active_expiry_unix: Option<i64>,
    quote_map: &HashMap<String, QuoteState>,
) -> OptionsSnapshot {
    let names = active_expiry_unix.and_then(|expiry| catalogue.names_by_expiry_unix.get(&expiry));

    let mut quotes: Vec<OptionQuote> = names
        .into_iter()
        .flatten()
        .filter_map(|instrument_name| {
            let meta = catalogue.instrument_by_name.get(instrument_name)?;
            let state = quote_map.get(instrument_name).cloned().unwrap_or_default();
            Some(OptionQuote {
                instrument_name: instrument_name.clone(),
                kind: meta.kind,
                strike: meta.strike,
                expiry: meta.expiry,
                expiry_unix: meta.expiry_unix,
                bid: state.bid,
                ask: state.ask,
                bid_size: state.bid_size,
                ask_size: state.ask_size,
                mark: state.mark,
                spot_price: state.spot,
                moneyness: compute_moneyness(meta.kind, meta.strike, state.spot),
                greeks: state.greeks,
            })
        })
        .collect();

    quotes.sort_by(|left, right| {
        left.strike
            .partial_cmp(&right.strike)
            .unwrap_or(Ordering::Equal)
            .then_with(|| match (left.kind, right.kind) {
                (OptionKind::Call, OptionKind::Put) => Ordering::Less,
                (OptionKind::Put, OptionKind::Call) => Ordering::Greater,
                _ => Ordering::Equal,
            })
    });

    let mut strike_bits = quotes
        .iter()
        .map(|quote| quote.strike.to_bits())
        .collect::<Vec<_>>();
    strike_bits.sort_unstable();
    strike_bits.dedup();
    let strikes = strike_bits
        .into_iter()
        .map(f64::from_bits)
        .collect::<Vec<_>>();

    let spot_price = quotes
        .iter()
        .find_map(|quote| (quote.spot_price > 0.0).then_some(quote.spot_price))
        .unwrap_or(0.0);

    OptionsSnapshot {
        asset: asset.to_string(),
        updated_at: Utc::now(),
        active_expiry_unix,
        expiry_unixes: catalogue.expiry_unix_sorted_asc.clone(),
        spot_price,
        expiry_dates: expiry_datetimes_from_catalogue(catalogue),
        strikes,
        quotes,
    }
}

async fn apply_tab_switch(
    writer: &mut DeriveWsWriter,
    message_id: &mut i64,
    subscribed_channels: &mut Vec<String>,
    catalogue: &OptionsCatalogue,
    new_expiry_unix: Option<i64>,
) -> Result<(), DeriveError> {
    if !subscribed_channels.is_empty() {
        send_unsubscribe_batch(writer, subscribed_channels, message_id).await?;
        subscribed_channels.clear();
    }

    let names = new_expiry_unix.and_then(|expiry| catalogue.names_by_expiry_unix.get(&expiry));
    let channels = names
        .into_iter()
        .flatten()
        .map(|name| channel_name_for_instrument(name))
        .collect::<Vec<_>>();
    if !channels.is_empty() {
        send_subscribe_batch(writer, &channels, message_id).await?;
    }
    *subscribed_channels = channels;
    Ok(())
}

struct OptionsHub {
    http: Client,
    rest_base_url: Url,
    shared_active: Arc<RwLock<SharedActiveOptions>>,
    snapshot: Arc<RwLock<OptionsSnapshot>>,
    broadcast_tx: broadcast::Sender<OptionsSnapshot>,
}

#[derive(Clone)]
struct HubRuntime {
    quote_map: HashMap<String, QuoteState>,
    active_expiry_unix: Option<i64>,
    asset: String,
    catalogue: OptionsCatalogue,
}

struct WsSession<'session> {
    writer: &'session mut DeriveWsWriter,
    message_id: &'session mut i64,
    subscribed_channels: &'session mut Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionControl {
    Continue,
    Reconnect,
}

async fn publish_shared_active(hub: &OptionsHub, runtime: &HubRuntime) {
    *hub.shared_active.write().await = SharedActiveOptions {
        asset: runtime.asset.clone(),
        catalogue: runtime.catalogue.clone(),
    };
}

async fn resubscribe_active_tab(
    session: &mut WsSession<'_>,
    hub: &OptionsHub,
    runtime: &mut HubRuntime,
) -> Result<(), DeriveError> {
    let subscribed = apply_tab_switch(
        session.writer,
        session.message_id,
        session.subscribed_channels,
        &runtime.catalogue,
        runtime.active_expiry_unix,
    )
    .await;
    let subscription_result = match (runtime.active_expiry_unix, subscribed) {
        (Some(_), Err(error)) => return Err(error),
        (Some(expiry_unix), Ok(())) => {
            runtime.quote_map.clear();
            seed_quote_map_from_rest(
                &hub.http,
                &hub.rest_base_url,
                runtime.asset.as_str(),
                expiry_unix,
                &mut runtime.quote_map,
            )
            .await;
            Ok(())
        }
        (None, outcome) => {
            runtime.quote_map.clear();
            session.subscribed_channels.clear();
            outcome
        }
    };
    publish_snapshot(
        runtime.asset.as_str(),
        &runtime.catalogue,
        runtime.active_expiry_unix,
        &runtime.quote_map,
        hub.snapshot.as_ref(),
        &hub.broadcast_tx,
    )
    .await;
    if runtime.active_expiry_unix.is_none() {
        debug!(asset = %runtime.asset, "derive empty option snapshot published");
    }
    subscription_result
}

async fn prepare_command(
    command: &HubCommand,
    hub: &OptionsHub,
    runtime: &HubRuntime,
) -> Result<HubRuntime, DeriveError> {
    let mut next = runtime.clone();
    match command {
        HubCommand::SetExpiry(expiry) => {
            if !runtime.catalogue.expiry_unix_sorted_asc.contains(expiry) {
                return Err(DeriveError::InvalidExpiry { timestamp: *expiry });
            }
            next.active_expiry_unix = Some(*expiry);
        }
        HubCommand::SetAsset(asset) => {
            next.catalogue = fetch_options_catalogue(&hub.http, &hub.rest_base_url, asset).await?;
            next.asset.clone_from(asset);
            next.active_expiry_unix = next.catalogue.expiry_unix_sorted_asc.first().copied();
        }
    }
    next.quote_map.clear();
    if let Some(expiry) = next.active_expiry_unix {
        let tickers =
            fetch_option_tickers(&hub.http, &hub.rest_base_url, &next.asset, expiry).await?;
        seed_quote_map(&mut next.quote_map, tickers);
    }
    Ok(next)
}

async fn handle_command(
    mut request: HubRequest,
    session: &mut WsSession<'_>,
    hub: &OptionsHub,
    runtime: &mut HubRuntime,
) -> SessionControl {
    if request.acknowledgment.is_closed() {
        debug!(command = ?request.command, "derive command cancelled before application");
        return SessionControl::Continue;
    }
    if matches!(&request.command, HubCommand::SetAsset(asset) if asset == &runtime.asset) {
        debug!(command = ?request.command, "derive command applied");
        let _ = request.acknowledgment.send(Ok(()));
        return SessionControl::Continue;
    }
    let applied: Result<_, DeriveError> = tokio::select! {
        biased;
        () = request.acknowledgment.closed() => {
            debug!(command = ?request.command, "derive command cancelled before commit");
            return SessionControl::Reconnect;
        }
        prepared = async {
            let next = prepare_command(&request.command, hub, runtime).await?;
            apply_tab_switch(
                session.writer,
                session.message_id,
                session.subscribed_channels,
                &next.catalogue,
                next.active_expiry_unix,
            ).await?;
            let active = hub.shared_active.write().await;
            let snapshot = hub.snapshot.write().await;
            Ok((next, active, snapshot))
        } => prepared,
    };
    match applied {
        Ok((next, mut active, mut snapshot)) => {
            if request.acknowledgment.is_closed() {
                debug!(command = ?request.command, "derive command cancelled before commit");
                return SessionControl::Reconnect;
            }
            let next_snapshot = build_tab_snapshot(
                &next.asset,
                &next.catalogue,
                next.active_expiry_unix,
                &next.quote_map,
            );
            *active = SharedActiveOptions {
                asset: next.asset.clone(),
                catalogue: next.catalogue.clone(),
            };
            *snapshot = next_snapshot.clone();
            *runtime = next;
            let _ = hub.broadcast_tx.send(next_snapshot);
            debug!(command = ?request.command, "derive command applied");
            let _ = request.acknowledgment.send(Ok(()));
            SessionControl::Continue
        }
        Err(error) => {
            let control = if matches!(&error, DeriveError::WebSocket(_)) {
                SessionControl::Reconnect
            } else {
                SessionControl::Continue
            };
            error!(command = ?request.command, error = %error, "derive command failed");
            let _ = request.acknowledgment.send(Err(error));
            control
        }
    }
}

async fn handle_catalogue_refresh(
    session: &mut WsSession<'_>,
    hub: &OptionsHub,
    runtime: &mut HubRuntime,
) -> Result<SessionControl, DeriveError> {
    let now_unix = Utc::now().timestamp();
    let next_catalogue = match fetch_options_catalogue(
        &hub.http,
        &hub.rest_base_url,
        runtime.asset.as_str(),
    )
    .await
    {
        Ok(catalogue) => catalogue,
        Err(error) => {
            warn!(
                asset = %runtime.asset,
                error = %error,
                "derive catalogue refresh failed"
            );
            prune_closed_expiries(&runtime.catalogue, now_unix)
        }
    };

    let next_active = runtime
        .active_expiry_unix
        .filter(|expiry| next_catalogue.expiry_unix_sorted_asc.contains(expiry))
        .or_else(|| next_catalogue.expiry_unix_sorted_asc.first().copied());
    if catalogues_equivalent(&runtime.catalogue, &next_catalogue)
        && next_active == runtime.active_expiry_unix
    {
        return Ok(SessionControl::Continue);
    }

    runtime.catalogue = next_catalogue;
    publish_shared_active(hub, runtime).await;
    runtime.active_expiry_unix = next_active;

    if let Err(error) = resubscribe_active_tab(session, hub, runtime).await {
        error!(error = %error, "derive catalogue refresh subscriptions failed");
        return Ok(SessionControl::Reconnect);
    }
    debug!(
        asset = %runtime.asset,
        expiry_unix = ?runtime.active_expiry_unix,
        tabs = runtime.catalogue.expiry_unix_sorted_asc.len(),
        "derive option catalogue refreshed"
    );
    Ok(SessionControl::Continue)
}

async fn publish_snapshot(
    asset: &str,
    catalogue: &OptionsCatalogue,
    active_expiry_unix: Option<i64>,
    quote_map: &HashMap<String, QuoteState>,
    snapshot: &RwLock<OptionsSnapshot>,
    broadcast_tx: &broadcast::Sender<OptionsSnapshot>,
) {
    let next_snapshot = build_tab_snapshot(asset, catalogue, active_expiry_unix, quote_map);
    *snapshot.write().await = next_snapshot.clone();
    let _ = broadcast_tx.send(next_snapshot);
}

async fn process_message(
    message: Message,
    catalogue: &OptionsCatalogue,
    asset: &str,
    active_expiry_unix: Option<i64>,
    quote_map: &mut HashMap<String, QuoteState>,
    snapshot: &RwLock<OptionsSnapshot>,
    broadcast_tx: &broadcast::Sender<OptionsSnapshot>,
) -> Result<(), DeriveError> {
    if !message.is_text() {
        return Ok(());
    }
    let text = message.to_text()?;
    let Ok(notification) = serde_json::from_str::<WsNotification>(text) else {
        return Ok(());
    };
    let Some((channel, data)) = extract_notification_parts(&notification) else {
        return Ok(());
    };
    if !channel.starts_with("ticker_slim.") {
        return Ok(());
    }
    let Some(instrument_name) = parse_instrument_from_channel(&channel) else {
        return Ok(());
    };
    let Some(meta) = catalogue.instrument_by_name.get(&instrument_name) else {
        return Ok(());
    };
    if Some(meta.expiry_unix) != active_expiry_unix {
        return Ok(());
    }
    upsert_quote(
        quote_map,
        instrument_name,
        quote_state_from_ticker(data.ticker()),
    );
    publish_snapshot(
        asset,
        catalogue,
        active_expiry_unix,
        quote_map,
        snapshot,
        broadcast_tx,
    )
    .await;
    Ok(())
}

async fn run_websocket_hub(
    ws_url: Url,
    hub: OptionsHub,
    mut command_rx: mpsc::Receiver<HubRequest>,
    initial_asset: String,
    initial_expiry_unix: i64,
) -> Result<(), DeriveError> {
    let mut runtime = HubRuntime {
        quote_map: HashMap::new(),
        active_expiry_unix: Some(initial_expiry_unix),
        asset: initial_asset,
        catalogue: hub.shared_active.read().await.catalogue.clone(),
    };

    let mut refresh = tokio::time::interval(CATALOGUE_REFRESH_INTERVAL);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    refresh.tick().await;

    'reconnect: loop {
        let (stream, _) = match connect_async(ws_url.as_str()).await {
            Ok(pair) => pair,
            Err(error) => {
                error!(error = %error, url = %ws_url, "derive websocket connect failed");
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue 'reconnect;
            }
        };
        info!(url = %ws_url, "derive websocket connected");
        let (mut writer, mut reader) = stream.split();
        let mut message_id: i64 = 1;
        let mut subscribed_channels: Vec<String> = Vec::new();
        let mut session = WsSession {
            writer: &mut writer,
            message_id: &mut message_id,
            subscribed_channels: &mut subscribed_channels,
        };

        if let Err(error) = resubscribe_active_tab(&mut session, &hub, &mut runtime).await {
            error!(error = %error, "derive initial tab subscriptions failed");
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue 'reconnect;
        }

        'session: loop {
            tokio::select! {
                maybe_command = command_rx.recv() => {
                    let Some(command) = maybe_command else {
                        return Ok(());
                    };
                    let control = handle_command(command, &mut session, &hub, &mut runtime).await;
                    if control == SessionControl::Reconnect {
                        break 'session;
                    }
                }
                _ = refresh.tick() => {
                    let control =
                        handle_catalogue_refresh(&mut session, &hub, &mut runtime).await?;
                    if control == SessionControl::Reconnect {
                        break 'session;
                    }
                }
                maybe_message = reader.next() => {
                    let Some(message_result) = maybe_message else {
                        break 'session;
                    };
                    let message = match message_result {
                        Ok(message) => message,
                        Err(error) => {
                            error!(error = %error, "derive websocket read failed");
                            break 'session;
                        }
                    };
                    process_message(
                        message,
                        &runtime.catalogue,
                        runtime.asset.as_str(),
                        runtime.active_expiry_unix,
                        &mut runtime.quote_map,
                        hub.snapshot.as_ref(),
                        &hub.broadcast_tx,
                    )
                    .await?;
                }
            }
        }

        warn!(url = %ws_url, "derive websocket session ended, reconnecting");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn health() -> &'static str {
    "ok"
}

async fn get_bootstrap(
    State(networks): State<Arc<DeriveNetworksState>>,
    Query(query): Query<NetworkQuery>,
) -> Result<Json<OptionsBootstrap>, StatusCode> {
    let state = networks.for_network(query.network)?;
    let active = state.active.read().await;
    Ok(Json(build_bootstrap(
        &active.catalogue,
        active.asset.as_str(),
        &state.assets,
    )))
}

async fn get_snapshot(
    State(networks): State<Arc<DeriveNetworksState>>,
    Query(query): Query<NetworkQuery>,
) -> Result<Json<OptionsSnapshot>, StatusCode> {
    let state = networks.for_network(query.network)?;
    Ok(Json(state.snapshot.read().await.clone()))
}

async fn stream_options(
    State(networks): State<Arc<DeriveNetworksState>>,
    Query(query): Query<NetworkQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let state = networks.for_network(query.network)?;
    let receiver = state.tx.subscribe();
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(next_snapshot) => {
                    let event = match Event::default().json_data(next_snapshot) {
                        Ok(event) => event,
                        Err(error) => {
                            warn!(error = %error, "derive options stream serialization failed");
                            continue;
                        }
                    };
                    return Some((Ok(event), receiver));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Ok(Sse::new(stream))
}

/// Switch the active expiry that the selected network hub streams.
///
/// Each Derive network holds a single, process-global active expiry shared by
/// every SSE subscriber on that network, so it is intended for single-client
/// use: if two clients select different expiries, the most recent request wins
/// and both clients see that expiry's data.
async fn post_active_expiry(
    State(networks): State<Arc<DeriveNetworksState>>,
    Query(query): Query<NetworkQuery>,
    Json(body): Json<ActiveExpiryBody>,
) -> Result<StatusCode, StatusCode> {
    let state = networks.for_network(query.network)?;
    let active = state.active.read().await;
    if !active
        .catalogue
        .expiry_unix_sorted_asc
        .contains(&body.expiry_unix)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    drop(active);
    await_command(state, HubCommand::SetExpiry(body.expiry_unix)).await
}

/// Switch the active underlying asset on the selected network hub. Reloads that
/// currency's option catalogue and resubscribes websocket channels to its
/// nearest expiry.
///
/// Same single-client caveat as [`post_active_expiry`].
async fn post_active_asset(
    State(networks): State<Arc<DeriveNetworksState>>,
    Query(query): Query<NetworkQuery>,
    Json(body): Json<ActiveAssetBody>,
) -> Result<StatusCode, StatusCode> {
    let state = networks.for_network(query.network)?;
    if !state.assets.iter().any(|asset| asset == &body.asset) {
        return Err(StatusCode::BAD_REQUEST);
    }
    await_command(state, HubCommand::SetAsset(body.asset)).await
}

async fn await_command(state: &DeriveState, command: HubCommand) -> Result<StatusCode, StatusCode> {
    let (acknowledgment, applied) = oneshot::channel();
    tokio::time::timeout(HUB_COMMAND_TIMEOUT, async {
        state
            .command_tx
            .send(HubRequest {
                command,
                acknowledgment,
            })
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        applied
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
            .map_err(|error| match error {
                DeriveError::InvalidExpiry { .. } => StatusCode::BAD_REQUEST,
                _ => StatusCode::BAD_GATEWAY,
            })
    })
    .await
    .map_err(|_| StatusCode::GATEWAY_TIMEOUT)??;
    Ok(StatusCode::NO_CONTENT)
}

async fn spawn_options_hub(
    rest_base_url: Url,
    ws_url: Url,
    network: DeriveNetwork,
) -> Result<Arc<DeriveState>, DeriveError> {
    let http = build_http_client()?;
    let discovered = tokio::time::timeout(
        OPTIONS_DISCOVERY_TIMEOUT,
        fetch_option_assets(&http, &rest_base_url),
    )
    .await
    .map_err(|_| DeriveError::Api {
        message: format!(
            "derive {network:?} option discovery exceeded {} seconds",
            OPTIONS_DISCOVERY_TIMEOUT.as_secs()
        ),
    })??;
    let default_asset = discovered
        .assets
        .first()
        .cloned()
        .ok_or_else(|| DeriveError::Api {
            message: format!("derive {network:?} option asset list was empty after discovery"),
        })?;
    let assets = discovered.assets;
    let catalogue = discovered.default_catalogue;
    let Some(default_expiry_unix) = catalogue.expiry_unix_sorted_asc.first().copied() else {
        error!(
            asset = %default_asset,
            ?network,
            "derive returned no active option expiries"
        );
        return Err(DeriveError::Api {
            message: format!(
                "derive returned no active option expiries for {default_asset} on {network:?}"
            ),
        });
    };

    let empty_snapshot = build_tab_snapshot(
        default_asset.as_str(),
        &catalogue,
        Some(default_expiry_unix),
        &HashMap::new(),
    );
    let snapshot = Arc::new(RwLock::new(empty_snapshot));
    let (broadcast_tx, _) = broadcast::channel(2048);
    let (command_tx, command_rx) = mpsc::channel::<HubRequest>(32);
    let shared_active = Arc::new(RwLock::new(SharedActiveOptions {
        asset: default_asset.clone(),
        catalogue,
    }));

    let active_for_state = Arc::clone(&shared_active);
    let broadcast_for_state = broadcast_tx.clone();
    let snapshot_for_task = Arc::clone(&snapshot);
    let http_for_task = http.clone();
    let hub_task = tokio::spawn(async move {
        if let Err(error) = run_websocket_hub(
            ws_url,
            OptionsHub {
                http: http_for_task,
                rest_base_url,
                shared_active,
                snapshot: snapshot_for_task,
                broadcast_tx,
            },
            command_rx,
            default_asset,
            default_expiry_unix,
        )
        .await
        {
            error!(error = %error, ?network, "derive websocket hub exited with error");
        }
    });

    let state = Arc::new(DeriveState {
        assets,
        active: active_for_state,
        snapshot,
        tx: broadcast_for_state,
        command_tx,
        hub_task: hub_task.abort_handle(),
    });
    debug!(?network, "derive options websocket hub spawned");
    Ok(state)
}

/// Options chain routes + background Derive websocket hubs (mainnet + testnet).
///
/// Paths match what the frontend hits through the Vite `/api` proxy
/// (`/derive/options/...?network=`). No CORS layer -- same-origin via the proxy,
/// same as the rest of moneymentum. For a standalone process with its own port,
/// use [`derive_app`].
///
/// # Errors
///
/// Returns [`DeriveError`] when both networks fail to initialize. A failed
/// network returns HTTP 503 without disabling the other network's routes.
pub async fn derive_options_router(config: DeriveConfig) -> Result<Router, DeriveError> {
    let (mainnet, testnet) = tokio::join!(
        spawn_options_hub(config.rest_base_url, config.ws_url, DeriveNetwork::Mainnet),
        spawn_options_hub(
            config.testnet_rest_base_url,
            config.testnet_ws_url,
            DeriveNetwork::Testnet
        ),
    );
    for (network, result) in [
        (DeriveNetwork::Mainnet, &mainnet),
        (DeriveNetwork::Testnet, &testnet),
    ] {
        if let Err(error) = result {
            warn!(?network, error = %error, "derive options network unavailable");
        }
    }
    if mainnet.is_err() && testnet.is_err() {
        return Err(DeriveError::Api {
            message: "neither Derive network could initialize".to_string(),
        });
    }
    let networks = Arc::new(DeriveNetworksState { mainnet, testnet });

    Ok(Router::new()
        .route("/derive/options/bootstrap", get(get_bootstrap))
        .route("/derive/options/snapshot", get(get_snapshot))
        .route("/derive/options/stream", get(stream_options))
        .route("/derive/options/active_expiry", post(post_active_expiry))
        .route("/derive/options/active_asset", post(post_active_asset))
        .with_state(networks))
}

/// Standalone Derive options HTTP server (used by `derive_cli`).
///
/// # Errors
///
/// Returns [`DeriveError`] when the options hub fails to start.
pub async fn derive_app(config: DeriveConfig) -> Result<Router, DeriveError> {
    let port = config.port;
    let router = derive_options_router(config).await?;
    info!(port, "derive options server ready");
    Ok(router
        .route("/health", get(health))
        .layer(middleware::from_fn(cors_middleware)))
}

#[cfg(test)]
mod tests {
    use tracing_test::traced_test;

    use super::*;

    fn logs_contain_at(level: tracing::Level, snippets: &[&str]) -> bool {
        let buffer = tracing_test::internal::global_buf()
            .lock()
            .expect("test log buffer");
        let logs = String::from_utf8_lossy(&buffer);
        logs.lines().any(|line| {
            line.contains(level.as_str()) && snippets.iter().all(|snippet| line.contains(snippet))
        })
    }

    #[test]
    fn empty_catalogue_bootstrap_has_no_default_expiry() {
        let catalogue = catalogue_from_instruments(Vec::new(), Utc::now().timestamp())
            .expect("empty catalogue");
        let bootstrap = build_bootstrap(&catalogue, "BTC", &["BTC".to_string()]);
        let payload = serde_json::to_value(bootstrap).expect("bootstrap JSON");
        assert!(payload["default_expiry_unix"].is_null());
        assert_eq!(payload["tabs"], json!([]));
    }

    #[derive(Clone, Copy)]
    enum TestConnection {
        Open,
        Closed,
    }

    async fn assert_empty_catalogue_refresh(
        expiry_unix: i64,
        status: StatusCode,
        connection: TestConnection,
    ) {
        let venue = serve_test_router(Router::new().route(
            "/public/get_instruments",
            post(move || async move { (status, Json(json!({"result": []}))) }),
        ))
        .await;
        let catalogue = catalogue_from_instruments(
            vec![InstrumentDto {
                instrument_name: "BTC-C".to_string(),
                is_active: true,
                option_details: Some(OptionDetailsDto {
                    option_type: "C".to_string(),
                    strike: "65000".to_string(),
                    expiry: u64::try_from(expiry_unix).expect("fixture expiry"),
                }),
            }],
            expiry_unix - 1,
        )
        .expect("initial catalogue");
        let quote_map = HashMap::from([("BTC-C".to_string(), QuoteState::default())]);
        let snapshot = build_tab_snapshot("BTC", &catalogue, Some(expiry_unix), &quote_map);
        let (broadcast_tx, mut snapshots) = broadcast::channel(4);
        let hub = OptionsHub {
            http: build_http_client().expect("HTTP client"),
            rest_base_url: venue.url.clone(),
            shared_active: Arc::new(RwLock::new(SharedActiveOptions {
                asset: "BTC".to_string(),
                catalogue: catalogue.clone(),
            })),
            snapshot: Arc::new(RwLock::new(snapshot)),
            broadcast_tx,
        };
        let mut runtime = HubRuntime {
            quote_map,
            active_expiry_unix: Some(expiry_unix),
            asset: "BTC".to_string(),
            catalogue,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("WS listener");
        let ws_url = format!("ws://{}", listener.local_addr().expect("WS address"));
        let (client, mut peer) = tokio::join!(connect_async(ws_url), async {
            let (socket, _) = listener.accept().await.expect("WS accept");
            tokio_tungstenite::accept_async(socket)
                .await
                .expect("WS handshake")
        });
        let (mut writer, _reader) = client.expect("WS client").0.split();
        if matches!(connection, TestConnection::Closed) {
            writer.close().await.expect("close test writer");
        }
        let old_channel = channel_name_for_instrument("BTC-C");
        let mut channels = vec![old_channel.clone()];
        let mut message_id = 1;
        let mut session = WsSession {
            writer: &mut writer,
            message_id: &mut message_id,
            subscribed_channels: &mut channels,
        };
        assert_eq!(
            handle_catalogue_refresh(&mut session, &hub, &mut runtime)
                .await
                .expect("refresh"),
            match connection {
                TestConnection::Open => SessionControl::Continue,
                TestConnection::Closed => SessionControl::Reconnect,
            },
        );
        assert!(
            runtime.catalogue.expiry_unix_sorted_asc.is_empty(),
            "last expiry must disappear"
        );
        assert!(runtime.quote_map.is_empty());
        assert!(channels.is_empty());
        let active = hub.shared_active.read().await;
        let bootstrap = serde_json::to_value(build_bootstrap(
            &active.catalogue,
            &active.asset,
            &["BTC".to_string()],
        ))
        .expect("bootstrap JSON");
        assert!(bootstrap["default_expiry_unix"].is_null());
        assert_eq!(bootstrap["tabs"], json!([]));
        let snapshot =
            serde_json::to_value(hub.snapshot.read().await.clone()).expect("snapshot JSON");
        assert!(snapshot["active_expiry_unix"].is_null());
        for field in ["expiry_unixes", "expiry_dates", "strikes", "quotes"] {
            assert_eq!(snapshot[field], json!([]), "{field} must be cleared");
        }
        assert_eq!(
            serde_json::to_value(snapshots.try_recv().expect("published empty snapshot"))
                .expect("event JSON"),
            snapshot
        );
        if matches!(connection, TestConnection::Closed) {
            assert!(logs_contain_at(
                tracing::Level::DEBUG,
                &["derive empty option snapshot published"]
            ));
            return;
        }
        let unsubscribe = tokio::time::timeout(Duration::from_secs(1), peer.next())
            .await
            .expect("unsubscribe deadline")
            .expect("unsubscribe frame")
            .expect("WS read");
        let payload: serde_json::Value =
            serde_json::from_str(unsubscribe.to_text().expect("unsubscribe text"))
                .expect("unsubscribe JSON");
        assert_eq!(payload["method"], "unsubscribe");
        assert_eq!(payload["params"]["channels"], json!([old_channel]));
        assert!(logs_contain_at(
            tracing::Level::DEBUG,
            &["derive option catalogue refreshed", "tabs=0"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn empty_catalogue_refresh_clears_delisted_future_expiry() {
        assert_empty_catalogue_refresh(
            Utc::now().timestamp() + 3600,
            StatusCode::OK,
            TestConnection::Open,
        )
        .await;
    }

    #[traced_test]
    #[tokio::test]
    async fn empty_catalogue_refresh_prunes_final_expiry_when_rest_fails() {
        assert_empty_catalogue_refresh(
            Utc::now().timestamp() - 1,
            StatusCode::SERVICE_UNAVAILABLE,
            TestConnection::Open,
        )
        .await;
    }

    #[traced_test]
    #[tokio::test]
    async fn empty_catalogue_refresh_publishes_even_when_unsubscribe_fails() {
        assert_empty_catalogue_refresh(
            Utc::now().timestamp() + 3600,
            StatusCode::OK,
            TestConnection::Closed,
        )
        .await;
    }

    fn command_fixture(rest_base_url: Url) -> (OptionsHub, HubRuntime) {
        let catalogue = catalogue_from_instruments(
            [1_900_000_000, 1_910_000_000]
                .into_iter()
                .map(|expiry| InstrumentDto {
                    instrument_name: format!("BTC-{expiry}-C"),
                    is_active: true,
                    option_details: Some(OptionDetailsDto {
                        option_type: "C".to_string(),
                        strike: "65000".to_string(),
                        expiry,
                    }),
                })
                .collect(),
            1_800_000_000,
        )
        .expect("catalogue");
        let runtime = HubRuntime {
            catalogue,
            asset: "BTC".to_string(),
            active_expiry_unix: Some(1_900_000_000),
            quote_map: HashMap::from([(
                "BTC-1900000000-C".to_string(),
                QuoteState {
                    mark: Some(12.0),
                    ..QuoteState::default()
                },
            )]),
        };
        let (broadcast_tx, _) = broadcast::channel(4);
        let hub = OptionsHub {
            http: build_http_client().expect("client"),
            rest_base_url,
            shared_active: Arc::new(RwLock::new(SharedActiveOptions {
                asset: runtime.asset.clone(),
                catalogue: runtime.catalogue.clone(),
            })),
            snapshot: Arc::new(RwLock::new(build_tab_snapshot(
                &runtime.asset,
                &runtime.catalogue,
                runtime.active_expiry_unix,
                &runtime.quote_map,
            ))),
            broadcast_tx,
        };
        (hub, runtime)
    }

    async fn closed_command_writer() -> DeriveWsWriter {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("WS listener");
        let ws_url = format!("ws://{}", listener.local_addr().expect("WS address"));
        let (client, _peer) = tokio::join!(connect_async(ws_url), async {
            let (socket, _) = listener.accept().await.expect("WS accept");
            tokio_tungstenite::accept_async(socket)
                .await
                .expect("WS handshake")
        });
        let (mut writer, _reader) = client.expect("WS client").0.split();
        writer.close().await.expect("close writer");
        writer
    }

    #[traced_test]
    #[tokio::test]
    async fn command_subscription_failure_preserves_runtime_and_publication() {
        let venue = serve_test_router(Router::new().route(
            "/public/get_tickers",
            post(|| async { Json(json!({"result": {"tickers": {}}})) }),
        ))
        .await;
        let (hub, mut runtime) = command_fixture(venue.url.clone());
        let original =
            serde_json::to_value(hub.snapshot.read().await.clone()).expect("snapshot JSON");
        let mut publications = hub.broadcast_tx.subscribe();
        let mut writer = closed_command_writer().await;
        let mut message_id = 1;
        let mut channels = vec![channel_name_for_instrument("BTC-1900000000-C")];
        let mut session = WsSession {
            writer: &mut writer,
            message_id: &mut message_id,
            subscribed_channels: &mut channels,
        };
        let (acknowledgment, applied) = oneshot::channel();
        let control = handle_command(
            HubRequest {
                command: HubCommand::SetExpiry(1_910_000_000),
                acknowledgment,
            },
            &mut session,
            &hub,
            &mut runtime,
        )
        .await;
        assert_eq!(control, SessionControl::Reconnect);
        assert!(matches!(
            applied.await.expect("acknowledgment"),
            Err(DeriveError::WebSocket(_))
        ));
        assert_eq!(runtime.active_expiry_unix, Some(1_900_000_000));
        assert_eq!(
            runtime
                .quote_map
                .get("BTC-1900000000-C")
                .expect("old quote")
                .mark,
            Some(12.0)
        );
        assert_eq!(
            serde_json::to_value(hub.snapshot.read().await.clone()).expect("snapshot JSON"),
            original
        );
        assert!(matches!(
            publications.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        assert!(logs_contain_at(
            tracing::Level::ERROR,
            &["derive command failed", "SetExpiry"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn command_cancelled_before_application_is_skipped() {
        let venue = serve_test_router(Router::new()).await;
        let (hub, mut runtime) = command_fixture(venue.url.clone());
        let mut writer = closed_command_writer().await;
        let mut message_id = 1;
        let mut channels = Vec::new();
        let mut session = WsSession {
            writer: &mut writer,
            message_id: &mut message_id,
            subscribed_channels: &mut channels,
        };
        let (acknowledgment, applied) = oneshot::channel();
        drop(applied);
        assert_eq!(
            handle_command(
                HubRequest {
                    command: HubCommand::SetExpiry(1_910_000_000),
                    acknowledgment
                },
                &mut session,
                &hub,
                &mut runtime
            )
            .await,
            SessionControl::Continue
        );
        assert_eq!(runtime.active_expiry_unix, Some(1_900_000_000));
        assert_eq!(message_id, 1);
        assert!(logs_contain_at(
            tracing::Level::DEBUG,
            &["derive command cancelled before application"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn command_cancelled_during_preparation_cannot_publish_later() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let request_entered = Arc::clone(&entered);
        let venue = serve_test_router(Router::new().route(
            "/public/get_tickers",
            post(move || {
                let entered = Arc::clone(&request_entered);
                async move {
                    entered.notify_one();
                    std::future::pending::<Json<serde_json::Value>>().await
                }
            }),
        ))
        .await;
        let (hub, mut runtime) = command_fixture(venue.url.clone());
        let original =
            serde_json::to_value(hub.snapshot.read().await.clone()).expect("snapshot JSON");
        let mut writer = closed_command_writer().await;
        let mut message_id = 1;
        let mut channels = Vec::new();
        let mut session = WsSession {
            writer: &mut writer,
            message_id: &mut message_id,
            subscribed_channels: &mut channels,
        };
        let (acknowledgment, applied) = oneshot::channel();
        let (control, ()) = tokio::join!(
            handle_command(
                HubRequest {
                    command: HubCommand::SetExpiry(1_910_000_000),
                    acknowledgment
                },
                &mut session,
                &hub,
                &mut runtime
            ),
            async {
                tokio::time::timeout(Duration::from_secs(1), entered.notified())
                    .await
                    .expect("seed started");
                drop(applied);
            },
        );
        assert_eq!(control, SessionControl::Reconnect);
        assert_eq!(runtime.active_expiry_unix, Some(1_900_000_000));
        assert_eq!(message_id, 1);
        assert_eq!(
            serde_json::to_value(hub.snapshot.read().await.clone()).expect("snapshot JSON"),
            original
        );
        assert!(logs_contain_at(
            tracing::Level::DEBUG,
            &["derive command cancelled before commit"]
        ));
    }

    struct TestServer {
        url: Url,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn serve_test_router(router: Router) -> TestServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let url = Url::parse(&format!(
            "http://{}",
            listener.local_addr().expect("address")
        ))
        .expect("test URL");
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("test server");
        });
        TestServer { url, task }
    }

    async fn test_rest_venue() -> TestServer {
        let router = Router::new()
            .route("/public/get_all_currencies", post(|| async {
                Json(json!({"result": [{"currency": "BTC", "instrument_types": ["option"]}]}))
            }))
            .route("/public/get_instruments", post(|| async {
                Json(json!({"result": [{
                    "instrument_name": "BTC-C", "is_active": true,
                    "option_details": {"option_type": "C", "strike": "65000", "expiry": Utc::now().timestamp() + 3600}
                }]}))
            }));
        serve_test_router(router).await
    }

    async fn assert_one_network_remains_available(healthy: DeriveNetwork) {
        let venue = test_rest_venue().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("WS listener");
        let ws_url = Url::parse(&format!(
            "ws://{}",
            listener.local_addr().expect("WS address")
        ))
        .expect("WS URL");
        let unavailable_url = venue.url.join("unavailable").expect("unavailable URL");
        let config = DeriveConfig {
            port: 0,
            rest_base_url: if healthy == DeriveNetwork::Mainnet {
                venue.url.clone()
            } else {
                unavailable_url.clone()
            },
            testnet_rest_base_url: if healthy == DeriveNetwork::Testnet {
                venue.url.clone()
            } else {
                unavailable_url
            },
            ws_url: ws_url.clone(),
            testnet_ws_url: ws_url,
        };
        let router = derive_options_router(config)
            .await
            .expect("healthy network must remain available");
        let application = serve_test_router(router).await;
        let client = build_http_client().expect("client");
        for network in [DeriveNetwork::Mainnet, DeriveNetwork::Testnet] {
            let name = match network {
                DeriveNetwork::Mainnet => "mainnet",
                DeriveNetwork::Testnet => "testnet",
            };
            let response = client
                .get(
                    application
                        .url
                        .join(&format!("derive/options/bootstrap?network={name}"))
                        .expect("bootstrap URL"),
                )
                .send()
                .await
                .expect("bootstrap response");
            assert_eq!(
                response.status(),
                if network == healthy {
                    StatusCode::OK
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                }
            );
        }
    }

    #[tokio::test]
    async fn mainnet_remains_available_when_testnet_discovery_fails() {
        assert_one_network_remains_available(DeriveNetwork::Mainnet).await;
    }

    #[tokio::test]
    async fn testnet_remains_available_when_mainnet_discovery_fails() {
        assert_one_network_remains_available(DeriveNetwork::Testnet).await;
    }

    #[tokio::test]
    async fn dropping_hub_state_cancels_a_stalled_websocket_handshake() {
        let venue = test_rest_venue().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("WS listener");
        let ws_url = Url::parse(&format!(
            "ws://{}",
            listener.local_addr().expect("WS address")
        ))
        .expect("WS URL");
        let (connected_tx, connected_rx) = tokio::sync::oneshot::channel();
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("WS accept");
            let _ = connected_tx.send(());
            let mut buffer = [0_u8; 2048];
            loop {
                socket.readable().await.expect("socket readable");
                match socket.try_read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                    Err(error) => panic!("test socket read failed: {error}"),
                }
            }
            let _ = closed_tx.send(());
        });
        let state = spawn_options_hub(venue.url.clone(), ws_url, DeriveNetwork::Mainnet)
            .await
            .expect("hub");
        tokio::time::timeout(Duration::from_secs(2), connected_rx)
            .await
            .expect("connection deadline")
            .expect("connected");
        drop(state);
        let closed = tokio::time::timeout(Duration::from_secs(1), closed_rx).await;
        server.abort();
        assert!(
            matches!(closed, Ok(Ok(()))),
            "dropping the owner must terminate its websocket task"
        );
    }

    #[tokio::test]
    async fn aggregate_discovery_is_bounded_across_many_slow_currency_probes() {
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_probes = Arc::clone(&probes);
        let router =
            Router::new()
                .route(
                    "/public/get_all_currencies",
                    post(|| async {
                        let currencies = (0..56).map(|index| json!({
                    "currency": format!("ASSET{index}"), "instrument_types": ["option"]
                })).collect::<Vec<_>>();
                        Json(json!({"result": currencies}))
                    }),
                )
                .route(
                    "/public/get_instruments",
                    post(move || {
                        let probes = Arc::clone(&observed_probes);
                        async move {
                            probes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            tokio::time::sleep(Duration::from_secs(6)).await;
                            Json(json!({"result": []}))
                        }
                    }),
                );
        let venue = serve_test_router(router).await;
        let ws_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("WS listener");
        let ws_url = Url::parse(&format!(
            "ws://{}",
            ws_listener.local_addr().expect("WS address")
        ))
        .expect("WS URL");
        let result = tokio::time::timeout(
            Duration::from_secs(26),
            derive_options_router(DeriveConfig {
                port: 0,
                rest_base_url: venue.url.clone(),
                testnet_rest_base_url: venue.url.clone(),
                ws_url: ws_url.clone(),
                testnet_ws_url: ws_url,
            }),
        )
        .await;
        assert!(
            probes.load(std::sync::atomic::Ordering::Relaxed) >= 16,
            "both networks must enter concurrent discovery"
        );
        assert!(
            result
                .expect("aggregate discovery must finish before the outer deadline")
                .is_err()
        );
    }

    #[tokio::test]
    async fn http_client_bounds_a_server_that_never_replies() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("test connection");
            tokio::time::sleep(Duration::from_secs(10)).await;
            drop(stream);
        });
        let client = build_http_client().expect("HTTP client");
        let result = tokio::time::timeout(
            Duration::from_secs(6),
            client.get(format!("http://{address}/stalled")).send(),
        )
        .await;
        server.abort();
        assert!(server.await.is_err_and(|error| error.is_cancelled()));
        let failure = result
            .expect("client deadline must precede the outer test deadline")
            .expect_err("stalled request must time out");
        assert!(failure.is_timeout());
    }

    #[test]
    fn build_greeks_maps_option_pricing_including_zero_bid_iv() {
        let ticker: TickerSlimDto = serde_json::from_value(serde_json::json!({
            "A": "1",
            "B": "1",
            "a": "1",
            "b": "1",
            "I": "71760",
            "M": "13289",
            "t": 1_786_606_788_776_u64,
            "option_pricing": {
                "d": "-0.9545",
                "t": "-15.89706",
                "g": "0.00001374",
                "v": "16.42465",
                "i": "0.40474",
                "r": "761.28903",
                "f": "71824",
                "m": "13289",
                "df": "0.999",
                "bi": "0",
                "ai": "0.54578"
            }
        }))
        .expect("fixture ticker");

        let greeks = build_greeks(&ticker);
        assert!((greeks.delta.expect("delta") + 0.9545).abs() < 1e-9);
        assert_eq!(greeks.bid_iv, Some(0.0));
        assert!((greeks.ask_iv.expect("ask_iv") - 0.54578).abs() < 1e-9);
        assert!((greeks.rho.expect("rho") - 761.28903).abs() < 1e-5);
        assert_eq!(greeks.forward_price, Some(71824.0));
        assert_eq!(greeks.option_model_mark, Some(13289.0));
        assert!((greeks.discount_factor.expect("df") - 0.999).abs() < 1e-9);
    }

    #[test]
    fn build_greeks_default_without_option_pricing() {
        let ticker: TickerSlimDto = serde_json::from_value(serde_json::json!({
            "A": "1",
            "B": "1",
            "a": "1",
            "b": "1",
            "I": "100",
            "M": "50",
            "t": 1_786_606_788_776_u64,
            "option_pricing": null
        }))
        .expect("fixture ticker");

        let greeks = build_greeks(&ticker);
        assert_eq!(greeks.delta, None);
        assert_eq!(greeks.iv, None);
    }

    #[test]
    fn compute_moneyness_classifies_calls_and_puts_outside_the_atm_band() {
        assert_eq!(
            compute_moneyness(OptionKind::Call, 60000.0, 70000.0),
            Moneyness::InTheMoney
        );
        assert_eq!(
            compute_moneyness(OptionKind::Call, 80000.0, 70000.0),
            Moneyness::OutOfTheMoney
        );
        assert_eq!(
            compute_moneyness(OptionKind::Put, 80000.0, 70000.0),
            Moneyness::InTheMoney
        );
        assert_eq!(
            compute_moneyness(OptionKind::Put, 60000.0, 70000.0),
            Moneyness::OutOfTheMoney
        );
    }

    #[test]
    fn compute_moneyness_returns_atm_inside_the_tolerance_band() {
        // |70100 - 70000| / 70000 = 0.0014, which is below ATM_TOLERANCE (0.005).
        assert_eq!(
            compute_moneyness(OptionKind::Call, 70100.0, 70000.0),
            Moneyness::AtTheMoney
        );
        assert_eq!(
            compute_moneyness(OptionKind::Put, 69900.0, 70000.0),
            Moneyness::AtTheMoney
        );
    }

    #[test]
    fn compute_moneyness_treats_nonpositive_spot_as_atm() {
        assert_eq!(
            compute_moneyness(OptionKind::Call, 70000.0, 0.0),
            Moneyness::AtTheMoney
        );
        assert_eq!(
            compute_moneyness(OptionKind::Put, 70000.0, -5.0),
            Moneyness::AtTheMoney
        );
    }

    #[test]
    fn parse_optional_number_treats_zero_and_garbage_as_absent() {
        assert_eq!(parse_optional_number("0"), None);
        assert_eq!(parse_optional_number("0.0"), None);
        assert_eq!(parse_optional_number("not-a-number"), None);
        assert_eq!(parse_optional_number("12.5"), Some(12.5));
        assert_eq!(parse_optional_number("-3.25"), Some(-3.25));
    }

    #[test]
    fn parse_instrument_from_channel_requires_three_segment_ticker_slim() {
        assert_eq!(
            parse_instrument_from_channel("ticker_slim.BTC-20240101-70000-C.100"),
            Some("BTC-20240101-70000-C".to_string())
        );
        assert_eq!(parse_instrument_from_channel("orderbook.BTC.100"), None);
        assert_eq!(parse_instrument_from_channel("ticker_slim.BTC"), None);
    }

    #[test]
    fn build_tab_snapshot_dedups_strikes_and_selects_first_positive_spot() {
        let expiry = Utc
            .timestamp_opt(1_700_000_000, 0)
            .single()
            .expect("valid timestamp");
        let metas = vec![
            InstrumentMeta {
                instrument_name: "BTC-C-70000".to_string(),
                kind: OptionKind::Call,
                strike: 70000.0,
                expiry,
                expiry_unix: 1_700_000_000,
            },
            InstrumentMeta {
                instrument_name: "BTC-P-70000".to_string(),
                kind: OptionKind::Put,
                strike: 70000.0,
                expiry,
                expiry_unix: 1_700_000_000,
            },
            InstrumentMeta {
                instrument_name: "BTC-C-71000".to_string(),
                kind: OptionKind::Call,
                strike: 71000.0,
                expiry,
                expiry_unix: 1_700_000_000,
            },
        ];

        let mut instrument_by_name = HashMap::new();
        let mut names = Vec::new();
        for meta in &metas {
            instrument_by_name.insert(meta.instrument_name.clone(), meta.clone());
            names.push(meta.instrument_name.clone());
        }
        let mut names_by_expiry_unix = HashMap::new();
        names_by_expiry_unix.insert(1_700_000_000, names);
        let catalogue = OptionsCatalogue {
            instrument_by_name,
            names_by_expiry_unix,
            expiry_unix_sorted_asc: vec![1_700_000_000],
        };

        let mut quote_map: HashMap<String, QuoteState> = HashMap::new();
        quote_map.insert(
            "BTC-C-70000".to_string(),
            QuoteState {
                spot: 70500.0,
                greeks: OptionGreeks {
                    delta: Some(0.4),
                    ..OptionGreeks::default()
                },
                ..QuoteState::default()
            },
        );

        let snapshot = build_tab_snapshot("BTC", &catalogue, Some(1_700_000_000), &quote_map);

        assert_eq!(snapshot.strikes, vec![70000.0, 71000.0]);
        assert!((snapshot.spot_price - 70500.0).abs() < 1e-9);
        assert_eq!(snapshot.quotes.len(), 3);
    }

    #[test]
    fn build_bootstrap_includes_assets_and_default_expiry() {
        let expiry = Utc
            .timestamp_opt(1_700_000_000, 0)
            .single()
            .expect("valid timestamp");
        let meta = InstrumentMeta {
            instrument_name: "ETH-C-3000".to_string(),
            kind: OptionKind::Call,
            strike: 3000.0,
            expiry,
            expiry_unix: 1_700_000_000,
        };
        let mut instrument_by_name = HashMap::new();
        instrument_by_name.insert(meta.instrument_name.clone(), meta.clone());
        let mut names_by_expiry_unix = HashMap::new();
        names_by_expiry_unix.insert(1_700_000_000, vec![meta.instrument_name]);
        let catalogue = OptionsCatalogue {
            instrument_by_name,
            names_by_expiry_unix,
            expiry_unix_sorted_asc: vec![1_700_000_000],
        };
        let assets = vec!["BTC".to_string(), "ETH".to_string()];
        let bootstrap = build_bootstrap(&catalogue, "ETH", &assets);
        assert_eq!(bootstrap.asset, "ETH");
        assert_eq!(bootstrap.assets, assets);
        assert_eq!(bootstrap.default_expiry_unix, Some(1_700_000_000));
        assert_eq!(bootstrap.tabs.len(), 1);
    }

    fn instrument_row(name: &str, expiry_unix: u64, strike: &str, active: bool) -> InstrumentDto {
        serde_json::from_value(serde_json::json!({
            "instrument_name": name,
            "is_active": active,
            "option_details": {
                "option_type": "C",
                "strike": strike,
                "expiry": expiry_unix
            }
        }))
        .expect("instrument dto")
    }

    #[test]
    fn is_open_expiry_requires_timestamp_strictly_in_the_future() {
        assert!(!is_open_expiry(1_786_694_400, 1_786_694_400));
        assert!(!is_open_expiry(1_786_694_400, 1_786_694_401));
        assert!(is_open_expiry(1_786_867_200, 1_786_780_800));
    }

    #[test]
    fn catalogue_from_instruments_drops_inactive_and_already_expired_rows() {
        let catalogue = catalogue_from_instruments(
            vec![
                instrument_row("BTC-20260814-64000-C", 1_786_694_400, "64000", true),
                instrument_row("BTC-20260816-64000-C", 1_786_867_200, "64000", true),
                instrument_row("BTC-20260816-65000-C", 1_786_867_200, "65000", false),
            ],
            1_786_780_800,
        )
        .expect("catalogue");

        assert_eq!(catalogue.expiry_unix_sorted_asc, vec![1_786_867_200]);
        assert!(catalogue_has_active_options(&catalogue));
        assert!(
            catalogue
                .instrument_by_name
                .contains_key("BTC-20260816-64000-C")
        );
        assert!(
            !catalogue
                .instrument_by_name
                .contains_key("BTC-20260814-64000-C")
        );
        assert!(
            !catalogue
                .instrument_by_name
                .contains_key("BTC-20260816-65000-C")
        );
    }

    #[test]
    fn catalogue_from_instruments_with_only_closed_expiries_has_no_active_options() {
        let catalogue = catalogue_from_instruments(
            vec![instrument_row(
                "BTC-20260814-64000-C",
                1_786_694_400,
                "64000",
                true,
            )],
            1_786_780_800,
        )
        .expect("catalogue");

        assert!(catalogue.expiry_unix_sorted_asc.is_empty());
        assert!(!catalogue_has_active_options(&catalogue));
        assert!(catalogue.instrument_by_name.is_empty());
    }

    #[test]
    fn prune_closed_expiries_removes_past_tabs_and_keeps_open_ones() {
        let now = 1_786_780_800;
        let closed = 1_786_694_400;
        let open = 1_786_867_200;
        let expiry = Utc
            .timestamp_opt(open, 0)
            .single()
            .expect("valid timestamp");
        let closed_expiry = Utc
            .timestamp_opt(closed, 0)
            .single()
            .expect("valid timestamp");
        let mut instrument_by_name = HashMap::new();
        instrument_by_name.insert(
            "BTC-CLOSED".to_string(),
            InstrumentMeta {
                instrument_name: "BTC-CLOSED".to_string(),
                kind: OptionKind::Call,
                strike: 64_000.0,
                expiry: closed_expiry,
                expiry_unix: closed,
            },
        );
        instrument_by_name.insert(
            "BTC-OPEN".to_string(),
            InstrumentMeta {
                instrument_name: "BTC-OPEN".to_string(),
                kind: OptionKind::Call,
                strike: 64_000.0,
                expiry,
                expiry_unix: open,
            },
        );
        let mut names_by_expiry_unix = HashMap::new();
        names_by_expiry_unix.insert(closed, vec!["BTC-CLOSED".to_string()]);
        names_by_expiry_unix.insert(open, vec!["BTC-OPEN".to_string()]);
        let catalogue = OptionsCatalogue {
            instrument_by_name,
            names_by_expiry_unix,
            expiry_unix_sorted_asc: vec![closed, open],
        };

        let pruned = prune_closed_expiries(&catalogue, now);

        assert_eq!(pruned.expiry_unix_sorted_asc, vec![open]);
        assert_eq!(
            pruned.names_by_expiry_unix.get(&open),
            Some(&vec!["BTC-OPEN".to_string()])
        );
        assert!(!pruned.instrument_by_name.contains_key("BTC-CLOSED"));
        assert!(pruned.instrument_by_name.contains_key("BTC-OPEN"));
    }

    fn testnet_rest_ticker_json() -> serde_json::Value {
        serde_json::json!({
            "t": 1_786_606_788_776_u64,
            "A": "0",
            "a": "0",
            "B": "0",
            "b": "0",
            "f": null,
            "option_pricing": {
                "d": "0.67333",
                "t": "0",
                "g": "0",
                "v": "0",
                "i": "0.23009",
                "r": "0.03562",
                "f": "63928",
                "m": "927",
                "df": "0.998",
                "bi": "0",
                "ai": "0"
            },
            "I": "63818",
            "M": "927",
            "stats": {
                "c": "0.063",
                "v": "3999.453",
                "pr": "33.948",
                "n": 4,
                "oi": "0.031",
                "h": "629",
                "l": "402",
                "p": "-0.12"
            },
            "minp": "1",
            "maxp": "2664"
        })
    }

    fn ticker_from_ws_text(text: &str) -> Option<TickerSlimDto> {
        let notification: WsNotification = serde_json::from_str(text).ok()?;
        let (_channel, data) = extract_notification_parts(&notification)?;
        Some(data.ticker().clone())
    }

    #[test]
    fn expiry_date_yyyymmdd_formats_utc_calendar_day() {
        assert_eq!(
            expiry_date_yyyymmdd(1_700_000_000).expect("valid expiry"),
            "20231114"
        );
    }

    #[test]
    fn quote_state_from_rest_slim_ticker_keeps_spot_mark_and_greeks_when_book_is_empty() {
        let ticker: TickerSlimDto =
            serde_json::from_value(testnet_rest_ticker_json()).expect("rest slim ticker");
        let state = quote_state_from_ticker(&ticker);

        assert_eq!(state.bid, None);
        assert_eq!(state.ask, None);
        assert_eq!(state.mark, Some(927.0));
        assert!((state.spot - 63818.0).abs() < 1e-9);
        assert!((state.greeks.delta.expect("delta") - 0.67333).abs() < 1e-9);
        assert!((state.greeks.iv.expect("iv") - 0.23009).abs() < 1e-9);
        assert_eq!(state.greeks.option_model_mark, Some(927.0));
    }

    #[test]
    fn quote_state_falls_back_to_model_mark_when_venue_mark_is_zero() {
        let mut payload = testnet_rest_ticker_json();
        payload["M"] = serde_json::json!("0");
        let ticker: TickerSlimDto = serde_json::from_value(payload).expect("ticker");
        let state = quote_state_from_ticker(&ticker);
        assert_eq!(state.mark, Some(927.0));
        assert!((state.spot - 63818.0).abs() < 1e-9);
    }

    #[test]
    fn upsert_quote_keeps_seeded_spot_when_live_tick_has_no_index() {
        let mut quote_map: HashMap<String, QuoteState> = HashMap::new();
        upsert_quote(
            &mut quote_map,
            "BTC-C".to_string(),
            QuoteState {
                spot: 63818.0,
                mark: Some(927.0),
                ..QuoteState::default()
            },
        );
        for (index, spot) in [0.0, -1.0, f64::NAN, f64::INFINITY].into_iter().enumerate() {
            upsert_quote(
                &mut quote_map,
                "BTC-C".to_string(),
                QuoteState {
                    snapshot_timestamp_ms: u64::try_from(index).expect("fixture index") + 1,
                    spot,
                    bid: Some(928.0),
                    ask: Some(932.0),
                    mark: Some(930.0),
                    greeks: OptionGreeks {
                        delta: Some(0.7),
                        ..OptionGreeks::default()
                    },
                    ..QuoteState::default()
                },
            );

            let state = quote_map.get("BTC-C").expect("seeded quote");
            assert!((state.spot - 63818.0).abs() < 1e-9);
            assert_eq!(state.bid, Some(928.0));
            assert_eq!(state.ask, Some(932.0));
            assert_eq!(state.mark, Some(930.0));
            assert_eq!(state.greeks.delta, Some(0.7));
        }
    }

    #[test]
    fn upsert_quote_replaces_seed_when_live_tick_has_spot() {
        let mut quote_map: HashMap<String, QuoteState> = HashMap::new();
        upsert_quote(
            &mut quote_map,
            "BTC-C".to_string(),
            QuoteState {
                spot: 63818.0,
                mark: Some(927.0),
                ..QuoteState::default()
            },
        );
        upsert_quote(
            &mut quote_map,
            "BTC-C".to_string(),
            QuoteState {
                snapshot_timestamp_ms: 1,
                spot: 63820.0,
                mark: Some(930.0),
                ..QuoteState::default()
            },
        );

        let state = quote_map.get("BTC-C").expect("live quote");
        assert!((state.spot - 63820.0).abs() < 1e-9);
        assert_eq!(state.mark, Some(930.0));
    }

    #[test]
    fn buffered_ticks_cannot_overwrite_a_newer_rest_seed() {
        for delta in [-1_i64, 0, 1] {
            let seed: TickerSlimDto =
                serde_json::from_value(testnet_rest_ticker_json()).expect("REST seed");
            let mut incoming = testnet_rest_ticker_json();
            incoming["t"] = serde_json::json!(
                seed.snapshot_timestamp_ms
                    .checked_add_signed(delta)
                    .expect("fixture timestamp")
            );
            incoming["M"] = serde_json::json!("930");
            let ticker: TickerSlimDto = serde_json::from_value(incoming).expect("buffered tick");
            let mut quotes = HashMap::new();
            seed_quote_map(&mut quotes, HashMap::from([("BTC-C".to_string(), seed)]));
            upsert_quote(
                &mut quotes,
                "BTC-C".to_string(),
                quote_state_from_ticker(&ticker),
            );

            let quote = quotes.get("BTC-C").expect("quote");
            assert_eq!(quote.mark, Some(if delta > 0 { 930.0 } else { 927.0 }));
        }
    }

    #[test]
    fn ticker_requires_a_nonnegative_venue_snapshot_timestamp() {
        let mut payload = testnet_rest_ticker_json();
        payload.as_object_mut().expect("fixture object").remove("t");
        assert!(serde_json::from_value::<TickerSlimDto>(payload.clone()).is_err());
        payload["t"] = serde_json::json!(-1);
        assert!(serde_json::from_value::<TickerSlimDto>(payload).is_err());
    }

    #[test]
    fn seed_quote_map_inserts_rest_tickers_by_instrument_name() {
        let ticker: TickerSlimDto =
            serde_json::from_value(testnet_rest_ticker_json()).expect("ticker");
        let mut quote_map = HashMap::new();
        seed_quote_map(
            &mut quote_map,
            HashMap::from([("BTC-20260813-63000-C".to_string(), ticker)]),
        );

        let state = quote_map
            .get("BTC-20260813-63000-C")
            .expect("seeded instrument");
        assert!((state.spot - 63818.0).abs() < 1e-9);
        assert_eq!(state.mark, Some(927.0));
    }

    #[test]
    fn ws_notification_accepts_wrapped_instrument_ticker() {
        let ticker = testnet_rest_ticker_json();
        let text = serde_json::json!({
            "channel": "ticker_slim.BTC-20260813-63000-C.100",
            "data": { "instrument_ticker": ticker }
        })
        .to_string();

        let parsed = ticker_from_ws_text(&text).expect("wrapped ticker");
        assert_eq!(parsed.index_price, "63818");
        assert_eq!(parsed.mark_price, "927");
    }

    #[test]
    fn ws_notification_accepts_compact_slim_data() {
        let ticker = testnet_rest_ticker_json();
        let text = serde_json::json!({
            "channel": "ticker_slim.BTC-20260813-63000-C.100",
            "data": ticker
        })
        .to_string();

        let parsed = ticker_from_ws_text(&text).expect("slim ticker");
        assert_eq!(parsed.index_price, "63818");
        assert_eq!(parsed.option_pricing.expect("pricing").delta, "0.67333");
    }
}
