use backon::{ExponentialBuilder, Retryable};
use chrono::{DateTime, Utc};
use futures::stream::{self, StreamExt, TryStreamExt};
use hyperliquid_rust_sdk::InfoClient;
use polars::prelude::{
    CsvReader, CsvWriter, DataFrame, IntoLazy, JsonWriter, PlSmallStr, PolarsError, Selector,
    SerReader, SerWriter, SortMultipleOptions, UniqueKeepStrategy, col, df, lit,
};
use std::num::TryFromIntError;
use std::path::Path;
use thiserror::Error;
use tracing::{debug, info, instrument};
use url::Url;

#[derive(Debug, Error)]
pub(crate) enum IngestionError {
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Hyperliquid(#[from] hyperliquid_rust_sdk::Error),
    #[error(transparent)]
    IntConversion(#[from] TryFromIntError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Timeframe {
    FifteenMin,
    OneHour,
    OneDay,
    OneWeek,
}

impl Timeframe {
    pub(crate) fn from_interval_string(interval: &str) -> Option<Self> {
        match interval {
            "15m" => Some(Self::FifteenMin),
            "1h" => Some(Self::OneHour),
            "1d" => Some(Self::OneDay),
            "1w" => Some(Self::OneWeek),
            _ => None,
        }
    }

    fn interval_string(self) -> &'static str {
        match self {
            Self::FifteenMin => "15m",
            Self::OneHour => "1h",
            Self::OneDay => "1d",
            Self::OneWeek => "1w",
        }
    }

    fn lookback_days(self) -> i64 {
        match self {
            Self::FifteenMin => 30,
            Self::OneHour => 90,
            Self::OneDay => 365,
            Self::OneWeek => 365 * 3,
        }
    }

    pub(crate) fn file_name(self) -> &'static str {
        match self {
            Self::FifteenMin => "ohlcv_15m.csv",
            Self::OneHour => "ohlcv_1h.csv",
            Self::OneDay => "ohlcv_1d.csv",
            Self::OneWeek => "ohlcv_1w.csv",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Symbol(String);

impl Symbol {
    fn from_raw(raw: &str) -> Self {
        let base = raw.split('/').next().unwrap_or(raw);
        Self(base.to_uppercase())
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone)]
struct Candle {
    timestamp: DateTime<Utc>,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    symbol: Symbol,
}

#[instrument(skip_all, fields(count = candles.len()))]
fn candles_to_dataframe(candles: &[Candle]) -> Result<DataFrame, IngestionError> {
    debug!("converting candles to dataframe");
    let timestamps: Vec<i64> = candles
        .iter()
        .map(|candle| candle.timestamp.timestamp_millis())
        .collect();

    let opens: Vec<f64> = candles.iter().map(|candle| candle.open).collect();
    let highs: Vec<f64> = candles.iter().map(|candle| candle.high).collect();
    let lows: Vec<f64> = candles.iter().map(|candle| candle.low).collect();
    let closes: Vec<f64> = candles.iter().map(|candle| candle.close).collect();
    let volumes: Vec<f64> = candles.iter().map(|candle| candle.volume).collect();
    let symbols: Vec<&str> = candles
        .iter()
        .map(|candle| candle.symbol.as_str())
        .collect();

    Ok(df! {
        "timestamp" => timestamps,
        "open" => opens,
        "high" => highs,
        "low" => lows,
        "close" => closes,
        "volume" => volumes,
        "symbol" => symbols,
    }?)
}

fn merge_and_deduplicate(
    existing: Option<DataFrame>,
    new: DataFrame,
) -> Result<DataFrame, IngestionError> {
    let combined = match existing {
        Some(existing) => existing.vstack(&new)?,
        None => new,
    };

    let deduped = combined
        .lazy()
        .sort_by_exprs(
            [col("timestamp"), col("symbol")],
            SortMultipleOptions::default().with_order_descending(true),
        )
        .unique(
            Some(Selector::ByName {
                names: [
                    PlSmallStr::from_static("timestamp"),
                    PlSmallStr::from_static("symbol"),
                ]
                .into(),
                strict: true,
            }),
            UniqueKeepStrategy::First,
        )
        .sort_by_exprs(
            [col("timestamp"), col("symbol")],
            SortMultipleOptions::default(),
        )
        .collect()?;

    Ok(deduped)
}

#[instrument(skip_all, fields(path = %path.display()))]
fn read_csv(path: &Path) -> Result<Option<DataFrame>, IngestionError> {
    if !path.exists() {
        debug!("file not found");
        return Ok(None);
    }

    let file = std::fs::File::open(path)?;
    let dataframe = CsvReader::new(file).finish()?;
    debug!(rows = dataframe.height(), "loaded csv");
    Ok(Some(dataframe))
}

#[instrument(skip_all)]
pub(crate) fn read_candles_json(
    data_dir: &Path,
    timeframe: Timeframe,
) -> Result<Option<Vec<u8>>, IngestionError> {
    let path = data_dir.join(timeframe.file_name());
    let Some(mut dataframe) = read_csv(&path)? else {
        return Ok(None);
    };

    let mut buffer = Vec::new();
    JsonWriter::new(&mut buffer).finish(&mut dataframe)?;
    Ok(Some(buffer))
}

#[instrument(skip_all, fields(path = %path.display()))]
fn write_csv(path: &Path, df: &mut DataFrame) -> Result<(), IngestionError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(path)?;
    CsvWriter::new(file).finish(df)?;
    debug!(rows = df.height(), "wrote csv");
    Ok(())
}

struct HyperliquidClient {
    info: InfoClient,
}

impl HyperliquidClient {
    #[instrument(skip_all)]
    async fn new(base_url: Option<&Url>) -> Result<Self, IngestionError> {
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

    #[instrument(skip(self))]
    async fn fetch_candles(
        &self,
        symbol: &str,
        timeframe: Timeframe,
        start: DateTime<Utc>,
    ) -> Result<Vec<Candle>, IngestionError> {
        let start_ms = u64::try_from(start.timestamp_millis())?;
        let end_ms = u64::try_from(Utc::now().timestamp_millis())?;

        let response = (|| async {
            self.info
                .candles_snapshot(
                    symbol.to_string(),
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
                    symbol: Symbol::from_raw(symbol),
                })
            })
            .collect();

        Ok(candles)
    }

    #[instrument(skip(self))]
    async fn list_markets(&self) -> Result<Vec<String>, IngestionError> {
        let meta = self.info.meta().await?;
        let symbols: Vec<String> = meta.universe.into_iter().map(|asset| asset.name).collect();
        debug!(count = symbols.len(), "fetched markets");
        Ok(symbols)
    }
}

struct CandleIngester {
    client: HyperliquidClient,
}

impl CandleIngester {
    fn new(client: HyperliquidClient) -> Self {
        Self { client }
    }

    #[instrument(skip(self, data_dir), fields(timeframe = ?timeframe))]
    async fn ingest(&self, timeframe: Timeframe, data_dir: &Path) -> Result<(), IngestionError> {
        let markets = self.client.list_markets().await?;
        let path = data_dir.join(timeframe.file_name());
        let existing = read_csv(&path)?;
        let default_start = Utc::now() - chrono::Duration::days(timeframe.lookback_days());

        let candle_batches: Vec<Vec<Candle>> = stream::iter(&markets)
            .then(|market| async {
                let start = get_last_timestamp_for_symbol(existing.as_ref(), market)
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
) -> Result<(), IngestionError> {
    let client = HyperliquidClient::new(base_url).await?;
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

fn get_last_timestamp_for_symbol(df: Option<&DataFrame>, symbol: &str) -> Option<DateTime<Utc>> {
    let df = df?;

    let filtered = df
        .clone()
        .lazy()
        .filter(col("symbol").eq(lit(symbol)))
        .select([col("timestamp").max()])
        .collect()
        .ok()?;

    let max_ts = filtered.column("timestamp").ok()?.i64().ok()?.get(0)?;
    DateTime::from_timestamp_millis(max_ts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use proptest::prelude::*;
    use tempfile::TempDir;
    use tracing_test::traced_test;

    fn sample_candles() -> Vec<Candle> {
        vec![
            Candle {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
                open: 100.0,
                high: 110.0,
                low: 95.0,
                close: 105.0,
                volume: 1000.0,
                symbol: Symbol::from_raw("BTC"),
            },
            Candle {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 1, 0, 0).unwrap(),
                open: 105.0,
                high: 115.0,
                low: 100.0,
                close: 110.0,
                volume: 1500.0,
                symbol: Symbol::from_raw("BTC"),
            },
        ]
    }

    fn create_test_df(timestamps: &[i64], symbols: &[&str], closes: &[f64]) -> DataFrame {
        df! {
            "timestamp" => timestamps,
            "symbol" => symbols,
            "close" => closes,
        }
        .unwrap()
    }

    proptest! {
        #[test]
        fn symbol_normalization_is_idempotent(base in "[A-Z]{2,5}") {
            let raw = format!("{base}/USDC:USDC");
            let first = Symbol::from_raw(&raw);
            let second = Symbol::from_raw(first.as_str());
            prop_assert_eq!(first.as_str(), second.as_str());
        }

        #[test]
        fn symbol_handles_any_base_currency(base in "[A-Za-z]{1,10}") {
            let raw = format!("{base}/USDC:USDC");
            let symbol = Symbol::from_raw(&raw);
            prop_assert_eq!(symbol.as_str(), base.to_uppercase());
        }

        #[test]
        fn symbol_output_is_always_uppercase(input in "[a-zA-Z]{1,10}") {
            let symbol = Symbol::from_raw(&input);
            prop_assert!(symbol.as_str().chars().all(char::is_uppercase));
        }

        #[test]
        fn deduplication_is_idempotent(
            ts1 in 1_600_000_000_000_i64..1_800_000_000_000,
            ts2 in 1_600_000_000_000_i64..1_800_000_000_000,
        ) {
            let df = df! {
                "timestamp" => &[ts1, ts2, ts1],
                "symbol" => &["BTC", "BTC", "BTC"],
                "close" => &[100.0, 200.0, 150.0],
            }.unwrap();

            let once = merge_and_deduplicate(None, df).unwrap();
            let twice = merge_and_deduplicate(None, once.clone()).unwrap();

            prop_assert_eq!(once.height(), twice.height());
        }

        #[test]
        fn deduplication_never_increases_rows(
            ts1 in 1_600_000_000_000_i64..1_800_000_000_000,
            ts2 in 1_600_000_000_000_i64..1_800_000_000_000,
            ts3 in 1_600_000_000_000_i64..1_800_000_000_000,
        ) {
            let existing = df! {
                "timestamp" => &[ts1, ts2],
                "symbol" => &["BTC", "ETH"],
                "close" => &[100.0, 200.0],
            }.unwrap();

            let new = df! {
                "timestamp" => &[ts2, ts3],
                "symbol" => &["ETH", "BTC"],
                "close" => &[250.0, 300.0],
            }.unwrap();

            let merged = merge_and_deduplicate(Some(existing.clone()), new.clone()).unwrap();

            prop_assert!(merged.height() <= existing.height() + new.height());
        }

        #[test]
        fn get_last_timestamp_returns_max(
            ts1 in 1_600_000_000_000_i64..1_700_000_000_000,
            ts2 in 1_700_000_000_001_i64..1_800_000_000_000,
        ) {
            let df = df! {
                "timestamp" => &[ts1, ts2],
                "symbol" => &["BTC", "BTC"],
            }.unwrap();

            let last = get_last_timestamp_for_symbol(Some(&df), "BTC");
            prop_assert_eq!(last, DateTime::from_timestamp_millis(ts2));
        }

        #[test]
        fn candles_to_dataframe_preserves_count(count in 1_usize..50) {
            let candles: Vec<Candle> = (0..count)
                .map(|i| {
                    let offset = i64::try_from(i).unwrap() * 3_600_000;
                    Candle {
                        timestamp: DateTime::from_timestamp_millis(1_700_000_000_000 + offset).unwrap(),
                        open: 100.0,
                        high: 110.0,
                        low: 90.0,
                        close: 105.0,
                        volume: 1000.0,
                        symbol: Symbol::from_raw("BTC"),
                    }
                })
                .collect();

            let df = candles_to_dataframe(&candles).unwrap();
            prop_assert_eq!(df.height(), count);
        }
    }

    #[test]
    fn symbol_normalizes_real_ccxt_formats() {
        // Real symbols from fixtures/ohlcv1h (1).csv
        assert_eq!(Symbol::from_raw("FRIEND/USDC:USDC").as_str(), "FRIEND");
        assert_eq!(Symbol::from_raw("BTC/USDC:USDC").as_str(), "BTC");
        assert_eq!(Symbol::from_raw("RNDR/USDC:USDC").as_str(), "RNDR");
        assert_eq!(Symbol::from_raw("SHIA/USDC:USDC").as_str(), "SHIA");
        assert_eq!(Symbol::from_raw("kDOGS/USDC:USDC").as_str(), "KDOGS");
        assert_eq!(Symbol::from_raw("CATI/USDC:USDC").as_str(), "CATI");
    }

    #[test]
    fn symbol_handles_simple_symbol() {
        // Hyperliquid SDK returns just the ticker
        assert_eq!(Symbol::from_raw("ETH").as_str(), "ETH");
        assert_eq!(Symbol::from_raw("BTC").as_str(), "BTC");
        assert_eq!(Symbol::from_raw("KPEPE").as_str(), "KPEPE");
    }

    #[test]
    fn symbol_uppercases() {
        assert_eq!(Symbol::from_raw("btc/usdc:usdc").as_str(), "BTC");
        assert_eq!(Symbol::from_raw("kdogs").as_str(), "KDOGS");
    }

    #[test]
    fn timeframe_interval_strings_are_valid() {
        assert_eq!(Timeframe::FifteenMin.interval_string(), "15m");
        assert_eq!(Timeframe::OneHour.interval_string(), "1h");
        assert_eq!(Timeframe::OneDay.interval_string(), "1d");
        assert_eq!(Timeframe::OneWeek.interval_string(), "1w");
    }

    #[test]
    fn timeframe_lookback_increases_with_granularity() {
        assert!(Timeframe::FifteenMin.lookback_days() < Timeframe::OneHour.lookback_days());
        assert!(Timeframe::OneHour.lookback_days() < Timeframe::OneDay.lookback_days());
        assert!(Timeframe::OneDay.lookback_days() < Timeframe::OneWeek.lookback_days());
    }

    #[test]
    fn merge_keeps_latest_for_duplicate_timestamp_symbol() {
        let existing = create_test_df(
            &[1_704_067_200_000, 1_704_070_800_000],
            &["BTC", "BTC"],
            &[100.0, 105.0],
        );

        let new = create_test_df(
            &[1_704_070_800_000, 1_704_074_400_000],
            &["BTC", "BTC"],
            &[106.0, 110.0],
        );

        let merged = merge_and_deduplicate(Some(existing), new).unwrap();

        assert_eq!(merged.height(), 3);
    }

    #[test]
    fn merge_handles_none_existing() {
        let new = create_test_df(&[1_704_067_200_000], &["BTC"], &[100.0]);

        let merged = merge_and_deduplicate(None, new).unwrap();

        assert_eq!(merged.height(), 1);
    }

    #[test]
    fn merge_with_multiple_symbols_deduplicates_per_symbol() {
        // Real scenario: BTC and FRIEND candles at same timestamps
        let existing = df! {
            "timestamp" => &[1_722_553_200_000_i64, 1_722_553_200_000, 1_722_556_800_000],
            "symbol" => &["BTC", "FRIEND", "BTC"],
            "close" => &[65215.0, 8.7362, 65402.0],
        }
        .unwrap();

        let new = df! {
            "timestamp" => &[1_722_556_800_000_i64, 1_722_556_800_000, 1_722_560_400_000],
            "symbol" => &["BTC", "FRIEND", "BTC"],
            "close" => &[65402.0, 8.7265, 64902.0],
        }
        .unwrap();

        let merged = merge_and_deduplicate(Some(existing), new).unwrap();

        // Should have 5 unique (timestamp, symbol) pairs
        assert_eq!(merged.height(), 5);
    }

    #[test]
    fn get_last_timestamp_finds_max_per_symbol() {
        let df = df! {
            "timestamp" => &[1_722_553_200_000_i64, 1_722_556_800_000, 1_722_560_400_000, 1_722_553_200_000],
            "symbol" => &["BTC", "BTC", "BTC", "FRIEND"],
        }
        .unwrap();

        let btc_last = get_last_timestamp_for_symbol(Some(&df), "BTC");
        let friend_last = get_last_timestamp_for_symbol(Some(&df), "FRIEND");
        let eth_last = get_last_timestamp_for_symbol(Some(&df), "ETH");

        assert_eq!(btc_last, DateTime::from_timestamp_millis(1_722_560_400_000));
        assert_eq!(
            friend_last,
            DateTime::from_timestamp_millis(1_722_553_200_000)
        );
        assert!(eth_last.is_none());
    }

    #[test]
    fn get_last_timestamp_handles_none_dataframe() {
        assert!(get_last_timestamp_for_symbol(None, "BTC").is_none());
    }

    #[test]
    fn reads_real_ohlcv_fixture() {
        let path = std::path::Path::new("fixtures/ohlcv_1h.csv");
        let df = read_csv(path).unwrap().unwrap();

        assert_eq!(df.height(), 50);
        assert!(
            df.get_column_names()
                .iter()
                .any(|c| c.as_str() == "timestamp")
        );
        assert!(df.get_column_names().iter().any(|c| c.as_str() == "symbol"));
        assert!(df.get_column_names().iter().any(|c| c.as_str() == "close"));
    }

    #[test]
    fn reads_real_funding_rate_fixture() {
        let path = std::path::Path::new("fixtures/funding_rate_1h.csv");
        let df = read_csv(path).unwrap().unwrap();

        assert_eq!(df.height(), 50);
        assert!(
            df.get_column_names()
                .iter()
                .any(|c| c.as_str() == "timestamp")
        );
        assert!(df.get_column_names().iter().any(|c| c.as_str() == "symbol"));
        assert!(
            df.get_column_names()
                .iter()
                .any(|c| c.as_str() == "funding_rate")
        );
    }

    #[traced_test]
    #[test]
    fn read_csv_nonexistent_returns_none() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("nonexistent.csv");

        let loaded = read_csv(&path).unwrap();

        assert!(loaded.is_none());
        assert!(logs_contain("file not found"));
    }

    #[traced_test]
    #[test]
    fn candle_to_dataframe_produces_correct_output() {
        let candles = sample_candles();
        let df = candles_to_dataframe(&candles).unwrap();

        let columns = df.get_column_names();
        assert!(columns.iter().any(|column| column.as_str() == "timestamp"));
        assert!(columns.iter().any(|column| column.as_str() == "open"));
        assert!(columns.iter().any(|column| column.as_str() == "high"));
        assert!(columns.iter().any(|column| column.as_str() == "low"));
        assert!(columns.iter().any(|column| column.as_str() == "close"));
        assert!(columns.iter().any(|column| column.as_str() == "volume"));
        assert!(columns.iter().any(|column| column.as_str() == "symbol"));
        assert_eq!(df.height(), 2);
        assert!(logs_contain("converting candles to dataframe"));
    }

    #[traced_test]
    #[test]
    fn csv_roundtrip_preserves_data() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.csv");

        let mut original = df! {
            "timestamp" => &[1_704_067_200_000_i64, 1_704_070_800_000],
            "symbol" => &["BTC", "ETH"],
            "close" => &[100.0, 2000.0],
        }
        .unwrap();

        write_csv(&path, &mut original).unwrap();
        let loaded = read_csv(&path).unwrap().unwrap();

        assert_eq!(loaded.height(), original.height());
        assert_eq!(loaded.width(), original.width());
        assert!(logs_contain("wrote csv"));
        assert!(logs_contain("loaded csv"));
    }
}
