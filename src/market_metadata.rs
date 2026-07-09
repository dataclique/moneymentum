//! Markets metadata: the perp universe with each market's max leverage,
//! stored in `markets.csv`. Refreshes run on server startup (when stale) and
//! via the Nix-triggered `POST /hyperliquid/markets/refresh` endpoint.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use polars::prelude::{
    BooleanType, ChunkFillNullValue, ChunkFull, ChunkedArray, DataFrame, DataType, Int64Type,
    PolarsError, StringChunked, df,
};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::finance::{self, CcxtSymbol, Market};
use crate::hyperliquid::{Hyperliquid, HyperliquidError};

/// Markets metadata is refreshed at most once per day on the server.
pub(crate) const MARKETS_REFRESH_INTERVAL: Duration = Duration::from_hours(24);

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
    /// `true` when Hyperliquid disallows cross margin for the asset.
    pub(crate) only_isolated: bool,
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
    /// `true` when the asset supports only isolated margin.
    pub(crate) only_isolated: bool,
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

pub(crate) async fn markets_need_refresh(data_dir: &Path, ledger: MarketsLedger) -> bool {
    let path = markets_file_path(data_dir, ledger);
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return true;
    };
    let Ok(frame) = crate::dataframe::read_csv(path.clone()).await else {
        return true;
    };
    let Some(frame) = frame else {
        return true;
    };
    let column_names = frame.get_column_names();
    if !column_names
        .iter()
        .any(|column| column.as_str() == "asset_index")
    {
        return true;
    }
    if !column_names
        .iter()
        .any(|column| column.as_str() == "only_isolated")
    {
        return true;
    }
    let Ok(modified_at) = metadata.modified() else {
        return true;
    };
    let age = SystemTime::now()
        .duration_since(modified_at)
        .unwrap_or(MARKETS_REFRESH_INTERVAL);
    age >= MARKETS_REFRESH_INTERVAL
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

fn max_leverage_column(frame: &DataFrame) -> Result<ChunkedArray<Int64Type>, PolarsError> {
    frame
        .column("max_leverage")?
        .cast(&DataType::Int64)?
        .i64()
        .cloned()
}

fn markets_api_response_from_frame(
    frame: &DataFrame,
    refreshed_at: Option<String>,
) -> Result<MarketsApiResponse, MarketsMetadataError> {
    let symbols = frame.column("symbol")?.str()?;
    let max_leverages = max_leverage_column(frame)?;
    let asset_indices = asset_index_column(frame)?;
    let only_isolated_flags = only_isolated_column(frame)?;
    validate_ledger_columns(symbols, &max_leverages, &asset_indices)?;

    let mut tickers = Vec::with_capacity(symbols.len());
    let mut leverage_limits = Vec::with_capacity(symbols.len());

    for index in 0..symbols.len() {
        let (symbol, raw_max_leverage) =
            ledger_symbol_and_max_leverage(index, symbols, &max_leverages)?;
        let raw_asset_index = asset_indices.get(index).ok_or_else(|| {
            MarketsMetadataError::Polars(PolarsError::ComputeError(
                format!("markets ledger row {index} has null asset_index").into(),
            ))
        })?;
        let ccxt_symbol = finance::hyperliquid_swap_ccxt_symbol(symbol);
        let max_leverage = u32::try_from(raw_max_leverage).map_err(|_| {
            MarketsMetadataError::Polars(PolarsError::ComputeError(
                format!("markets ledger row {index} max_leverage out of range").into(),
            ))
        })?;
        let asset_index = u32::try_from(raw_asset_index).map_err(|_| {
            MarketsMetadataError::Polars(PolarsError::ComputeError(
                format!("markets ledger row {index} asset_index out of range").into(),
            ))
        })?;
        let only_isolated = only_isolated_flags.get(index).unwrap_or(false);
        tickers.push(ccxt_symbol.clone());
        leverage_limits.push(LeverageLimitEntry {
            symbol: ccxt_symbol,
            max_leverage,
            asset_index,
            only_isolated,
        });
    }

    tickers.sort_unstable();
    leverage_limits.sort_unstable_by(|left, right| left.symbol.cmp(&right.symbol));

    Ok(MarketsApiResponse {
        tickers,
        leverage_limits,
        refreshed_at,
    })
}

fn asset_index_column(frame: &DataFrame) -> Result<ChunkedArray<Int64Type>, PolarsError> {
    frame
        .column("asset_index")?
        .cast(&DataType::Int64)?
        .i64()
        .cloned()
}

fn only_isolated_column(frame: &DataFrame) -> Result<ChunkedArray<BooleanType>, PolarsError> {
    // Legacy ledgers may omit only_isolated; treat every row as cross-capable.
    if !frame
        .get_column_names()
        .iter()
        .any(|column| column.as_str() == "only_isolated")
    {
        return Ok(ChunkedArray::full(
            "only_isolated".into(),
            false,
            frame.height(),
        ));
    }

    let column = frame
        .column("only_isolated")?
        .cast(&DataType::Boolean)?
        .bool()?
        .clone();

    // Null cells mean "not isolated-only" -- normalize before serving the API.
    column.fill_null_with_values(false)
}

fn validate_ledger_columns(
    symbols: &StringChunked,
    max_leverages: &ChunkedArray<Int64Type>,
    asset_indices: &ChunkedArray<Int64Type>,
) -> Result<(), PolarsError> {
    if symbols.len() != max_leverages.len() || symbols.len() != asset_indices.len() {
        return Err(PolarsError::ComputeError(
            "markets ledger symbol, max_leverage, and asset_index column lengths differ".into(),
        ));
    }
    Ok(())
}

