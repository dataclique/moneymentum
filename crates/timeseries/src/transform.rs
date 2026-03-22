use std::future::{Ready, ready};
use std::task::{Context, Poll};

use polars::prelude::{IntoLazy, PolarsError, RollingOptionsFixedWindow, col, lit};
use thiserror::Error;
use tower::Service;
use tracing::debug;

use crate::marker::{Drawdown, LogReturn, Price, RealizedVol, SimpleReturn, ZScore};
use crate::series::{Observation, SeriesError, TimeSeries};

#[derive(Debug, Error)]
pub enum TransformError {
    #[error(transparent)]
    Series(#[from] SeriesError),

    #[error(transparent)]
    Polars(#[from] PolarsError),

    #[error("insufficient observations: need at least {needed}, got {actual}")]
    InsufficientData { needed: usize, actual: usize },
}

/// Computes arithmetic returns from a price series.
///
/// r_t = (P_t - P_{t-1}) / P_{t-1}
///
/// The first observation is dropped (no prior price to diff against).
#[derive(Clone)]
pub struct PriceReturn;

impl Service<TimeSeries<Price>> for PriceReturn {
    type Response = TimeSeries<SimpleReturn>;
    type Error = TransformError;
    type Future = Ready<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, input: TimeSeries<Price>) -> Self::Future {
        ready(compute_simple_returns(input))
    }
}

fn compute_simple_returns(
    input: TimeSeries<Price>,
) -> Result<TimeSeries<SimpleReturn>, TransformError> {
    let row_count = input.len();
    if row_count < 2 {
        return Err(TransformError::InsufficientData {
            needed: 2,
            actual: row_count,
        });
    }

    let df = input.into_dataframe();

    let result = df
        .lazy()
        .with_column((col("value") - col("value").shift(lit(1))) / col("value").shift(lit(1)))
        .collect()?
        .slice(1, row_count - 1);

    debug!(
        observations = result.height(),
        "computed simple returns from prices"
    );

    Ok(TimeSeries::new(result)?)
}

/// Computes logarithmic returns from a price series.
///
/// r_t = ln(P_t / P_{t-1})
///
/// The first observation is dropped (no prior price to diff against).
#[derive(Clone)]
pub struct PriceLogReturn;

impl Service<TimeSeries<Price>> for PriceLogReturn {
    type Response = TimeSeries<LogReturn>;
    type Error = TransformError;
    type Future = Ready<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, input: TimeSeries<Price>) -> Self::Future {
        ready(compute_log_returns(input))
    }
}

fn compute_log_returns(input: TimeSeries<Price>) -> Result<TimeSeries<LogReturn>, TransformError> {
    let row_count = input.len();
    if row_count < 2 {
        return Err(TransformError::InsufficientData {
            needed: 2,
            actual: row_count,
        });
    }

    let df = input.into_dataframe();

    let result = df
        .lazy()
        .with_column((col("value") / col("value").shift(lit(1))).log(lit(std::f64::consts::E)))
        .collect()?
        .slice(1, row_count - 1);

    debug!(
        observations = result.height(),
        "computed log returns from prices"
    );

    Ok(TimeSeries::new(result)?)
}

/// Computes realized volatility as the rolling standard deviation
/// of arithmetic returns over a fixed lookback window.
#[derive(Clone)]
pub struct RollingVolatility {
    window: usize,
}

impl RollingVolatility {
    pub fn new(window: usize) -> Self {
        Self { window }
    }
}

impl Service<TimeSeries<SimpleReturn>> for RollingVolatility {
    type Response = TimeSeries<RealizedVol>;
    type Error = TransformError;
    type Future = Ready<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, input: TimeSeries<SimpleReturn>) -> Self::Future {
        ready(compute_rolling_vol(input, self.window))
    }
}

/// Computes realized volatility as the rolling standard deviation
/// of log returns over a fixed lookback window.
#[derive(Clone)]
pub struct LogRollingVolatility {
    window: usize,
}

impl LogRollingVolatility {
    pub fn new(window: usize) -> Self {
        Self { window }
    }
}

impl Service<TimeSeries<LogReturn>> for LogRollingVolatility {
    type Response = TimeSeries<RealizedVol>;
    type Error = TransformError;
    type Future = Ready<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, input: TimeSeries<LogReturn>) -> Self::Future {
        ready(compute_rolling_vol(input, self.window))
    }
}

