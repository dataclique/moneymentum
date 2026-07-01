//! Markets metadata: the perp universe with each market's max leverage, stored
//! in `markets.csv` as a restart cache. At startup the on-disk cache is loaded
//! into memory, any missing ledgers are fetched from Hyperliquid before the
//! service accepts traffic, and a background task refreshes both ledgers every
//! UTC midnight. HTTP serves from the in-memory store. The CSV is best-effort:
//! a successful fetch updates memory even when the disk write fails.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use polars::prelude::{ChunkedArray, DataFrame, DataType, Int64Type, PolarsError, df};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::finance::{self, CcxtSymbol, Market};
use crate::hyperliquid::{Hyperliquid, HyperliquidError};

const SECONDS_PER_DAY: u64 = 86_400;

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
    #[error("markets ledger not ready: {0:?}")]
    LedgerNotReady(MarketsLedger),
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

/// In-memory markets ledgers served by HTTP routes.
pub(crate) struct MarketsStore {
    mainnet: RwLock<Option<MarketsApiResponse>>,
    testnet: RwLock<Option<MarketsApiResponse>>,
}

impl MarketsStore {
    pub(crate) fn empty() -> Self {
        Self {
            mainnet: RwLock::new(None),
            testnet: RwLock::new(None),
        }
    }

    /// Reads any cached ledgers from disk into memory. Missing caches are fine:
    /// the background refresh repopulates them from the live exchange.
    pub(crate) async fn load_from_disk(data_dir: &Path) -> Arc<Self> {
        let store = Arc::new(Self::empty());
        for ledger in [MarketsLedger::Mainnet, MarketsLedger::Testnet] {
            match load_ledger_from_disk(data_dir, ledger).await {
                Ok(response) => {
                    info!(
                        ?ledger,
                        markets = response.leverage_limits.len(),
                        "markets ledger loaded from disk cache"
                    );
                    store.set_ledger(ledger, response).await;
                }
                Err(MarketsMetadataError::MissingFile) => {
                    debug!(?ledger, "markets ledger disk cache missing");
                }
                Err(error) => {
                    warn!(%error, ?ledger, "markets ledger disk cache load failed");
                }
            }
        }
        store
    }

    pub(crate) async fn set_ledger(&self, ledger: MarketsLedger, response: MarketsApiResponse) {
        ledger_lock(self, ledger).write().await.replace(response);
    }

    pub(crate) async fn api_response(&self, ledger: MarketsLedger) -> Option<MarketsApiResponse> {
        ledger_lock(self, ledger).read().await.as_ref().cloned()
    }
}

fn ledger_lock(store: &MarketsStore, ledger: MarketsLedger) -> &RwLock<Option<MarketsApiResponse>> {
    match ledger {
        MarketsLedger::Mainnet => &store.mainnet,
        MarketsLedger::Testnet => &store.testnet,
    }
}

fn seconds_until_next_utc_midnight(unix_now: u64) -> u64 {
    const SECONDS_PER_DAY: u64 = 86_400;
    let seconds_into_day = unix_now % SECONDS_PER_DAY;
    (SECONDS_PER_DAY - seconds_into_day).max(1)
}

async fn sleep_until_next_utc_midnight() {
    let sleep_for = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| Duration::from_secs(seconds_until_next_utc_midnight(duration.as_secs())))
        .unwrap_or(Duration::from_secs(SECONDS_PER_DAY));
    tokio::time::sleep(sleep_for).await;
}

/// Fetches any ledger missing from `store` from the live exchange and writes
/// the on-disk cache. Startup blocks until both mainnet and testnet are loaded.
pub(crate) async fn refresh_startup_markets(
    clients: &crate::hyperliquid::HyperliquidClients,
    data_dir: &Path,
    store: &MarketsStore,
) -> Result<(), MarketsMetadataError> {
    for ledger in [MarketsLedger::Mainnet, MarketsLedger::Testnet] {
        if store.api_response(ledger).await.is_none() {
            refresh_ledger_into_store(clients.for_ledger(ledger), data_dir, ledger, store).await?;
        }
    }

    for ledger in [MarketsLedger::Mainnet, MarketsLedger::Testnet] {
        if store.api_response(ledger).await.is_none() {
            return Err(MarketsMetadataError::LedgerNotReady(ledger));
        }
    }

    info!("markets startup load complete");
    Ok(())
}

