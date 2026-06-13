//! Markets metadata: the perp universe with each market's max leverage and a
//! persisted `disable` flag, stored in `markets.csv`.
//!
//! The `disable` flag is operator-controlled (edited by hand) and preserved
//! across refreshes; metadata like max leverage is refreshed from the exchange.

use std::path::Path;

use polars::prelude::{
    DataFrame, IntoLazy, JoinArgs, JoinType, NamedFrom, PolarsError, Series, col, df, lit,
};
use tracing::info;

use crate::finance::Market;
use crate::hyperliquid::{Hyperliquid, HyperliquidError};

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

/// Refreshes `markets.csv` from the live exchange and returns the tradable
/// markets: every fetched market that is not disabled.
///
/// Market discovery is driven by the exchange fetch; the ledger only persists
/// the operator-controlled `disable` flags. Ingestion consumes the returned
/// list directly, so it never depends on re-reading the CSV.
pub(crate) async fn refresh_markets(
    client: &dyn Hyperliquid,
    data_dir: &Path,
) -> Result<Vec<Market>, HyperliquidError> {
    let fetched = client.fetch_market_metadata().await?;
    let path = data_dir.join(file_name());
    let existing = crate::dataframe::read_csv(path.clone()).await?;
    let frame = build_markets_frame(&fetched, existing.as_ref())?;
    let tradable = tradable_from_frame(&frame)?;
    crate::dataframe::write_csv(path, frame).await?;
    info!(
        markets = fetched.len(),
        tradable = tradable.len(),
        "markets metadata refreshed"
    );
    Ok(tradable)
}

/// The tradable markets in a freshly built ledger frame: every market whose
/// `disable` flag is not set.
fn tradable_from_frame(frame: &DataFrame) -> Result<Vec<Market>, PolarsError> {
    let symbols = frame.column("symbol")?.str()?;
    let disable = frame.column("disable")?.bool()?;
    let markets: Vec<Market> = (0..symbols.len())
        .filter(|&index| disable.get(index) == Some(false))
        .filter_map(|index| {
            symbols
                .get(index)
                .map(|symbol| Market::new(symbol.to_string()))
        })
        .collect();
    Ok(markets)
}

