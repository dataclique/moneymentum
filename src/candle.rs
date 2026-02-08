//! OHLCV candle types and conversion to DataFrame.
//!
//! This module defines the [`Candle`] domain type and converts it to a Polars
//! DataFrame for persistence. Generic DataFrame operations (read/write/merge)
//! live in [`crate::dataframe`].

use std::path::Path;

use chrono::{DateTime, Utc};
use polars::prelude::{DataFrame, IntoLazy, JsonWriter, PolarsError, SerWriter, col, df, lit};
use thiserror::Error;
use tracing::{debug, instrument};

use crate::dataframe::{self, DataFrameError};
use crate::finance::Symbol;
use crate::timeframe::Timeframe;

#[derive(Debug, Error)]
pub(crate) enum CandleError {
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    DataFrame(#[from] DataFrameError),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
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
pub(crate) async fn candles_to_dataframe(candles: Vec<Candle>) -> Result<DataFrame, CandleError> {
    tokio::task::spawn_blocking(move || {
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
    })
    .await?
}

#[instrument(skip_all)]
pub(crate) async fn read_candles_json(
    data_dir: &Path,
    timeframe: Timeframe,
) -> Result<Option<Vec<u8>>, CandleError> {
    let path = data_dir.join(timeframe.file_name());
    let Some(mut dataframe) = dataframe::read_csv(path).await? else {
        return Ok(None);
    };

    let mut buffer = Vec::new();
    JsonWriter::new(&mut buffer).finish(&mut dataframe)?;
    Ok(Some(buffer))
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
    use tracing::Level;
    use tracing_test::traced_test;

    use crate::logs_contain_at;

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

    proptest! {
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
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
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

                let df = candles_to_dataframe(candles).await.unwrap();
                prop_assert_eq!(df.height(), count);
                Ok(())
            })?;
        }
    }

    #[traced_test]
    #[tokio::test]
    async fn candle_to_dataframe_produces_correct_output() {
        let candles = sample_candles();
        let df = candles_to_dataframe(candles).await.unwrap();

        let columns = df.get_column_names();
        assert!(columns.iter().any(|column| column.as_str() == "timestamp"));
        assert!(columns.iter().any(|column| column.as_str() == "open"));
        assert!(columns.iter().any(|column| column.as_str() == "high"));
        assert!(columns.iter().any(|column| column.as_str() == "low"));
        assert!(columns.iter().any(|column| column.as_str() == "close"));
        assert!(columns.iter().any(|column| column.as_str() == "volume"));
        assert!(columns.iter().any(|column| column.as_str() == "symbol"));
        assert_eq!(df.height(), 2);
        assert!(logs_contain_at(
            Level::DEBUG,
            &["converting candles to dataframe"]
        ));
    }

    #[test]
    fn get_last_timestamp_returns_none_for_missing_symbol() {
        let df = df! {
            "timestamp" => &[1_704_067_200_000_i64],
            "symbol" => &["BTC"],
        }
        .unwrap();

        let last = get_last_timestamp_for_symbol(Some(&df), "ETH");
        assert!(last.is_none());
    }

    #[test]
    fn get_last_timestamp_returns_none_for_none_df() {
        let last = get_last_timestamp_for_symbol(None, "BTC");
        assert!(last.is_none());
    }
}
