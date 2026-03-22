use std::marker::PhantomData;

use polars::prelude::{DataFrame, DataType, PolarsError};
use thiserror::Error;
use tracing::debug;

/// Trait marking the semantic meaning of observations in a time series.
///
/// Implement on zero-sized structs to define new observation types.
/// The type system enforces that transformations only accept series
/// with the correct observation semantics -- you cannot pass a price
/// series where a return series is expected.
///
/// Labels compose: `Vol<Return<Simple>>` produces `"simple return vol"`.
pub trait Observation: Send + Sync + 'static {
    /// Human-readable label for diagnostics and logging.
    ///
    /// Returns `String` to support composition of nested markers
    /// (e.g., `Vol<Return<Simple>>` -> `"simple return vol"`).
    fn label() -> String;
}

/// A time-indexed series of observations with semantic type `M`.
///
/// The marker type `M` encodes what the numeric values represent at the
/// type level. Two series with identical f64 data but different markers
/// are incompatible types -- the compiler rejects mixing them.
///
/// Inner `DataFrame` has exactly two columns:
/// - `"timestamp"` (`Datetime`)
/// - `"value"` (`Float64`)
pub struct TimeSeries<M: Observation> {
    df: DataFrame,
    _observation: PhantomData<M>,
}

impl<M: Observation> TimeSeries<M> {
    /// Constructs a new `TimeSeries` after validating the DataFrame schema.
    ///
    /// The DataFrame must contain exactly a `"timestamp"` column with a
    /// temporal dtype and a `"value"` column with `Float64` dtype.
    pub fn new(df: DataFrame) -> Result<Self, SeriesError> {
        let timestamp_col = df
            .column("timestamp")
            .map_err(|_| SeriesError::MissingColumn {
                column: "timestamp".into(),
            })?;

        let timestamp_dtype = timestamp_col.dtype();
        if !timestamp_dtype.is_temporal() {
            return Err(SeriesError::WrongDtype {
                column: "timestamp".into(),
                expected: "temporal".into(),
                actual: format!("{timestamp_dtype}"),
            });
        }

        let value_col = df.column("value").map_err(|_| SeriesError::MissingColumn {
            column: "value".into(),
        })?;

        let value_dtype = value_col.dtype();
        if *value_dtype != DataType::Float64 {
            return Err(SeriesError::WrongDtype {
                column: "value".into(),
                expected: "f64".into(),
                actual: format!("{value_dtype}"),
            });
        }

        debug!(
            observation = M::label(),
            rows = df.height(),
            "time series constructed"
        );

        Ok(Self {
            df,
            _observation: PhantomData,
        })
    }

    /// Borrows the underlying DataFrame.
    pub fn as_dataframe(&self) -> &DataFrame {
        &self.df
    }

    /// Consumes self and returns the underlying DataFrame.
    pub fn into_dataframe(self) -> DataFrame {
        self.df
    }

    /// Number of observations in the series.
    pub fn len(&self) -> usize {
        self.df.height()
    }

    /// Whether the series contains no observations.
    pub fn is_empty(&self) -> bool {
        self.df.height() == 0
    }
}

#[derive(Debug, Error)]
pub enum SeriesError {
    #[error("missing required column: {column}")]
    MissingColumn { column: String },

    #[error("column \"{column}\" has wrong dtype: expected {expected}, got {actual}")]
    WrongDtype {
        column: String,
        expected: String,
        actual: String,
    },

    #[error(transparent)]
    Polars(#[from] PolarsError),
}

#[cfg(test)]
mod tests {
    use polars::prelude::{Column, DataFrame, DataType, NamedFrom, Series, TimeUnit};

    use super::*;
    use crate::marker::Price;

    const DAY_MS: i64 = 86_400_000;

    fn make_timestamps(count: usize) -> Series {
        let epoch_start: i64 = 1_704_067_200_000; // 2024-01-01T00:00:00Z
        let millis: Vec<i64> = (0..count)
            .map(|idx| epoch_start + (idx as i64) * DAY_MS)
            .collect();
        Series::new("timestamp".into(), millis)
            .cast(&DataType::Datetime(TimeUnit::Milliseconds, None))
            .unwrap()
    }

    fn sample_price_df(values: &[f64]) -> DataFrame {
        let timestamps = make_timestamps(values.len());
        let value_series = Series::new("value".into(), values);
        DataFrame::new(vec![Column::from(timestamps), Column::from(value_series)]).unwrap()
    }

    #[test]
    fn valid_price_series_construction() {
        let df = sample_price_df(&[100.0, 101.0, 102.0]);
        let series = TimeSeries::<Price>::new(df);
        assert!(series.is_ok());
        let series = series.unwrap();
        assert_eq!(series.len(), 3);
        assert!(!series.is_empty());
    }

    #[test]
    fn rejects_missing_timestamp_column() {
        let value_series = Series::new("value".into(), &[1.0, 2.0]);
        let df = DataFrame::new(vec![Column::from(value_series)]).unwrap();
        let result = TimeSeries::<Price>::new(df);
        assert!(
            matches!(result, Err(SeriesError::MissingColumn { column }) if column == "timestamp")
        );
    }

    #[test]
    fn rejects_missing_value_column() {
        let timestamps = make_timestamps(2);
        let df = DataFrame::new(vec![Column::from(timestamps)]).unwrap();
        let result = TimeSeries::<Price>::new(df);
        assert!(matches!(result, Err(SeriesError::MissingColumn { column }) if column == "value"));
    }

    #[test]
    fn rejects_wrong_value_dtype() {
        let timestamps = make_timestamps(2);
        let int_values = Series::new("value".into(), &[1_i64, 2_i64]);
        let df = DataFrame::new(vec![Column::from(timestamps), Column::from(int_values)]).unwrap();
        let result = TimeSeries::<Price>::new(df);
        assert!(matches!(result, Err(SeriesError::WrongDtype { .. })));
    }

    #[test]
    fn into_dataframe_round_trips() {
        let df = sample_price_df(&[50.0, 51.0]);
        let original_height = df.height();
        let series = TimeSeries::<Price>::new(df).unwrap();
        let recovered = series.into_dataframe();
        assert_eq!(recovered.height(), original_height);
    }
}
