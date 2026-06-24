//! Markets metadata: the perp universe with each market's max leverage,
//! stored in `markets.csv` and refreshed from Hyperliquid.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use polars::prelude::{DataFrame, PolarsError, df};
use serde::Serialize;
use thiserror::Error;
use tracing::info;

use crate::finance::{self, Market};
use crate::hyperliquid::{Hyperliquid, HyperliquidError};

/// Markets metadata is refreshed at most once per day on the server.
pub(crate) const MARKETS_REFRESH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

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
    pub(crate) symbol: String,
    pub(crate) max_leverage: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketsApiResponse {
    pub(crate) tickers: Vec<String>,
    pub(crate) leverage_limits: Vec<LeverageLimitEntry>,
    pub(crate) refreshed_at: Option<String>,
}

/// A market's exchange metadata as fetched from Hyperliquid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MarketMetadata {
    pub(crate) symbol: Market,
    pub(crate) max_leverage: u32,
}

/// File name of the markets ledger inside the data directory.
pub(crate) fn file_name() -> &'static str {
    "markets.csv"
}

/// Refreshes `markets.csv` from the live exchange and returns the current
/// perp universe. Ingestion consumes the returned list directly.
pub(crate) async fn refresh_markets(
    client: &dyn Hyperliquid,
    data_dir: &Path,
) -> Result<Vec<Market>, HyperliquidError> {
    let fetched = client.fetch_market_metadata().await?;
    let path = data_dir.join(file_name());
    let frame = build_markets_frame(&fetched)?;
    let markets = markets_from_frame(&frame)?;
    crate::dataframe::write_csv(path, frame).await?;
    info!(markets = markets.len(), "markets metadata refreshed");
    Ok(markets)
}

pub(crate) fn markets_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(file_name())
}

pub(crate) async fn markets_need_refresh(data_dir: &Path) -> bool {
    let path = markets_file_path(data_dir);
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return true;
    };
    let Ok(modified_at) = metadata.modified() else {
        return true;
    };
    let age = SystemTime::now()
        .duration_since(modified_at)
        .unwrap_or(MARKETS_REFRESH_INTERVAL);
    age >= MARKETS_REFRESH_INTERVAL
}

pub(crate) async fn load_markets_api_response(
    data_dir: &Path,
) -> Result<MarketsApiResponse, MarketsMetadataError> {
    let path = markets_file_path(data_dir);
    let frame = crate::dataframe::read_csv(path.clone())
        .await?
        .ok_or(MarketsMetadataError::MissingFile)?;
    let refreshed_at = file_modified_at_rfc3339(&path).await?;
    markets_api_response_from_frame(&frame, refreshed_at)
}