fn compute_rolling_vol<M: Observation>(
    input: TimeSeries<M>,
    window: usize,
) -> Result<TimeSeries<RealizedVol>, TransformError> {
    let row_count = input.len();
    if row_count < window {
        return Err(TransformError::InsufficientData {
            needed: window,
            actual: row_count,
        });
    }

    let df = input.into_dataframe();

    let with_rolling = df
        .lazy()
        .with_column(col("value").rolling_std(RollingOptionsFixedWindow {
            window_size: window,
            min_periods: window,
            ..RollingOptionsFixedWindow::default()
        }))
        .collect()?;

    // Drop rows where the rolling window has not yet filled (leading nulls)
    let offset = i64::try_from(window - 1).map_err(|err| {
        TransformError::Polars(PolarsError::ComputeError(
            format!("window conversion: {err}").into(),
        ))
    })?;
    let result = with_rolling.slice(offset, row_count - window + 1);

    debug!(
        window,
        observations = result.height(),
        "computed rolling volatility"
    );

    Ok(TimeSeries::new(result)?)
}

/// Computes drawdown from peak for a price series.
///
/// dd_t = (P_t - max(P_0..P_t)) / max(P_0..P_t)
///
/// Values are non-positive: 0 at peaks, negative during drawdowns.
#[derive(Clone)]
pub struct PeakDrawdown;

impl Service<TimeSeries<Price>> for PeakDrawdown {
    type Response = TimeSeries<Drawdown>;
    type Error = TransformError;
    type Future = Ready<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, input: TimeSeries<Price>) -> Self::Future {
        ready(compute_drawdown(input))
    }
}

fn compute_drawdown(input: TimeSeries<Price>) -> Result<TimeSeries<Drawdown>, TransformError> {
    if input.is_empty() {
        return Err(TransformError::InsufficientData {
            needed: 1,
            actual: 0,
        });
    }

    let df = input.into_dataframe();

    let result = df
        .lazy()
        .with_column(
            ((col("value") - col("value").cum_max(false)) / col("value").cum_max(false))
                .alias("value"),
        )
        .collect()?;

    debug!(observations = result.height(), "computed peak drawdown");

    Ok(TimeSeries::new(result)?)
}

/// Standardizes observations to z-scores: z = (x - mu) / sigma.
///
/// Generic over any observation type -- always produces `TimeSeries<ZScore>`.
#[derive(Clone)]
pub struct Normalize;

impl<M: Observation> Service<TimeSeries<M>> for Normalize {
    type Response = TimeSeries<ZScore>;
    type Error = TransformError;
    type Future = Ready<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, input: TimeSeries<M>) -> Self::Future {
        ready(compute_zscore(input))
    }
}

fn compute_zscore<M: Observation>(
    input: TimeSeries<M>,
) -> Result<TimeSeries<ZScore>, TransformError> {
    if input.len() < 2 {
        return Err(TransformError::InsufficientData {
            needed: 2,
            actual: input.len(),
        });
    }

    let df = input.into_dataframe();

    let result = df
        .lazy()
        .with_column(((col("value") - col("value").mean()) / col("value").std(1)).alias("value"))
        .collect()?;

    debug!(observations = result.height(), "computed z-scores");

    Ok(TimeSeries::new(result)?)
}

#[cfg(test)]
mod tests {
    use polars::prelude::{Column, DataFrame, DataType, NamedFrom, Series, TimeUnit};
    use tracing_test::traced_test;

    use super::*;

    const DAY_MS: i64 = 86_400_000;

    fn sample_price_series(prices: &[f64]) -> TimeSeries<Price> {
        let epoch_start: i64 = 1_704_067_200_000; // 2024-01-01T00:00:00Z
        let millis: Vec<i64> = (0..prices.len())
            .map(|idx| epoch_start + (idx as i64) * DAY_MS)
            .collect();
        let timestamps = Series::new("timestamp".into(), millis)
            .cast(&DataType::Datetime(TimeUnit::Milliseconds, None))
            .unwrap();

        let value_series = Series::new("value".into(), prices);
        let df =
            DataFrame::new(vec![Column::from(timestamps), Column::from(value_series)]).unwrap();

        TimeSeries::new(df).unwrap()
    }

    fn extract_values(ts: &TimeSeries<impl Observation>) -> Vec<f64> {
        ts.as_dataframe()
            .column("value")
            .unwrap()
            .as_materialized_series()
            .f64()
            .unwrap()
            .into_no_null_iter()
            .collect()
    }