fn ledger_symbol_and_max_leverage<'ledger>(
    index: usize,
    symbols: &'ledger StringChunked,
    max_leverages: &ChunkedArray<Int64Type>,
) -> Result<(&'ledger str, i64), PolarsError> {
    let symbol = symbols.get(index).ok_or_else(|| {
        PolarsError::ComputeError(format!("markets ledger row {index} has null symbol").into())
    })?;
    if symbol.is_empty() {
        return Err(PolarsError::ComputeError(
            format!("markets ledger row {index} has empty symbol").into(),
        ));
    }
    let raw_max_leverage = max_leverages.get(index).ok_or_else(|| {
        PolarsError::ComputeError(
            format!("markets ledger row {index} has null max_leverage").into(),
        )
    })?;
    Ok((symbol, raw_max_leverage))
}

async fn file_modified_at_rfc3339(path: &Path) -> Result<Option<String>, MarketsMetadataError> {
    let metadata = tokio::fs::metadata(path).await?;
    let modified_at = metadata.modified()?;
    let timestamp = chrono::DateTime::<chrono::Utc>::from(modified_at);
    Ok(Some(timestamp.to_rfc3339()))
}

pub(crate) async fn refresh_all_markets_if_stale(
    clients: &crate::hyperliquid::HyperliquidClients,
    data_dir: &Path,
) -> Result<(), MarketsMetadataError> {
    let mut last_error = None;
    for ledger in [MarketsLedger::Mainnet, MarketsLedger::Testnet] {
        if markets_need_refresh(data_dir, ledger).await {
            let _guard = refresh_lock(ledger).lock().await;
            if markets_need_refresh(data_dir, ledger).await
                && let Err(error) =
                    refresh_markets(clients.for_ledger(ledger), data_dir, ledger).await
            {
                warn!(%error, ?ledger, "markets refresh failed for ledger");
                last_error = Some(error);
            }
        }
    }
    // Refresh each stale ledger independently so one ledger's outage does not
    // skip refreshing the others.
    last_error.map_or_else(|| Ok(()), |error| Err(error.into()))
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

fn markets_from_frame(frame: &DataFrame) -> Result<Vec<Market>, PolarsError> {
    let symbols = frame.column("symbol")?.str()?;
    let max_leverages = max_leverage_column(frame)?;
    let asset_indices = asset_index_column(frame)?;
    validate_ledger_columns(symbols, &max_leverages, &asset_indices)?;

    (0..symbols.len())
        .map(|index| {
            let (symbol, _) = ledger_symbol_and_max_leverage(index, symbols, &max_leverages)?;
            Ok(Market::new(symbol.to_string()))
        })
        .collect()
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
    let only_isolated_flags: Vec<bool> =
        fetched.iter().map(|market| market.only_isolated).collect();
    df! {
        "symbol" => symbols,
        "max_leverage" => max_leverages,
        "asset_index" => asset_indices,
        "only_isolated" => only_isolated_flags,
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
            only_isolated: false,
        }
    }

    fn metadata_isolated(symbol: &str, max_leverage: u32, asset_index: u32) -> MarketMetadata {
        MarketMetadata {
            symbol: Market::new(symbol.to_string()),
            max_leverage,
            asset_index,
            only_isolated: true,
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
            ["symbol", "max_leverage", "asset_index", "only_isolated"]
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
            ["symbol", "max_leverage", "asset_index", "only_isolated"]
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
    async fn markets_need_refresh_when_ledger_lacks_asset_index_column() {
        let data_dir = TempDir::new().unwrap();
        // Pre-asset_index ledger schema: a refresh must rebuild it so the
        // asset_index column the API response depends on gets populated.
        let legacy_ledger = df! {
            "symbol" => &["BTC"],
            "max_leverage" => &[50_u32],
            "disable" => &[false],
        }
        .unwrap();
        crate::dataframe::write_csv(
            data_dir.path().join(MarketsLedger::Mainnet.file_name()),
            legacy_ledger,
        )
        .await
        .unwrap();

        assert!(
            markets_need_refresh(data_dir.path(), MarketsLedger::Mainnet).await,
            "a ledger missing the asset_index column must be treated as stale"
        );
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
        assert!(!response.leverage_limits[0].only_isolated);
        assert!(response.refreshed_at.is_some());
    }

    #[tokio::test]
    async fn load_markets_api_response_returns_only_isolated_when_set() {
        let data_dir = TempDir::new().unwrap();
        let client = StubClient {
            metadata: vec![metadata("BTC", 50, 0), metadata_isolated("ANIME", 12, 1)],
        };
        refresh_markets(&client, data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap();

        let response = load_markets_api_response(data_dir.path(), MarketsLedger::Mainnet)
            .await
            .unwrap();

        let anime = response
            .leverage_limits
            .iter()
            .find(|entry| entry.symbol.as_str() == "ANIME/USDC:USDC")
            .unwrap();
        let btc = response
            .leverage_limits
            .iter()
            .find(|entry| entry.symbol.as_str() == "BTC/USDC:USDC")
            .unwrap();
        assert!(anime.only_isolated);
        assert!(!btc.only_isolated);
    }

    #[tokio::test]
    async fn markets_need_refresh_when_ledger_lacks_only_isolated_column() {
        let data_dir = TempDir::new().unwrap();
        let legacy_ledger = df! {
            "symbol" => &["BTC"],
            "max_leverage" => &[50_u32],
            "asset_index" => &[0_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(
            data_dir.path().join(MarketsLedger::Mainnet.file_name()),
            legacy_ledger,
        )
        .await
        .unwrap();

        assert!(
            markets_need_refresh(data_dir.path(), MarketsLedger::Mainnet).await,
            "a ledger missing the only_isolated column must be treated as stale"
        );
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