fn markets_api_response_from_frame(
    frame: &DataFrame,
    refreshed_at: Option<String>,
) -> Result<MarketsApiResponse, MarketsMetadataError> {
    let symbols = frame.column("symbol")?.str()?;
    let max_leverages = frame.column("max_leverage")?.i64()?;

    let mut tickers = Vec::new();
    let mut leverage_limits = Vec::new();

    for index in 0..symbols.len() {
        let Some(symbol) = symbols.get(index) else {
            continue;
        };
        let ccxt_symbol = finance::hyperliquid_swap_ccxt_symbol(symbol);
        let raw_max_leverage = max_leverages.get(index).unwrap_or(1);
        let max_leverage = u32::try_from(raw_max_leverage).map_err(|_| {
            MarketsMetadataError::Polars(PolarsError::ComputeError(
                "max_leverage out of range".into(),
            ))
        })?;
        tickers.push(ccxt_symbol.clone());
        leverage_limits.push(LeverageLimitEntry {
            symbol: ccxt_symbol,
            max_leverage,
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

async fn file_modified_at_rfc3339(path: &Path) -> Result<Option<String>, MarketsMetadataError> {
    let metadata = tokio::fs::metadata(path).await?;
    let modified_at = metadata.modified()?;
    let timestamp = chrono::DateTime::<chrono::Utc>::from(modified_at);
    Ok(Some(timestamp.to_rfc3339()))
}

/// Refreshes markets from Hyperliquid when stale, then returns the API payload.
pub(crate) async fn refresh_markets_if_stale(
    client: &dyn Hyperliquid,
    data_dir: &Path,
) -> Result<MarketsApiResponse, MarketsMetadataError> {
    if markets_need_refresh(data_dir).await {
        refresh_markets(client, data_dir).await?;
    }
    load_markets_api_response(data_dir).await
}

/// Refreshes markets from Hyperliquid unconditionally, then returns the API payload.
pub(crate) async fn refresh_markets_and_load_api_response(
    client: &dyn Hyperliquid,
    data_dir: &Path,
) -> Result<MarketsApiResponse, MarketsMetadataError> {
    refresh_markets(client, data_dir).await?;
    load_markets_api_response(data_dir).await
}

fn markets_from_frame(frame: &DataFrame) -> Result<Vec<Market>, PolarsError> {
    let symbols = frame.column("symbol")?.str()?;
    let markets: Vec<Market> = (0..symbols.len())
        .filter_map(|index| {
            symbols
                .get(index)
                .map(|symbol| Market::new(symbol.to_string()))
        })
        .collect();
    Ok(markets)
}

fn build_markets_frame(fetched: &[MarketMetadata]) -> Result<DataFrame, PolarsError> {
    let symbols: Vec<&str> = fetched
        .iter()
        .map(|market| market.symbol.as_str())
        .collect();
    let max_leverages: Vec<u32> = fetched.iter().map(|market| market.max_leverage).collect();
    df! {
        "symbol" => symbols,
        "max_leverage" => max_leverages,
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

    fn metadata(symbol: &str, max_leverage: u32) -> MarketMetadata {
        MarketMetadata {
            symbol: Market::new(symbol.to_string()),
            max_leverage,
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
        let fetched = [metadata("BTC", 50), metadata("ETH", 25)];

        let frame = build_markets_frame(&fetched).unwrap();

        assert_eq!(frame.height(), 2);
        assert_eq!(frame.get_column_names(), ["symbol", "max_leverage"]);
        let symbols = frame.column("symbol").unwrap().str().unwrap();
        let leverage = frame.column("max_leverage").unwrap().u32().unwrap();
        assert_eq!(symbols.get(0), Some("BTC"));
        assert_eq!(symbols.get(1), Some("ETH"));
        assert_eq!(leverage.get(0), Some(50));
        assert_eq!(leverage.get(1), Some(25));
    }

    #[test]
    fn markets_from_frame_maps_all_rows() {
        let frame = df! {
            "symbol" => &["BTC", "ETH"],
            "max_leverage" => &[50_u32, 25],
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
            metadata: vec![metadata("BTC", 50), metadata("ETH", 25)],
        };

        let markets = refresh_markets(&client, data_dir.path()).await.unwrap();
        assert_eq!(
            markets.iter().map(Market::as_str).collect::<Vec<_>>(),
            vec!["BTC", "ETH"]
        );
        assert!(data_dir.path().join("markets.csv").exists());
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["markets metadata refreshed"]
        ));

        let reloaded = crate::dataframe::read_csv(data_dir.path().join(file_name()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reloaded.get_column_names(), ["symbol", "max_leverage"]);
    }

    #[traced_test]
    #[tokio::test]
    async fn refresh_discovers_markets_from_the_exchange_not_the_ledger() {
        let data_dir = TempDir::new().unwrap();
        let stale_ledger = df! {
            "symbol" => &["SOL"],
            "max_leverage" => &[20_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(data_dir.path().join(file_name()), stale_ledger)
            .await
            .unwrap();

        let client = StubClient {
            metadata: vec![
                metadata("BTC", 50),
                metadata("ETH", 25),
                metadata("SOL", 20),
            ],
        };

        let markets = refresh_markets(&client, data_dir.path()).await.unwrap();
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
        }
        .unwrap();
        crate::dataframe::write_csv(data_dir.path().join(file_name()), frame)
            .await
            .unwrap();

        let response = load_markets_api_response(data_dir.path()).await.unwrap();

        assert_eq!(
            response.tickers,
            vec!["BTC/USDC:USDC".to_string(), "ETH/USDC:USDC".to_string()]
        );
        assert_eq!(response.leverage_limits.len(), 2);
        assert_eq!(
            response.leverage_limits[0].symbol,
            "BTC/USDC:USDC".to_string()
        );
        assert_eq!(response.leverage_limits[0].max_leverage, 50);
        assert!(response.refreshed_at.is_some());
    }

    #[tokio::test]
    async fn load_markets_api_response_uppercases_mixed_case_hyperliquid_names() {
        let data_dir = TempDir::new().unwrap();
        let frame = df! {
            "symbol" => &["kPEPE"],
            "max_leverage" => &[10_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(data_dir.path().join(file_name()), frame)
            .await
            .unwrap();

        let response = load_markets_api_response(data_dir.path()).await.unwrap();

        assert_eq!(response.tickers, vec!["KPEPE/USDC:USDC".to_string()]);
        assert_eq!(
            response.leverage_limits[0].symbol,
            "KPEPE/USDC:USDC".to_string()
        );
    }

    #[tokio::test]
    async fn load_markets_api_response_formats_colon_names_like_ccxt() {
        let data_dir = TempDir::new().unwrap();
        let frame = df! {
            "symbol" => &["flx:crcl"],
            "max_leverage" => &[5_u32],
        }
        .unwrap();
        crate::dataframe::write_csv(data_dir.path().join(file_name()), frame)
            .await
            .unwrap();

        let response = load_markets_api_response(data_dir.path()).await.unwrap();

        assert_eq!(response.tickers, vec!["FLX-CRCL/USDC:USDC".to_string()]);
    }
}
