use std::num::TryFromIntError;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use backon::{ExponentialBuilder, Retryable};
use chrono::{DateTime, Duration, Utc};
use futures::stream::{self, StreamExt, TryStreamExt};
use hyperliquid_rust_sdk::InfoClient;
use thiserror::Error;
use tracing::{debug, info, instrument};
use url::Url;

use crate::candle::{
    Candle, CandleError, candles_to_dataframe, get_last_timestamp_for_symbol,
    merge_and_deduplicate, read_csv, write_csv,
};
use crate::finance::{Market, Symbol};
use crate::timeframe::Timeframe;

#[derive(Debug, Error)]
pub(crate) enum HyperliquidError {
    #[error(transparent)]
    Candle(#[from] CandleError),
    #[error(transparent)]
    Sdk(#[from] hyperliquid_rust_sdk::Error),
    #[error(transparent)]
    IntConversion(#[from] TryFromIntError),
}

#[async_trait]
pub(crate) trait Hyperliquid: Send + Sync {
    async fn list_markets(&self) -> Result<Vec<Market>, HyperliquidError>;

    async fn fetch_candles(
        &self,
        market: &Market,
        timeframe: Timeframe,
        start: DateTime<Utc>,
    ) -> Result<Vec<Candle>, HyperliquidError>;
}

pub(crate) struct HyperliquidClient {
    info: InfoClient,
}

impl HyperliquidClient {
    #[instrument(skip_all)]
    pub(crate) async fn new(base_url: Option<&Url>) -> Result<Self, HyperliquidError> {
        debug!("initializing");
        let mut info = InfoClient::new(None, None).await?;
        if let Some(url) = base_url {
            url.to_string()
                .trim_end_matches('/')
                .clone_into(&mut info.http_client.base_url);
        }
        info!("initialized");
        Ok(Self { info })
    }
}

#[async_trait]
impl Hyperliquid for HyperliquidClient {
    #[instrument(skip(self))]
    async fn list_markets(&self) -> Result<Vec<Market>, HyperliquidError> {
        let meta = self.info.meta().await?;
        let markets: Vec<Market> = meta
            .universe
            .into_iter()
            .map(|asset| Market::new(asset.name))
            .collect();
        debug!(count = markets.len(), "fetched markets");
        Ok(markets)
    }

    #[instrument(skip(self))]
    async fn fetch_candles(
        &self,
        market: &Market,
        timeframe: Timeframe,
        start: DateTime<Utc>,
    ) -> Result<Vec<Candle>, HyperliquidError> {
        let start_ms = u64::try_from(start.timestamp_millis())?;
        let end_ms = u64::try_from(Utc::now().timestamp_millis())?;

        let response = (|| async {
            self.info
                .candles_snapshot(
                    market.as_str().to_string(),
                    timeframe.interval_string().to_string(),
                    start_ms,
                    end_ms,
                )
                .await
        })
        .retry(ExponentialBuilder::default().with_jitter())
        .await?;

        let candles = response
            .into_iter()
            .filter_map(|snapshot| {
                let time_open = snapshot.time_open.cast_signed();
                let timestamp = DateTime::from_timestamp_millis(time_open)?;

                let open = snapshot.open.parse().ok()?;
                let high = snapshot.high.parse().ok()?;
                let low = snapshot.low.parse().ok()?;
                let close = snapshot.close.parse().ok()?;
                let volume = snapshot.vlm.parse().ok()?;

                Some(Candle {
                    timestamp,
                    open,
                    high,
                    low,
                    close,
                    volume,
                    symbol: Symbol::from_raw(market.as_str()),
                })
            })
            .collect();

        Ok(candles)
    }
}

pub(crate) struct CandleIngester<H> {
    client: Arc<H>,
}

impl<H: Hyperliquid> CandleIngester<H> {
    pub(crate) fn new(client: Arc<H>) -> Self {
        Self { client }
    }

    #[instrument(skip(self, data_dir), fields(timeframe = ?timeframe))]
    pub(crate) async fn ingest(
        &self,
        timeframe: Timeframe,
        data_dir: &Path,
    ) -> Result<(), HyperliquidError> {
        let markets = self.client.list_markets().await?;
        let path = data_dir.join(timeframe.file_name());
        let existing = read_csv(&path)?;
        let default_start = Utc::now() - Duration::days(timeframe.lookback_days());

        let candle_batches: Vec<Vec<Candle>> = stream::iter(&markets)
            .then(|market| async {
                let start = get_last_timestamp_for_symbol(existing.as_ref(), market.as_str())
                    .unwrap_or(default_start);
                self.client.fetch_candles(market, timeframe, start).await
            })
            .try_collect()
            .await?;

        let all_candles: Vec<Candle> = candle_batches.into_iter().flatten().collect();
        if all_candles.is_empty() {
            info!("no new candles");
            return Ok(());
        }

        let new_df = candles_to_dataframe(&all_candles)?;
        let mut merged = merge_and_deduplicate(existing, new_df)?;
        write_csv(&path, &mut merged)?;

        info!(
            markets = markets.len(),
            candles = all_candles.len(),
            "ingestion complete"
        );

        Ok(())
    }
}

#[instrument(skip_all)]
pub(crate) async fn ingest_all_candles(
    data_dir: &Path,
    base_url: Option<&Url>,
) -> Result<(), HyperliquidError> {
    let client = Arc::new(HyperliquidClient::new(base_url).await?);
    let ingester = CandleIngester::new(client);

    for timeframe in [
        Timeframe::FifteenMin,
        Timeframe::OneHour,
        Timeframe::OneDay,
        Timeframe::OneWeek,
    ] {
        ingester.ingest(timeframe, data_dir).await?;
    }

    Ok(())
}
