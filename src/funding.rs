//! Funding rate types and conversion to DataFrame.
//!
//! This module defines the [`FundingRate`] domain type and converts it to a
//! Polars DataFrame for persistence. Generic DataFrame operations live in
//! [`crate::dataframe`].

use chrono::{DateTime, Utc};
use polars::prelude::{DataFrame, IntoLazy, PolarsError, SortMultipleOptions, col, df, lit};
use rust_decimal::Decimal;
use thiserror::Error;
use tracing::{debug, instrument};

use crate::dataframe::DataFrameError;
use crate::finance::Symbol;

#[derive(Debug, Error)]
pub(crate) enum FundingError {
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    DataFrame(#[from] DataFrameError),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
}

#[derive(Debug, Clone)]
pub(crate) struct FundingRate {
    pub(crate) timestamp: DateTime<Utc>,
    pub(crate) rate: Decimal,
    pub(crate) symbol: Symbol,
}

#[instrument(skip_all, fields(count = rates.len()))]
pub(crate) async fn funding_rates_to_dataframe(
    rates: Vec<FundingRate>,
) -> Result<DataFrame, FundingError> {
    tokio::task::spawn_blocking(move || {
        use rust_decimal::prelude::ToPrimitive;

        debug!("converting funding rates to dataframe");
        let timestamps: Vec<i64> = rates
            .iter()
            .map(|rate| rate.timestamp.timestamp_millis())
            .collect();

        // Convert Decimal to f64 for CSV storage (polars doesn't support Decimal natively)
        let funding_rates: Vec<f64> = rates
            .iter()
            .map(|r| r.rate.to_f64().unwrap_or(0.0))
            .collect();
        let symbols: Vec<&str> = rates.iter().map(|rate| rate.symbol.as_str()).collect();

        Ok(df! {
            "timestamp" => timestamps,
            "funding_rate" => funding_rates,
            "symbol" => symbols,
        }?)
    })
    .await?
}

pub(crate) fn get_last_timestamp_for_symbol(
    dataframe: Option<&DataFrame>,
    symbol: &str,
) -> Option<DateTime<Utc>> {
    let df = dataframe?;

    let filtered = df
        .clone()
        .lazy()
        .filter(col("symbol").eq(lit(symbol)))
        .sort_by_exprs([col("timestamp")], SortMultipleOptions::default())
        .collect()
        .ok()?;

    let timestamps = filtered.column("timestamp").ok()?;
    let last_timestamp = timestamps.i64().ok()?.last()?;

    DateTime::from_timestamp_millis(last_timestamp)
}

pub(crate) fn file_name() -> &'static str {
    "funding_rate_1h.csv"
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use rust_decimal_macros::dec;
    use tracing::Level;
    use tracing_test::traced_test;

    use crate::logs_contain_at;

    fn sample_rates() -> Vec<FundingRate> {
        vec![
            FundingRate {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
                rate: dec!(0.0001),
                symbol: Symbol::from_raw("BTC"),
            },
            FundingRate {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 1, 0, 0).unwrap(),
                rate: dec!(0.0002),
                symbol: Symbol::from_raw("ETH"),
            },
        ]
    }

    #[traced_test]
    #[tokio::test]
    async fn funding_rates_to_dataframe_produces_correct_output() {
        let rates = sample_rates();
        let df = funding_rates_to_dataframe(rates).await.unwrap();

        let columns = df.get_column_names();
        assert!(columns.iter().any(|column| column.as_str() == "timestamp"));
        assert!(
            columns
                .iter()
                .any(|column| column.as_str() == "funding_rate")
        );
        assert!(columns.iter().any(|column| column.as_str() == "symbol"));
        assert_eq!(df.height(), 2);
        assert!(logs_contain_at(
            Level::DEBUG,
            &["converting funding rates to dataframe"]
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
