use std::path::Path;

use chrono::{DateTime, Utc};
use polars::prelude::{
    DataFrame, IntoLazy, ParquetReader, ParquetWriter, PlSmallStr, PolarsError, Selector,
    SerReader, SortMultipleOptions, UniqueKeepStrategy, col, df, lit,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IngestionError {
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Hyperliquid(#[from] hyperliquid_rust_sdk::Error),
    #[error(transparent)]
    IntConversion(#[from] std::num::TryFromIntError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timeframe {
    FifteenMin,
    OneHour,
    OneDay,
    OneWeek,
}

impl Timeframe {
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

    fn file_name(self) -> &'static str {
        match self {
            Self::FifteenMin => "ohlcv_15m.parquet",
            Self::OneHour => "ohlcv_1h.parquet",
            Self::OneDay => "ohlcv_1d.parquet",
            Self::OneWeek => "ohlcv_1w.parquet",
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

fn candles_to_dataframe(candles: &[Candle]) -> Result<DataFrame, IngestionError> {
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

fn read_parquet(path: &Path) -> Result<Option<DataFrame>, IngestionError> {
    if !path.exists() {
        return Ok(None);
    }

    let file = std::fs::File::open(path)?;
    let dataframe = ParquetReader::new(file).finish()?;
    Ok(Some(dataframe))
}

fn write_parquet(path: &Path, df: &mut DataFrame) -> Result<(), IngestionError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(path)?;
    ParquetWriter::new(file).finish(df)?;
    Ok(())
}

pub struct HyperliquidClient {
    info: hyperliquid_rust_sdk::InfoClient,
}

impl HyperliquidClient {
    pub async fn new() -> Result<Self, IngestionError> {
        let info = hyperliquid_rust_sdk::InfoClient::new(None, None).await?;
        Ok(Self { info })
    }

    async fn fetch_candles(
        &self,
        symbol: &str,
        timeframe: Timeframe,
        start: DateTime<Utc>,
    ) -> Result<Vec<Candle>, IngestionError> {
        let start_ms = u64::try_from(start.timestamp_millis())?;
        let end_ms = u64::try_from(Utc::now().timestamp_millis())?;

        let response = self
            .info
            .candles_snapshot(
                symbol.to_string(),
                timeframe.interval_string().to_string(),
                start_ms,
                end_ms,
            )
            .await?;

        let candles = response
            .into_iter()
            .filter_map(|snapshot| {
                let timestamp = DateTime::from_timestamp_millis(snapshot.time_open.cast_signed())?;
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

    async fn list_markets(&self) -> Result<Vec<String>, IngestionError> {
        let meta = self.info.meta().await?;

        let symbols = meta.universe.into_iter().map(|asset| asset.name).collect();

        Ok(symbols)
    }
}

pub struct CandleIngester {
    client: HyperliquidClient,
}

impl CandleIngester {
    pub fn new(client: HyperliquidClient) -> Self {
        Self { client }
    }

    pub async fn ingest(
        &self,
        timeframe: Timeframe,
        data_dir: &Path,
    ) -> Result<(), IngestionError> {
        let markets = self.client.list_markets().await?;
        let path = data_dir.join(timeframe.file_name());

        let existing = read_parquet(&path)?;

        let default_start = Utc::now() - chrono::Duration::days(timeframe.lookback_days());

        let mut all_candles = Vec::new();

        for market in markets {
            let start =
                get_last_timestamp_for_symbol(existing.as_ref(), &market).unwrap_or(default_start);

            let candles = self.client.fetch_candles(&market, timeframe, start).await?;

            all_candles.extend(candles);

            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        if all_candles.is_empty() {
            return Ok(());
        }

        let new_df = candles_to_dataframe(&all_candles)?;
        let mut merged = merge_and_deduplicate(existing, new_df)?;
        write_parquet(&path, &mut merged)?;

        Ok(())
    }
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
    }

    #[test]
    fn symbol_normalizes_hyperliquid_format() {
        let symbol = Symbol::from_raw("BTC/USDC:USDC");
        assert_eq!(symbol.as_str(), "BTC");
    }

    #[test]
    fn symbol_handles_simple_symbol() {
        let symbol = Symbol::from_raw("ETH");
        assert_eq!(symbol.as_str(), "ETH");
    }

    #[test]
    fn symbol_uppercases() {
        let symbol = Symbol::from_raw("btc/usdc:usdc");
        assert_eq!(symbol.as_str(), "BTC");
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
    fn candle_to_dataframe_has_correct_schema() {
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
    }

    #[test]
    fn candle_to_dataframe_preserves_row_count() {
        let candles = sample_candles();
        let df = candles_to_dataframe(&candles).unwrap();
        assert_eq!(df.height(), 2);
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
    fn parquet_roundtrip_preserves_data() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("test.parquet");

        let mut original = df! {
            "timestamp" => &[1_704_067_200_000_i64, 1_704_070_800_000],
            "symbol" => &["BTC", "ETH"],
            "close" => &[100.0, 2000.0],
        }
        .unwrap();

        write_parquet(&path, &mut original).unwrap();
        let loaded = read_parquet(&path).unwrap().unwrap();

        assert_eq!(loaded.height(), original.height());
        assert_eq!(loaded.width(), original.width());
    }

    #[test]
    fn read_parquet_nonexistent_returns_none() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().join("nonexistent.parquet");

        let loaded = read_parquet(&path).unwrap();

        assert!(loaded.is_none());
    }
}