/// Spawns the nightly markets refresh loop. The task sleeps until the next UTC
/// midnight before each refresh. A failed refresh is logged and retried at the
/// next midnight; the in-memory store keeps serving whatever it already holds.
pub(crate) fn spawn_nightly_refresh(
    clients: crate::hyperliquid::HyperliquidClients,
    data_dir: PathBuf,
    store: Arc<MarketsStore>,
) {
    tokio::spawn(async move {
        loop {
            sleep_until_next_utc_midnight().await;
            if let Err(error) = refresh_all_markets_into_store(&clients, &data_dir, &store).await {
                warn!(%error, "markets metadata refresh failed");
            }
        }
    });
}

/// Refreshes both ledgers from the live exchange into `store`, best-effort
/// writing each on-disk cache. Returns an error only when every ledger failed.
async fn refresh_all_markets_into_store(
    clients: &crate::hyperliquid::HyperliquidClients,
    data_dir: &Path,
    store: &MarketsStore,
) -> Result<(), MarketsMetadataError> {
    let mut any_succeeded = false;
    let mut last_error = None;
    for ledger in [MarketsLedger::Mainnet, MarketsLedger::Testnet] {
        match refresh_ledger_into_store(clients.for_ledger(ledger), data_dir, ledger, store).await {
            Ok(()) => any_succeeded = true,
            Err(error) => {
                warn!(%error, ?ledger, "markets refresh failed for ledger");
                last_error = Some(error);
            }
        }
    }
    match last_error {
        Some(error) if !any_succeeded => Err(error.into()),
        _ => Ok(()),
    }
}

/// Refreshes one ledger from the live exchange, updates the in-memory store,
/// and best-effort writes the on-disk cache. A disk write failure is logged but
/// does not fail the refresh, since the CSV is only a restart cache.
async fn refresh_ledger_into_store(
    client: &dyn Hyperliquid,
    data_dir: &Path,
    ledger: MarketsLedger,
    store: &MarketsStore,
) -> Result<(), HyperliquidError> {
    let fetched = client.fetch_market_metadata().await?;
    let frame = build_markets_frame(&fetched)?;
    let refreshed_at = Utc::now().to_rfc3339();
    let response = markets_api_response_from_frame(&frame, Some(refreshed_at))?;
    let market_count = response.leverage_limits.len();
    store.set_ledger(ledger, response).await;

    let path = markets_file_path(data_dir, ledger);
    if let Err(error) = crate::dataframe::write_csv(path, frame).await {
        error!(%error, ?ledger, "failed to write markets ledger disk cache");
    }

    info!(
        markets = market_count,
        ?ledger,
        "markets metadata refreshed"
    );
    Ok(())
}

/// Loads the perp universe from the on-disk ledger for ingestion.
pub(crate) async fn load_markets_from_disk(
    data_dir: &Path,
    ledger: MarketsLedger,
) -> Result<Vec<Market>, MarketsMetadataError> {
    let path = markets_file_path(data_dir, ledger);
    let frame = crate::dataframe::read_csv(path)
        .await?
        .ok_or(MarketsMetadataError::MissingFile)?;
    markets_from_frame(&frame).map_err(MarketsMetadataError::Polars)
}

fn markets_file_path(data_dir: &Path, ledger: MarketsLedger) -> PathBuf {
    data_dir.join(ledger.file_name())
}

/// Loads one ledger from the on-disk cache into a [`MarketsApiResponse`],
/// tagging it with the CSV's last-modified time as the refresh timestamp.
async fn load_ledger_from_disk(
    data_dir: &Path,
    ledger: MarketsLedger,
) -> Result<MarketsApiResponse, MarketsMetadataError> {
    let path = markets_file_path(data_dir, ledger);
    let frame = crate::dataframe::read_csv(path.clone())
        .await?
        .ok_or(MarketsMetadataError::MissingFile)?;
    let refreshed_at = file_modified_at_rfc3339(&path).await?;
    markets_api_response_from_frame(&frame, refreshed_at).map_err(MarketsMetadataError::Polars)
}

