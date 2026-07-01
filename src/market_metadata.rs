//! Markets metadata: the perp universe with each market's max leverage,
//! stored in `markets.csv`. Refreshes run on server startup (with exponential
//! backoff until success) and via the Nix-triggered `POST /hyperliquid/markets/refresh`
//! endpoint. Ingestion loads the ledger with the same backoff when the file is
//! not present yet.

use std::future::Future;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::time::Duration;

use polars::prelude::{ChunkedArray, DataFrame, DataType, Int64Type, PolarsError, df};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::finance::{self, CcxtSymbol, Market};
use crate::hyperliquid::{Hyperliquid, HyperliquidError};

/// Daily cadence for HTTP cache headers on `GET /hyperliquid/markets`.
pub(crate) const MARKETS_REFRESH_INTERVAL: Duration = Duration::from_hours(24);

#[cfg(test)]
const MARKETS_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(10);
#[cfg(not(test))]
const MARKETS_RETRY_INITIAL_DELAY: Duration = Duration::from_secs(10);

/// Serializes refreshes per ledger so concurrent requests cannot both pass the
/// staleness check and double-fetch from Hyperliquid or race writes to the same
/// CSV ledger.
static MAINNET_REFRESH_LOCK: Mutex<()> = Mutex::const_new(());
static TESTNET_REFRESH_LOCK: Mutex<()> = Mutex::const_new(());

fn refresh_lock(ledger: MarketsLedger) -> &'static Mutex<()> {
    match ledger {
        MarketsLedger::Mainnet => &MAINNET_REFRESH_LOCK,
        MarketsLedger::Testnet => &TESTNET_REFRESH_LOCK,
    }
}