/// Builds the markets ledger `DataFrame` (`symbol`, `max_leverage`, `disable`)
/// from freshly fetched metadata, preserving the `disable` flag of any symbol
/// already in `existing` and defaulting new symbols to enabled (`disable` false).
fn build_markets_frame(
    fetched: &[MarketMetadata],
    existing: Option<&DataFrame>,
) -> Result<DataFrame, PolarsError> {
    let symbols: Vec<&str> = fetched
        .iter()
        .map(|market| market.symbol.as_str())
        .collect();
    let max_leverages: Vec<u32> = fetched.iter().map(|market| market.max_leverage).collect();
    let fresh = df! {
        "symbol" => symbols,
        "max_leverage" => max_leverages,
    }?;

    let Some(existing) = existing else {
        let mut fresh = fresh;
        let disable = Series::new("disable".into(), vec![false; fresh.height()]);
        fresh.with_column(disable)?;
        return Ok(fresh);
    };

    let previous_flags = existing
        .clone()
        .lazy()
        .select([col("symbol"), col("disable").alias("previous_disable")]);

    fresh
        .lazy()
        .join(
            previous_flags,
            [col("symbol")],
            [col("symbol")],
            JoinArgs::new(JoinType::Left),
        )
        .with_column(
            col("previous_disable")
                .fill_null(lit(false))
                .alias("disable"),
        )
        .select([col("symbol"), col("max_leverage"), col("disable")])
        .collect()
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

    fn disable_for(frame: &DataFrame, symbol: &str) -> Option<bool> {
        let symbols = frame.column("symbol").unwrap().str().unwrap();
        let disable = frame.column("disable").unwrap().bool().unwrap();
        (0..symbols.len())
            .find(|&index| symbols.get(index) == Some(symbol))
            .and_then(|index| disable.get(index))
    }

    #[test]
    fn new_markets_default_to_enabled() {
        let fetched = [metadata("BTC", 50), metadata("ETH", 25)];

        let frame = build_markets_frame(&fetched, None).unwrap();
        assert_eq!(frame.height(), 2);
        assert_eq!(disable_for(&frame, "BTC"), Some(false));
        assert_eq!(disable_for(&frame, "ETH"), Some(false));
    }

    #[test]
    fn refresh_preserves_disable_flag_and_drops_vanished_markets() {
        let existing = df! {
            "symbol" => &["BTC", "SOL"],
            "max_leverage" => &[40_u32, 20],
            "disable" => &[true, false],
        }
        .unwrap();
        let fetched = [metadata("BTC", 50), metadata("ETH", 25)];

        let frame = build_markets_frame(&fetched, Some(&existing)).unwrap();

        // BTC keeps its operator-set disable flag; ETH is new (enabled); SOL
        // vanished from the exchange and is dropped.
        assert_eq!(frame.height(), 2);
        assert_eq!(disable_for(&frame, "BTC"), Some(true));
        assert_eq!(disable_for(&frame, "ETH"), Some(false));
        assert_eq!(disable_for(&frame, "SOL"), None);

        // max leverage is refreshed from the fetched metadata.
        let symbols = frame.column("symbol").unwrap().str().unwrap();
        let leverage = frame.column("max_leverage").unwrap().u32().unwrap();
        let btc_index = (0..symbols.len())
            .find(|&index| symbols.get(index) == Some("BTC"))
            .unwrap();
        assert_eq!(leverage.get(btc_index), Some(50));
    }

    #[traced_test]
    #[tokio::test]
    async fn refresh_writes_markets_csv_and_preserves_disable_across_runs() {
        let data_dir = TempDir::new().unwrap();
        let client = StubClient {
            metadata: vec![metadata("BTC", 50), metadata("ETH", 25)],
        };

        let tradable = refresh_markets(&client, data_dir.path()).await.unwrap();
        assert_eq!(
            tradable.len(),
            2,
            "both markets are tradable on first refresh"
        );
        assert!(data_dir.path().join("markets.csv").exists());
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["markets metadata refreshed"]
        ));

        // Operator disables BTC by editing the ledger, then a later refresh keeps it.
        let path = data_dir.path().join(file_name());
        let edited = crate::dataframe::read_csv(path.clone())
            .await
            .unwrap()
            .unwrap()
            .lazy()
            .with_column(col("symbol").eq(lit("BTC")).alias("disable"))
            .collect()
            .unwrap();
        crate::dataframe::write_csv(path, edited).await.unwrap();

        let tradable = refresh_markets(&client, data_dir.path()).await.unwrap();
        assert_eq!(
            tradable.iter().map(Market::as_str).collect::<Vec<_>>(),
            vec!["ETH"],
            "BTC is excluded from the tradable set once disabled"
        );

        let reloaded = crate::dataframe::read_csv(data_dir.path().join(file_name()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(disable_for(&reloaded, "BTC"), Some(true));
        assert_eq!(disable_for(&reloaded, "ETH"), Some(false));
    }

    #[test]
    fn tradable_from_frame_excludes_disabled_markets() {
        let frame = df! {
            "symbol" => &["BTC", "ETH", "SOL"],
            "max_leverage" => &[50_u32, 25, 20],
            "disable" => &[false, true, false],
        }
        .unwrap();

        let markets = tradable_from_frame(&frame).unwrap();
        let symbols: Vec<&str> = markets.iter().map(Market::as_str).collect();

        assert_eq!(markets.len(), 2, "the disabled market is excluded");
        assert!(symbols.contains(&"BTC"));
        assert!(symbols.contains(&"SOL"));
        assert!(!symbols.contains(&"ETH"), "ETH is disabled");
    }

    #[traced_test]
    #[tokio::test]
    async fn refresh_discovers_markets_from_the_exchange_not_the_ledger() {
        let data_dir = TempDir::new().unwrap();
        // The persisted ledger only knows BTC, which the operator disabled.
        let existing = df! {
            "symbol" => &["BTC"],
            "max_leverage" => &[40_u32],
            "disable" => &[true],
        }
        .unwrap();
        crate::dataframe::write_csv(data_dir.path().join(file_name()), existing)
            .await
            .unwrap();

        // The exchange now lists BTC, ETH, and SOL.
        let client = StubClient {
            metadata: vec![
                metadata("BTC", 50),
                metadata("ETH", 25),
                metadata("SOL", 20),
            ],
        };

        let tradable = refresh_markets(&client, data_dir.path()).await.unwrap();
        let symbols: Vec<&str> = tradable.iter().map(Market::as_str).collect();

        // ETH and SOL are discovered from the live fetch even though the ledger
        // never listed them; BTC stays excluded by its persisted disable flag.
        assert_eq!(tradable.len(), 2, "newly listed markets are discovered");
        assert!(symbols.contains(&"ETH"));
        assert!(symbols.contains(&"SOL"));
        assert!(
            !symbols.contains(&"BTC"),
            "operator-disabled BTC stays excluded"
        );
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["markets metadata refreshed"]
        ));
    }
}
