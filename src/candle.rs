use std::path::Path;

use chrono::{DateTime, Utc};
use polars::prelude::{
    CsvReader, CsvWriter, DataFrame, IntoLazy, JsonWriter, PlSmallStr, PolarsError, Selector,
    SerReader, SerWriter, SortMultipleOptions, UniqueKeepStrategy, col, df, lit,
};
use thiserror::Error;
use tracing::{debug, instrument};

use crate::finance::Symbol;
use crate::timeframe::Timeframe;

#[derive(Debug, Error)]
pub(crate) enum CandleError {
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub(crate) struct Candle {
    pub(crate) timestamp: DateTime<Utc>,
    pub(crate) open: f64,
    pub(crate) high: f64,
    pub(crate) low: f64,
    pub(crate) close: f64,
    pub(crate) volume: f64,
    pub(crate) symbol: Symbol,
}

#[instrument(skip_all, fields(count = candles.len()))]
pub(crate) fn candles_to_dataframe(candles: &[Candle]) -> Result<DataFrame, CandleError> {
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

pub(crate) fn merge_and_deduplicate(
    existing: Option<DataFrame>,
    new: DataFrame,
) -> Result<DataFrame, CandleError> {
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
pub(crate) fn read_csv(path: &Path) -> Result<Option<DataFrame>, CandleError> {
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
) -> Result<Option<Vec<u8>>, CandleError> {
    let path = data_dir.join(timeframe.file_name());
    let Some(mut dataframe) = read_csv(&path)? else {
        return Ok(None);
    };

    let mut buffer = Vec::new();
    JsonWriter::new(&mut buffer).finish(&mut dataframe)?;
    Ok(Some(buffer))
}

#[instrument(skip_all, fields(path = %path.display()))]
pub(crate) fn write_csv(path: &Path, df: &mut DataFrame) -> Result<(), CandleError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(path)?;
    CsvWriter::new(file).finish(df)?;
    debug!(rows = df.height(), "wrote csv");
    Ok(())
}

pub(crate) fn get_last_timestamp_for_symbol(
    df: Option<&DataFrame>,
    symbol: &str,
) -> Option<DateTime<Utc>> {
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
    use polars::prelude::df;
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