    #[traced_test]
    #[test]
    fn price_return_computes_arithmetic_returns() {
        let prices = sample_price_series(&[100.0, 110.0, 99.0, 115.0]);

        let mut service = PriceReturn;
        let result = service.call(prices).into_inner().unwrap();

        assert_eq!(result.len(), 3);
        let values = extract_values(&result);

        let tolerance = 1e-10;
        assert!((values[0] - 0.1).abs() < tolerance); // (110-100)/100
        assert!((values[1] - (-0.1)).abs() < tolerance); // (99-110)/110
        assert!((values[2] - (16.0 / 99.0)).abs() < tolerance); // (115-99)/99

        assert!(logs_contain("computed simple returns from prices"));
    }

    #[traced_test]
    #[test]
    fn price_return_rejects_single_observation() {
        let prices = sample_price_series(&[100.0]);
        let mut service = PriceReturn;
        let result = service.call(prices).into_inner();
        assert!(matches!(
            result,
            Err(TransformError::InsufficientData {
                needed: 2,
                actual: 1
            })
        ));
    }

    #[traced_test]
    #[test]
    fn price_log_return_computes_logarithmic_returns() {
        let prices = sample_price_series(&[100.0, 110.0, 99.0]);

        let mut service = PriceLogReturn;
        let result = service.call(prices).into_inner().unwrap();

        assert_eq!(result.len(), 2);
        let values = extract_values(&result);

        let tolerance = 1e-10;
        assert!((values[0] - (110.0_f64 / 100.0).ln()).abs() < tolerance);
        assert!((values[1] - (99.0_f64 / 110.0).ln()).abs() < tolerance);

        assert!(logs_contain("computed log returns from prices"));
    }

    #[traced_test]
    #[test]
    fn rolling_volatility_over_simple_returns() {
        // 6 prices -> 5 simple returns, window=3 -> 3 vol observations
        let prices = sample_price_series(&[100.0, 102.0, 101.0, 105.0, 103.0, 108.0]);

        let mut return_svc = PriceReturn;
        let returns = return_svc.call(prices).into_inner().unwrap();
        assert_eq!(returns.len(), 5);

        let mut vol_svc = RollingVolatility::new(3);
        let vol = vol_svc.call(returns).into_inner().unwrap();

        assert_eq!(vol.len(), 3);
        let values = extract_values(&vol);

        // All volatility values should be positive
        for value in &values {
            assert!(*value > 0.0, "vol should be positive, got {value}");
        }

        assert!(logs_contain("computed rolling volatility"));
    }

    #[traced_test]
    #[test]
    fn rolling_volatility_rejects_insufficient_data() {
        let prices = sample_price_series(&[100.0, 102.0, 101.0]);
        let mut return_svc = PriceReturn;
        let returns = return_svc.call(prices).into_inner().unwrap();
        // 2 returns, window=5 -> insufficient
        let mut vol_svc = RollingVolatility::new(5);
        let result = vol_svc.call(returns).into_inner();
        assert!(matches!(
            result,
            Err(TransformError::InsufficientData {
                needed: 5,
                actual: 2
            })
        ));
    }

    #[traced_test]
    #[test]
    fn peak_drawdown_computation() {
        // Peak at 120, then drawdown to 90, then partial recovery
        let prices = sample_price_series(&[100.0, 120.0, 90.0, 110.0]);

        let mut service = PeakDrawdown;
        let result = service.call(prices).into_inner().unwrap();

        assert_eq!(result.len(), 4);
        let values = extract_values(&result);

        let tolerance = 1e-10;
        assert!((values[0] - 0.0).abs() < tolerance); // first price is the peak so far
        assert!((values[1] - 0.0).abs() < tolerance); // 120 is new peak
        assert!((values[2] - (-0.25)).abs() < tolerance); // (90-120)/120 = -0.25
        assert!((values[3] - (-1.0 / 12.0)).abs() < tolerance); // (110-120)/120

        assert!(logs_contain("computed peak drawdown"));
    }

    #[traced_test]
    #[test]
    fn normalize_produces_z_scores() {
        let prices = sample_price_series(&[100.0, 200.0, 300.0]);

        let mut service = Normalize;
        let result: TimeSeries<ZScore> = service.call(prices).into_inner().unwrap();

        assert_eq!(result.len(), 3);
        let values = extract_values(&result);

        // Mean = 200, z-scores should be symmetric around 0
        let tolerance = 1e-10;
        assert!((values[0] + values[2]).abs() < tolerance); // symmetric
        assert!((values[1] - 0.0).abs() < tolerance); // mean is zero

        assert!(logs_contain("computed z-scores"));
    }
}