/// Runs `attempt` repeatedly with exponential backoff (starting at
/// `MARKETS_RETRY_INITIAL_DELAY`, doubling each time) until it returns
/// `ControlFlow::Break`. `ControlFlow::Continue(reason)` schedules a retry and
/// logs `reason` so callers control both the stop condition and the message.
async fn with_backoff<Attempt, Fut, T>(mut attempt: Attempt) -> T
where
    Attempt: FnMut() -> Fut,
    Fut: Future<Output = ControlFlow<T, String>>,
{
    let mut delay = MARKETS_RETRY_INITIAL_DELAY;

    loop {
        match attempt().await {
            ControlFlow::Break(value) => return value,
            ControlFlow::Continue(reason) => {
                warn!(reason, retry_in_ms = delay.as_millis(), "retry scheduled");
                tokio::time::sleep(delay).await;
                delay = delay.saturating_mul(2);
            }
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum MarketsMetadataError {
    #[error(transparent)]
    Hyperliquid(#[from] HyperliquidError),
    #[error(transparent)]
    DataFrame(#[from] crate::dataframe::DataFrameError),
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error("markets metadata file is missing")]
    MissingFile,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LeverageLimitEntry {
    pub(crate) symbol: CcxtSymbol,
    pub(crate) max_leverage: u32,
    pub(crate) asset_index: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketsApiResponse {
    pub(crate) tickers: Vec<CcxtSymbol>,
    pub(crate) leverage_limits: Vec<LeverageLimitEntry>,
    pub(crate) refreshed_at: Option<String>,
}

/// A market's exchange metadata as fetched from Hyperliquid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MarketMetadata {
    pub(crate) symbol: Market,
    pub(crate) max_leverage: u32,
    pub(crate) asset_index: u32,
}

/// Hyperliquid deployment whose perp universe is stored in the data directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarketsLedger {
    Mainnet,
    Testnet,
}

impl MarketsLedger {
    pub(crate) fn file_name(self) -> &'static str {
        match self {
            Self::Mainnet => "markets.csv",
            Self::Testnet => "testnet_markets.csv",
        }
    }

    pub(crate) fn parse_query(value: &str) -> Option<Self> {
        match value {
            "mainnet" => Some(Self::Mainnet),
            "testnet" => Some(Self::Testnet),
            _ => None,
        }
    }
}

/// Refreshes `markets.csv` from the live exchange and returns the current
/// perp universe. Ingestion consumes the returned list directly.
pub(crate) async fn refresh_markets(
    client: &dyn Hyperliquid,
    data_dir: &Path,
    ledger: MarketsLedger,
) -> Result<Vec<Market>, HyperliquidError> {
    let fetched = client.fetch_market_metadata().await?;
    let path = data_dir.join(ledger.file_name());
    let frame = build_markets_frame(&fetched)?;
    let markets = markets_from_frame(&frame)?;
    crate::dataframe::write_csv(path, frame).await?;
    info!(
        markets = markets.len(),
        ledger = ?ledger,
        "markets metadata refreshed"
    );
    Ok(markets)
}

pub(crate) fn markets_file_path(data_dir: &Path, ledger: MarketsLedger) -> PathBuf {
    data_dir.join(ledger.file_name())
}

/// Loads the perp universe from the on-disk ledger. Ingestion consumes this
/// list directly; it does not refresh markets from Hyperliquid.
pub(crate) async fn load_markets(
    data_dir: &Path,
    ledger: MarketsLedger,
) -> Result<Vec<Market>, MarketsMetadataError> {
    let path = markets_file_path(data_dir, ledger);
    let frame = crate::dataframe::read_csv(path)
        .await?
        .ok_or(MarketsMetadataError::MissingFile)?;
    markets_from_frame(&frame).map_err(MarketsMetadataError::Polars)
}

/// Loads the on-disk ledger, retrying with exponential backoff when the CSV is
/// not present yet (for example before startup refresh or the midnight job).
pub(crate) async fn load_markets_with_backoff(
    data_dir: &Path,
    ledger: MarketsLedger,
) -> Result<Vec<Market>, MarketsMetadataError> {
    with_backoff(move || async move {
        match load_markets(data_dir, ledger).await {
            Ok(markets) => {
                info!(?ledger, markets = markets.len(), "markets ledger loaded");
                ControlFlow::Break(Ok(markets))
            }
            Err(MarketsMetadataError::MissingFile) => {
                ControlFlow::Continue(format!("{ledger:?} markets ledger file missing"))
            }
            Err(error) => ControlFlow::Break(Err(error)),
        }
    })
    .await
}

pub(crate) async fn load_markets_api_response(
    data_dir: &Path,
    ledger: MarketsLedger,
) -> Result<MarketsApiResponse, MarketsMetadataError> {
    let path = markets_file_path(data_dir, ledger);
    let frame = crate::dataframe::read_csv(path.clone())
        .await?
        .ok_or(MarketsMetadataError::MissingFile)?;
    let refreshed_at = file_modified_at_rfc3339(&path).await?;
    markets_api_response_from_frame(&frame, refreshed_at)
}

/// A single validated ledger row: the raw Hyperliquid symbol plus its numeric
/// columns, with nulls and out-of-range values already rejected.
struct LedgerRow {
    symbol: String,
    max_leverage: u32,
    asset_index: u32,
}

fn extract_i64_column(
    frame: &DataFrame,
    name: &str,
) -> Result<ChunkedArray<Int64Type>, PolarsError> {
    frame.column(name)?.cast(&DataType::Int64)?.i64().cloned()
}

fn parse_u32_cell(value: Option<i64>, index: usize, column: &str) -> Result<u32, PolarsError> {
    let raw = value.ok_or_else(|| {
        PolarsError::ComputeError(format!("markets ledger row {index} has null {column}").into())
    })?;
    u32::try_from(raw).map_err(|_| {
        PolarsError::ComputeError(
            format!("markets ledger row {index} {column} out of range").into(),
        )
    })
}

/// Parses the ledger frame into validated rows. Zipping the columns together
/// means mismatched lengths simply produce fewer rows instead of panicking, so
/// no separate length check is needed.
fn parse_ledger_rows(frame: &DataFrame) -> Result<Vec<LedgerRow>, PolarsError> {
    let symbols = frame.column("symbol")?.str()?;
    let max_leverages = extract_i64_column(frame, "max_leverage")?;
    let asset_indices = extract_i64_column(frame, "asset_index")?;

    symbols
        .iter()
        .zip(max_leverages.iter())
        .zip(asset_indices.iter())
        .enumerate()
        .map(|(index, ((symbol, max_leverage), asset_index))| {
            let symbol = symbol.ok_or_else(|| {
                PolarsError::ComputeError(
                    format!("markets ledger row {index} has null symbol").into(),
                )
            })?;
            if symbol.is_empty() {
                return Err(PolarsError::ComputeError(
                    format!("markets ledger row {index} has empty symbol").into(),
                ));
            }
            Ok(LedgerRow {
                symbol: symbol.to_string(),
                max_leverage: parse_u32_cell(max_leverage, index, "max_leverage")?,
                asset_index: parse_u32_cell(asset_index, index, "asset_index")?,
            })
        })
        .collect()
}

fn markets_api_response_from_frame(
    frame: &DataFrame,
    refreshed_at: Option<String>,
) -> Result<MarketsApiResponse, MarketsMetadataError> {
    let mut leverage_limits: Vec<LeverageLimitEntry> = parse_ledger_rows(frame)?
        .into_iter()
        .map(|row| LeverageLimitEntry {
            symbol: finance::hyperliquid_swap_ccxt_symbol(&row.symbol),
            max_leverage: row.max_leverage,
            asset_index: row.asset_index,
        })
        .collect();

    leverage_limits.sort_unstable_by(|left, right| left.symbol.cmp(&right.symbol));

    let tickers = leverage_limits
        .iter()
        .map(|entry| entry.symbol.clone())
        .collect();

    Ok(MarketsApiResponse {
        tickers,
        leverage_limits,
        refreshed_at,
    })
}

async fn file_modified_at_rfc3339(path: &Path) -> Result<Option<String>, MarketsMetadataError> {
    let metadata = tokio::fs::metadata(path).await?;
    let modified_at = metadata.modified()?;
    let timestamp = chrono::DateTime::<chrono::Utc>::from(modified_at);
    Ok(Some(timestamp.to_rfc3339()))
}

pub(crate) async fn refresh_all_markets(
    clients: &crate::hyperliquid::HyperliquidClients,
    data_dir: &Path,
) -> Result<(), MarketsMetadataError> {
    let mut any_succeeded = false;
    let mut last_error = None;
    for ledger in [MarketsLedger::Mainnet, MarketsLedger::Testnet] {
        let _guard = refresh_lock(ledger).lock().await;
        match refresh_markets(clients.for_ledger(ledger), data_dir, ledger).await {
            Ok(_markets) => any_succeeded = true,
            Err(error) => {
                warn!(%error, ?ledger, "markets refresh failed for ledger");
                last_error = Some(error);
            }
        }
    }
    // Refresh each ledger independently so one ledger's outage does not abort
    // the others; only fail when every ledger failed.
    match last_error {
        Some(error) if !any_succeeded => Err(error.into()),
        _ => Ok(()),
    }
}

/// Refreshes both ledgers, retrying with exponential backoff until at least one
/// ledger succeeds.
pub(crate) async fn refresh_all_markets_until_success(
    clients: &crate::hyperliquid::HyperliquidClients,
    data_dir: &Path,
) {
    with_backoff(move || async move {
        match refresh_all_markets(clients, data_dir).await {
            Ok(()) => ControlFlow::Break(()),
            Err(error) => {
                ControlFlow::Continue(format!("markets metadata refresh failed: {error}"))
            }
        }
    })
    .await;
    info!("markets metadata refresh succeeded");
}

fn markets_from_frame(frame: &DataFrame) -> Result<Vec<Market>, PolarsError> {
    Ok(parse_ledger_rows(frame)?
        .into_iter()
        .map(|row| Market::new(row.symbol))
        .collect())
}

fn build_markets_frame(fetched: &[MarketMetadata]) -> Result<DataFrame, PolarsError> {
    let mut seen_symbols = std::collections::HashSet::new();
    for market in fetched {
        let symbol = market.symbol.as_str();
        if !seen_symbols.insert(symbol) {
            return Err(PolarsError::ComputeError(
                format!("duplicate market symbol in fetched metadata: {symbol}").into(),
            ));
        }
    }

    let symbols: Vec<&str> = fetched
        .iter()
        .map(|market| market.symbol.as_str())
        .collect();
    let max_leverages: Vec<u32> = fetched.iter().map(|market| market.max_leverage).collect();
    let asset_indices: Vec<u32> = fetched.iter().map(|market| market.asset_index).collect();
    df! {
        "symbol" => symbols,
        "max_leverage" => max_leverages,
        "asset_index" => asset_indices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use tempfile::TempDir;
    use tracing::Level;
    use tracing_test::traced_test;

    use crate::candle::Candle;
    use crate::funding::FundingRate;
    use crate::timeframe::Timeframe;

    fn metadata(symbol: &str, max_leverage: u32, asset_index: u32) -> MarketMetadata {
        MarketMetadata {
            symbol: Market::new(symbol.to_string()),
            max_leverage,
            asset_index,
        }
    }

    struct StubClient {
        metadata: Vec<MarketMetadata>,
    }

    #[async_trait]
    impl Hyperliquid for StubClient {
        async fn fetch_market_metadata(&self) -> Result<Vec<MarketMetadata>, HyperliquidError> {
            Ok(self.metadata.clone())
        }

        async fn fetch_candles(
            &self,
            _market: &Market,
            _timeframe: Timeframe,
            _start: DateTime<Utc>,
        ) -> Result<Vec<Candle>, HyperliquidError> {
            Ok(vec![])
        }

        async fn fetch_funding_rates(
            &self,
            _market: &Market,
            _start: DateTime<Utc>,
        ) -> Result<Vec<FundingRate>, HyperliquidError> {
            Ok(vec![])
        }
    }

    #[test]
    fn build_markets_frame_writes_symbol_and_max_leverage() {
        let fetched = [metadata("BTC", 50, 0), metadata("ETH", 25, 1)];

        let frame = build_markets_frame(&fetched).unwrap();

        assert_eq!(frame.height(), 2);
        assert_eq!(
            frame.get_column_names(),
            ["symbol", "max_leverage", "asset_index"]
        );
        let symbols = frame.column("symbol").unwrap().str().unwrap();
        let leverage = frame.column("max_leverage").unwrap().u32().unwrap();
        assert_eq!(symbols.get(0), Some("BTC"));
        assert_eq!(symbols.get(1), Some("ETH"));
        assert_eq!(leverage.get(0), Some(50));
        assert_eq!(leverage.get(1), Some(25));
    }

    #[test]
    fn build_markets_frame_rejects_duplicate_symbols() {
        let fetched = [metadata("BTC", 50, 0), metadata("BTC", 25, 1)];

        let error = build_markets_frame(&fetched).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("duplicate market symbol in fetched metadata: BTC")
        );
    }

    #[test]
    fn markets_from_frame_maps_all_rows() {
        let frame = df! {
            "symbol" => &["BTC", "ETH"],
            "max_leverage" => &[50_u32, 25],
            "asset_index" => &[0_u32, 1],
        }
        .unwrap();

        let markets = markets_from_frame(&frame).unwrap();

        assert_eq!(
            markets.iter().map(Market::as_str).collect::<Vec<_>>(),
            vec!["BTC", "ETH"]
        );
    }

    #[traced_test]
    #[tokio::test]
    async fn refresh_writes_markets_csv_from_exchange() {
        let data_dir = TempDir::new().unwrap();
        let client = StubClient {
            metadata: vec![metadata("BTC", 50, 0), metadata("ETH", 25, 1)],
        };

        let markets = refresh_markets(&client, data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap();
        assert_eq!(
            markets.iter().map(Market::as_str).collect::<Vec<_>>(),
            vec!["BTC", "ETH"]
        );
        assert!(data_dir.path().join("markets.csv").exists());
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["markets metadata refreshed"]
        ));

        let reloaded =
            crate::dataframe::read_csv(data_dir.path().join(MarketsLedger::Mainnet.file_name()))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            reloaded.get_column_names(),
            ["symbol", "max_leverage", "asset_index"]
        );
    }

    #[traced_test]
    #[tokio::test]
    async fn refresh_discovers_markets_from_the_exchange_not_the_ledger() {
        let data_dir = TempDir::new().unwrap();
        let stale_ledger = df! {
            "symbol" => &["SOL"],
            "max_leverage" => &[20_u32],
            "asset_index" => &[0_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(
            data_dir.path().join(MarketsLedger::Mainnet.file_name()),
            stale_ledger,
        )
        .await
        .unwrap();

        let client = StubClient {
            metadata: vec![
                metadata("BTC", 50, 0),
                metadata("ETH", 25, 1),
                metadata("SOL", 20, 2),
            ],
        };

        let markets = refresh_markets(&client, data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap();
        let symbols: Vec<&str> = markets.iter().map(Market::as_str).collect();

        assert_eq!(markets.len(), 3);
        assert!(symbols.contains(&"BTC"));
        assert!(symbols.contains(&"ETH"));
        assert!(symbols.contains(&"SOL"));
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["markets metadata refreshed"]
        ));
    }

    #[tokio::test]
    async fn load_markets_api_response_returns_ccxt_symbols_and_leverage_limits() {
        let data_dir = TempDir::new().unwrap();
        let frame = df! {
            "symbol" => &["ETH", "BTC"],
            "max_leverage" => &[25_u32, 50],
            "asset_index" => &[1_u32, 0],
        }
        .unwrap();
        crate::dataframe::write_csv(
            data_dir.path().join(MarketsLedger::Mainnet.file_name()),
            frame,
        )
        .await
        .unwrap();

        let response = load_markets_api_response(data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap();

        assert_eq!(
            response
                .tickers
                .iter()
                .map(CcxtSymbol::as_str)
                .collect::<Vec<_>>(),
            vec!["BTC/USDC:USDC", "ETH/USDC:USDC"]
        );
        assert_eq!(response.leverage_limits.len(), 2);
        assert_eq!(response.leverage_limits[0].symbol.as_str(), "BTC/USDC:USDC");
        assert_eq!(response.leverage_limits[0].max_leverage, 50);
        assert_eq!(response.leverage_limits[0].asset_index, 0);
        assert!(response.refreshed_at.is_some());
    }

    #[tokio::test]
    async fn load_markets_api_response_uppercases_mixed_case_hyperliquid_names() {
        let data_dir = TempDir::new().unwrap();
        let frame = df! {
            "symbol" => &["kPEPE"],
            "max_leverage" => &[10_u32],
            "asset_index" => &[0_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(
            data_dir.path().join(MarketsLedger::Mainnet.file_name()),
            frame,
        )
        .await
        .unwrap();

        let response = load_markets_api_response(data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap();

        assert_eq!(
            response
                .tickers
                .iter()
                .map(CcxtSymbol::as_str)
                .collect::<Vec<_>>(),
            vec!["KPEPE/USDC:USDC"]
        );
        assert_eq!(
            response.leverage_limits[0].symbol.as_str(),
            "KPEPE/USDC:USDC"
        );
    }

    #[tokio::test]
    async fn load_markets_api_response_rejects_null_symbol_rows() {
        let data_dir = TempDir::new().unwrap();
        let frame = df! {
            "symbol" => &[Some("BTC"), None],
            "max_leverage" => &[50_i64, 25],
            "asset_index" => &[0_i64, 1],
        }
        .unwrap();
        crate::dataframe::write_csv(
            data_dir.path().join(MarketsLedger::Mainnet.file_name()),
            frame,
        )
        .await
        .unwrap();

        let error = load_markets_api_response(data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap_err();

        assert!(matches!(error, MarketsMetadataError::Polars(_)));
        assert!(error.to_string().contains("null symbol"));
    }

    #[tokio::test]
    async fn load_markets_api_response_rejects_null_max_leverage_rows() {
        let data_dir = TempDir::new().unwrap();
        let frame = df! {
            "symbol" => &["BTC", "ETH"],
            "max_leverage" => &[Some(50_i64), None],
            "asset_index" => &[0_i64, 1],
        }
        .unwrap();
        crate::dataframe::write_csv(
            data_dir.path().join(MarketsLedger::Mainnet.file_name()),
            frame,
        )
        .await
        .unwrap();

        let error = load_markets_api_response(data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap_err();

        assert!(matches!(error, MarketsMetadataError::Polars(_)));
        assert!(error.to_string().contains("null max_leverage"));
    }

    #[tokio::test]
    async fn load_markets_api_response_formats_colon_names_like_ccxt() {
        let data_dir = TempDir::new().unwrap();
        let frame = df! {
            "symbol" => &["flx:crcl"],
            "max_leverage" => &[5_u32],
            "asset_index" => &[0_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(
            data_dir.path().join(MarketsLedger::Mainnet.file_name()),
            frame,
        )
        .await
        .unwrap();

        let response = load_markets_api_response(data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap();

        assert_eq!(
            response
                .tickers
                .iter()
                .map(CcxtSymbol::as_str)
                .collect::<Vec<_>>(),
            vec!["FLX-CRCL/USDC:USDC"]
        );
    }
}
