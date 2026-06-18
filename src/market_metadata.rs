//! The markets domain orchestration: refreshing a venue's universe from the
//! exchange and deriving its tradable set.
//!
//! The universe and the operator disable decisions live in two separate
//! aggregates ([`crate::market_catalog`] and [`crate::market_enablement`]); this
//! module ties them together. The tradable set is catalog listings minus
//! operator disables -- a join over two projections, which makes "a refresh
//! never clobbers an operator disable" a structural guarantee rather than a
//! careful merge (the bug the old `markets.csv` left-join had to avoid by hand).

use std::collections::BTreeSet;

use chrono::Utc;
use event_sorcery::{Projection, ProjectionError, SendError, Store};
use tracing::info;

use crate::finance::{Market, Symbol};
use crate::hyperliquid::{Hyperliquid, HyperliquidError};
use crate::market_catalog::{CatalogMarket, MarketCatalog, MarketCatalogCommand};
use crate::market_enablement::{ENABLEMENT_STATUS, MarketEnablement, MarketId, MarketStatus};
use crate::venue::VenueRef;

/// A market's exchange metadata as fetched from a venue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MarketMetadata {
    pub(crate) symbol: Market,
    pub(crate) max_leverage: u32,
    pub(crate) asset_index: u32,
}

/// Why refreshing the market universe fails.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RefreshError {
    #[error(transparent)]
    Hyperliquid(#[from] HyperliquidError),
    #[error(transparent)]
    RecordUniverse(#[from] SendError<MarketCatalog>),
    #[error(transparent)]
    Catalog(#[from] ProjectionError<MarketCatalog>),
    #[error(transparent)]
    Enablement(#[from] ProjectionError<MarketEnablement>),
}

/// Refreshes the Hyperliquid universe from the live exchange and returns the
/// tradable markets: every listed market the operator has not disabled.
pub(crate) async fn refresh_markets(
    client: &dyn Hyperliquid,
    catalog: &Store<MarketCatalog>,
    catalog_projection: &Projection<MarketCatalog>,
    enablement_projection: &Projection<MarketEnablement>,
) -> Result<Vec<Market>, RefreshError> {
    let fetched = client.fetch_market_metadata().await?;
    let observed: Vec<CatalogMarket> = fetched
        .iter()
        .map(|market| {
            CatalogMarket::new(
                Symbol::from_raw(market.symbol.as_str()),
                market.max_leverage,
            )
        })
        .collect();

    catalog
        .send(
            &VenueRef::Hyperliquid,
            MarketCatalogCommand::RecordUniverse {
                markets: observed,
                observed_at: Utc::now(),
            },
        )
        .await?;

    let tradable = tradable_markets(
        VenueRef::Hyperliquid,
        catalog_projection,
        enablement_projection,
    )
    .await?;
    info!(
        markets = markets.len(),
        ledger = ?ledger,
        "markets metadata refreshed"
    );
    Ok(tradable)
}

/// The tradable markets of a venue: catalog listings minus operator disables.
pub(crate) async fn tradable_markets(
    venue: VenueRef,
    catalog_projection: &Projection<MarketCatalog>,
    enablement_projection: &Projection<MarketEnablement>,
) -> Result<Vec<Market>, RefreshError> {
    let Some(catalog) = catalog_projection.load(&venue).await? else {
        return Ok(Vec::new());
    };

    let disabled: BTreeSet<Symbol> = enablement_projection
        .filter(ENABLEMENT_STATUS, &MarketStatus::Disabled)
        .await?
        .into_iter()
        .filter(|(id, _)| id.venue() == venue)
        .map(|(id, _): (MarketId, MarketEnablement)| id.into_symbol())
        .collect();

    let tradable = catalog
        .markets()
        .iter()
        .filter(|market| !disabled.contains(market.symbol()))
        .map(|market| Market::new(market.symbol().as_str().to_string()))
        .collect();
    Ok(tradable)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use sqlx::SqlitePool;
    use tracing::Level;
    use tracing_test::traced_test;

    use event_sorcery::StoreBuilder;

    use super::*;
    use crate::candle::Candle;
    use crate::funding::FundingRate;
    use crate::market_enablement::MarketEnablementCommand;
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

    async fn market_stores() -> (
        Arc<Store<MarketCatalog>>,
        Arc<Projection<MarketCatalog>>,
        Arc<Store<MarketEnablement>>,
        Arc<Projection<MarketEnablement>>,
    ) {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let (catalog, catalog_projection) = StoreBuilder::<MarketCatalog>::new(pool.clone())
            .build()
            .await
            .unwrap();
        let (enablement, enablement_projection) = StoreBuilder::<MarketEnablement>::new(pool)
            .build()
            .await
            .unwrap();
        (
            catalog,
            catalog_projection,
            enablement,
            enablement_projection,
        )
    }

    fn symbols(markets: &[Market]) -> Vec<&str> {
        markets.iter().map(Market::as_str).collect()
    }

    #[traced_test]
    #[tokio::test]
    async fn refresh_records_the_universe_and_excludes_operator_disables() {
        let (catalog, catalog_projection, enablement, enablement_projection) =
            market_stores().await;
        let client = StubClient {
            metadata: vec![metadata("BTC", 50, 0), metadata("ETH", 25, 1)],
        };

        let tradable = refresh_markets(
            &client,
            &catalog,
            &catalog_projection,
            &enablement_projection,
        )
        .await
        .unwrap();
        assert_eq!(symbols(&tradable), vec!["BTC", "ETH"]);
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["markets metadata refreshed"]
        ));

        // The operator disables BTC; a later refresh keeps it excluded.
        enablement
            .send(
                &MarketId::new(VenueRef::Hyperliquid, Symbol::from_raw("BTC")),
                MarketEnablementCommand::Disable { reason: None },
            )
            .await
            .unwrap();

        let tradable = refresh_markets(
            &client,
            &catalog,
            &catalog_projection,
            &enablement_projection,
        )
        .await
        .unwrap();
        assert_eq!(symbols(&tradable), vec!["ETH"]);
    }

    #[traced_test]
    #[tokio::test]
    async fn refresh_discovers_newly_listed_markets() {
        let (catalog, catalog_projection, _enablement, enablement_projection) =
            market_stores().await;
        let client = StubClient {
            metadata: vec![
                metadata("BTC", 50, 0),
                metadata("ETH", 25, 1),
                metadata("SOL", 20, 2),
            ],
        };

        let tradable = refresh_markets(
            &client,
            &catalog,
            &catalog_projection,
            &enablement_projection,
        )
        .await
        .unwrap();

        let mut discovered = symbols(&tradable);
        discovered.sort_unstable();
        assert_eq!(discovered, vec!["BTC", "ETH", "SOL"]);
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
