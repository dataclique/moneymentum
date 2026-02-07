use std::path::PathBuf;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use polars::prelude::{
    DataFrame, IntoLazy, ParquetReader, ParquetWriter, PlSmallStr, PolarsError, Selector,
    SerReader, SortMultipleOptions, UniqueKeepStrategy, col, df,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IngestionError {
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("SDK error: {0}")]
    Sdk(String),
    #[error("No data available")]
    NoData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timeframe {
    FifteenMin,
    OneHour,
    OneDay,
    OneWeek,
}

impl Timeframe {
    pub fn interval_string(&self) -> &'static str {
        match self {
            Self::FifteenMin => "15m",
            Self::OneHour => "1h",
            Self::OneDay => "1d",
            Self::OneWeek => "1w",
        }
    }

    pub fn lookback_days(&self) -> i64 {
        match self {
            Self::FifteenMin => 30,
            Self::OneHour => 90,
            Self::OneDay => 365,
            Self::OneWeek => 365 * 3,
        }
    }

    pub fn file_name(&self) -> &'static str {
        match self {
            Self::FifteenMin => "ohlcv_15m.parquet",
            Self::OneHour => "ohlcv_1h.parquet",
            Self::OneDay => "ohlcv_1d.parquet",
            Self::OneWeek => "ohlcv_1w.parquet",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol(String);

impl Symbol {
    pub fn from_raw(raw: &str) -> Self {
        let base = raw.split('/').next().unwrap_or(raw);
        Self(base.to_uppercase())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone)]
pub struct Candle {
    pub timestamp: DateTime<Utc>,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub symbol: Symbol,
}

#[derive(Debug, Clone)]
pub struct FundingRate {
    pub timestamp: DateTime<Utc>,
    pub rate: f64,
    pub symbol: Symbol,
}

#[async_trait]
pub trait HyperliquidDataSource: Send + Sync {
    async fn fetch_candles(
        &self,
        symbol: &str,
        timeframe: Timeframe,
        start: DateTime<Utc>,
    ) -> Result<Vec<Candle>, IngestionError>;

    async fn fetch_funding_rates(
        &self,
        symbol: &str,
        start: DateTime<Utc>,
    ) -> Result<Vec<FundingRate>, IngestionError>;

    async fn list_markets(&self) -> Result<Vec<String>, IngestionError>;
}

pub trait Storage: Send + Sync {
    fn read(&self, path: &PathBuf) -> Result<Option<DataFrame>, IngestionError>;
    fn write(&self, path: &PathBuf, df: &mut DataFrame) -> Result<(), IngestionError>;
}

pub fn candles_to_dataframe(candles: &[Candle]) -> Result<DataFrame, IngestionError> {
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

pub fn funding_rates_to_dataframe(rates: &[FundingRate]) -> Result<DataFrame, IngestionError> {
    let timestamps: Vec<i64> = rates
        .iter()
        .map(|rate| rate.timestamp.timestamp_millis())
        .collect();
    let funding_rates: Vec<f64> = rates.iter().map(|rate| rate.rate).collect();
    let symbols: Vec<&str> = rates.iter().map(|rate| rate.symbol.as_str()).collect();

    Ok(df! {
        "timestamp" => timestamps,
        "funding_rate" => funding_rates,
        "symbol" => symbols,
    }?)
}

pub fn merge_and_deduplicate(
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

pub struct ParquetStorage {
    pub data_dir: PathBuf,
}

impl Storage for ParquetStorage {
    fn read(&self, path: &PathBuf) -> Result<Option<DataFrame>, IngestionError> {
        if !path.exists() {
            return Ok(None);
        }

        let file = std::fs::File::open(path)?;
        let df = ParquetReader::new(file).finish()?;
        Ok(Some(df))
    }

    fn write(&self, path: &PathBuf, df: &mut DataFrame) -> Result<(), IngestionError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let file = std::fs::File::create(path)?;
        ParquetWriter::new(file).finish(df)?;
        Ok(())
    }
}

pub struct CandleIngester<D: HyperliquidDataSource, S: Storage> {
    data_source: D,
    storage: S,
}

impl<D: HyperliquidDataSource, S: Storage> CandleIngester<D, S> {
    pub fn new(data_source: D, storage: S) -> Self {
        Self {
            data_source,
            storage,
        }
    }

    pub async fn ingest(&self, _timeframe: Timeframe) -> Result<(), IngestionError> {
        todo!()
    }
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
        assert!(columns.iter().any(|c| c.as_str() == "timestamp"));
        assert!(columns.iter().any(|c| c.as_str() == "open"));
        assert!(columns.iter().any(|c| c.as_str() == "high"));
        assert!(columns.iter().any(|c| c.as_str() == "low"));
        assert!(columns.iter().any(|c| c.as_str() == "close"));
        assert!(columns.iter().any(|c| c.as_str() == "volume"));
        assert!(columns.iter().any(|c| c.as_str() == "symbol"));
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
            &[1704067200000, 1704070800000],
            &["BTC", "BTC"],
            &[100.0, 105.0],
        );

        let new = create_test_df(
            &[1704070800000, 1704074400000],
            &["BTC", "BTC"],
            &[106.0, 110.0],
        );

        let result = merge_and_deduplicate(Some(existing), new).unwrap();

        assert_eq!(result.height(), 3);
    }

    #[test]
    fn merge_handles_none_existing() {
        let new = create_test_df(&[1704067200000], &["BTC"], &[100.0]);

        let result = merge_and_deduplicate(None, new).unwrap();

        assert_eq!(result.height(), 1);
    }

    #[test]
    fn storage_roundtrip_preserves_data() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ParquetStorage {
            data_dir: temp_dir.path().to_path_buf(),
        };

        let path = temp_dir.path().join("test.parquet");
        let mut original = df! {
            "timestamp" => &[1704067200000i64, 1704070800000],
            "symbol" => &["BTC", "ETH"],
            "close" => &[100.0, 2000.0],
        }
        .unwrap();

        storage.write(&path, &mut original).unwrap();
        let loaded = storage.read(&path).unwrap().unwrap();

        assert_eq!(loaded.height(), original.height());
        assert_eq!(loaded.width(), original.width());
    }

    #[test]
    fn storage_read_nonexistent_returns_none() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ParquetStorage {
            data_dir: temp_dir.path().to_path_buf(),
        };

        let path = temp_dir.path().join("nonexistent.parquet");
        let result = storage.read(&path).unwrap();

        assert!(result.is_none());
    }
}