async fn file_modified_at_rfc3339(path: &Path) -> Result<Option<String>, std::io::Error> {
    let modified = tokio::fs::metadata(path).await?.modified()?;
    Ok(Some(DateTime::<Utc>::from(modified).to_rfc3339()))
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
) -> Result<MarketsApiResponse, PolarsError> {
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
    use std::sync::Arc;

    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use polars::prelude::df;
    use tempfile::TempDir;
    use tracing::Level;
    use tracing_test::traced_test;

    use super::*;
    use crate::candle::Candle;
    use crate::finance::Market;
    use crate::funding::FundingRate;
    use crate::hyperliquid::{Hyperliquid, HyperliquidClients, HyperliquidError};
    use crate::logs_contain_at;
    use crate::timeframe::Timeframe;

    struct MarketsOnlyMock {
        ledger: MarketsLedger,
        fail_fetch: bool,
    }

    #[async_trait]
    impl Hyperliquid for MarketsOnlyMock {
        async fn fetch_market_metadata(&self) -> Result<Vec<MarketMetadata>, HyperliquidError> {
            if self.fail_fetch {
                return Err(HyperliquidError::Sdk(
                    hyperliquid_rust_sdk::Error::GenericRequest(
                        "markets fetch should not run".into(),
                    ),
                ));
            }

            let symbol = match self.ledger {
                MarketsLedger::Mainnet => "BTC",
                MarketsLedger::Testnet => "ETH",
            };
            Ok(vec![MarketMetadata {
                symbol: Market::new(symbol.into()),
                max_leverage: 50,
                asset_index: 0,
            }])
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

    async fn write_ledger_csv(data_dir: &Path, ledger: MarketsLedger, symbol: &str) {
        let frame = df! {
            "symbol" => &[symbol],
            "max_leverage" => &[50_u32],
            "asset_index" => &[0_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(markets_file_path(data_dir, ledger), frame)
            .await
            .unwrap();
    }

    #[traced_test]
    #[tokio::test]
    async fn startup_markets_refresh_missing_ledgers_before_ready() {
        let data_dir = TempDir::new().unwrap();
        let clients = HyperliquidClients::from_clients(
            Arc::new(MarketsOnlyMock {
                ledger: MarketsLedger::Mainnet,
                fail_fetch: false,
            }),
            Arc::new(MarketsOnlyMock {
                ledger: MarketsLedger::Testnet,
                fail_fetch: false,
            }),
        );
        let store = MarketsStore::load_from_disk(data_dir.path()).await;

        refresh_startup_markets(&clients, data_dir.path(), &store)
            .await
            .unwrap();

        assert!(
            markets_file_path(data_dir.path(), MarketsLedger::Mainnet).exists(),
            "mainnet markets.csv should exist after startup refresh"
        );
        assert!(
            markets_file_path(data_dir.path(), MarketsLedger::Testnet).exists(),
            "testnet_markets.csv should exist after startup refresh"
        );

        let mainnet_markets = load_markets_from_disk(data_dir.path(), MarketsLedger::Mainnet).await;
        let testnet_markets = load_markets_from_disk(data_dir.path(), MarketsLedger::Testnet).await;
        assert_eq!(mainnet_markets.unwrap().len(), 1);
        assert_eq!(testnet_markets.unwrap().len(), 1);

        assert!(store.api_response(MarketsLedger::Mainnet).await.is_some());
        assert!(store.api_response(MarketsLedger::Testnet).await.is_some());

        assert!(logs_contain_at(
            Level::INFO,
            &["markets metadata refreshed", "Mainnet"]
        ));
        assert!(logs_contain_at(
            Level::INFO,
            &["markets metadata refreshed", "Testnet"]
        ));
        assert!(logs_contain_at(
            Level::INFO,
            &["markets startup load complete"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn startup_markets_uses_disk_cache_without_exchange_fetch() {
        let data_dir = TempDir::new().unwrap();
        write_ledger_csv(data_dir.path(), MarketsLedger::Mainnet, "BTC").await;
        write_ledger_csv(data_dir.path(), MarketsLedger::Testnet, "ETH").await;

        let clients = HyperliquidClients::from_clients(
            Arc::new(MarketsOnlyMock {
                ledger: MarketsLedger::Mainnet,
                fail_fetch: true,
            }),
            Arc::new(MarketsOnlyMock {
                ledger: MarketsLedger::Testnet,
                fail_fetch: true,
            }),
        );
        let store = MarketsStore::load_from_disk(data_dir.path()).await;

        refresh_startup_markets(&clients, data_dir.path(), &store)
            .await
            .unwrap();

        assert!(store.api_response(MarketsLedger::Mainnet).await.is_some());
        assert!(store.api_response(MarketsLedger::Testnet).await.is_some());
        assert!(logs_contain_at(
            Level::INFO,
            &["markets ledger loaded from disk cache", "Mainnet"]
        ));
        assert!(logs_contain_at(
            Level::INFO,
            &["markets ledger loaded from disk cache", "Testnet"]
        ));
        assert!(logs_contain_at(
            Level::INFO,
            &["markets startup load complete"]
        ));
    }
}
