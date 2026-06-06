//! Factor engine: per-asset factor math over ingested OHLCV/funding data.
//!
//! Currently computes per-ticker log returns
//! (`log_return = ln(close_t / close_{t-1})`) and portfolio beta
//! (`Cov(portfolio, benchmark) / Var(benchmark)`) from `ohlcv_1d.csv`.
//! Additional factors (volatility, Sharpe, ...) are added in this module so
//! they share the same returns/covariance primitives.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use chrono::{DateTime, Utc};

/// Daily candles needed for a 365-calendar-day log-return window.
pub const LOG_RETURNS_LOOKBACK_CANDLES: usize = 366;

use polars::datatypes::AnyValue;
use polars::prelude::{
    ChunkApply, DataFrame, DataFrameJoinOps, IntoLazy, IntoSeries, JoinArgs, JoinType, JsonFormat,
    JsonWriter, NamedFrom, PolarsError, SerWriter, Series, SortMultipleOptions, SortOptions, col,
    lit,
};
use thiserror::Error;
use tracing::{info, instrument};

use crate::dataframe::DataFrameError;
use crate::timeframe::{Timeframe, TimeframeConfig};

#[derive(Debug, Clone, PartialEq)]
pub struct PortfolioBetaReport {
    pub beta: Option<f64>,
    pub excluded_tickers: Vec<String>,
    pub effective_weights: BTreeMap<String, f64>,
    pub data_age_hours: i64,
}

#[derive(Debug, Error)]
pub enum ReturnsError {
    #[error(transparent)]
    DataFrame(#[from] DataFrameError),
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
    #[error("no candle data at {path}")]
    NoData { path: std::path::PathBuf },
    #[error("daily candle data has no timestamps")]
    NoTimestamps,
    #[error("invalid candle timestamp: {timestamp}")]
    InvalidTimestamp { timestamp: String },
    #[error("future candle timestamp: {timestamp}")]
    FutureTimestamp { timestamp: String },
    #[error("benchmark variance is zero or insufficient data for beta")]
    BetaUndefined,
}

/// Portfolio beta from precomputed log returns `DataFrame` (e.g. from `load_log_returns_last_n_candles`).
///
/// Takes long-format log returns (`timestamp`, `ticker`, `log_return`) and weights,
/// and returns β = Cov(portfolio, benchmark) / Var(benchmark).
pub fn compute_beta_from_log_returns(
    log_returns_df: &DataFrame,
    weights: &[(String, f64)],
    benchmark_ticker: &str,
) -> Result<Option<f64>, ReturnsError> {
    let pair_df = build_portfolio_and_benchmark_df(log_returns_df, weights, benchmark_ticker)?;

    // Filter once to the common non-null set of observations so covariance
    // and variance use the exact same rows.
    let clean_pair_df = pair_df
        .lazy()
        .drop_nulls(None)
        .collect()
        .map_err(ReturnsError::from)?;

    let portfolio_log_returns = clean_pair_df
        .column("portfolio_log_return")?
        .as_materialized_series()
        .clone();
    let benchmark_series = clean_pair_df
        .column("benchmark_log_return")?
        .as_materialized_series()
        .clone();

    let cov = covariance(&portfolio_log_returns, &benchmark_series)?;
    let var_b = variance(&benchmark_series)?;
    let beta = cov / var_b;
    info!(beta = beta, "portfolio beta calculated");
    Ok(Some(beta))
}

#[instrument(skip_all, fields(data_dir = %data_dir.display()))]
pub async fn compute_portfolio_beta_report(
    data_dir: &Path,
    weights: &[(String, f64)],
    benchmark_ticker: &str,
) -> Result<PortfolioBetaReport, ReturnsError> {
    let path = daily_candles_path(data_dir);
    let df = crate::dataframe::read_csv(path.clone()).await?;
    let Some(df) = df else {
        return Err(ReturnsError::NoData { path: path.clone() });
    };
    let data_age_hours = data_age_hours_at(&df, Utc::now())?;
    let weights_clone = weights.to_vec();
    let benchmark_ticker_clone = benchmark_ticker.to_string();
    let lookback = LOG_RETURNS_LOOKBACK_CANDLES;
    let log_returns_df = tokio::task::spawn_blocking(move || {
        load_log_returns_last_n_candles(&df, &weights_clone, &benchmark_ticker_clone, lookback)
    })
    .await??;
    compute_beta_report_from_log_returns(&log_returns_df, weights, benchmark_ticker, data_age_hours)
}

/// Path of the daily candles file relative to the data directory.
fn daily_candles_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(Timeframe::OneDay.file_name())
}

fn data_age_hours_at(df: &DataFrame, now: DateTime<Utc>) -> Result<i64, ReturnsError> {
    let timestamp_col = df.column("timestamp")?;
    let latest_timestamp = any_value_to_string(timestamp_col.max_reduce()?.as_any_value())
        .ok_or(ReturnsError::NoTimestamps)?;
    let latest_timestamp = DateTime::parse_from_rfc3339(&latest_timestamp)
        .map(|parsed_timestamp| parsed_timestamp.with_timezone(&Utc))
        .map_err(|_| ReturnsError::InvalidTimestamp {
            timestamp: latest_timestamp,
        })?;
    if latest_timestamp > now {
        return Err(ReturnsError::FutureTimestamp {
            timestamp: latest_timestamp.to_rfc3339(),
        });
    }

    Ok(now.signed_duration_since(latest_timestamp).num_hours())
}

fn any_value_to_string(value: AnyValue<'_>) -> Option<String> {
    match value {
        AnyValue::String(timestamp) => Some(timestamp.to_string()),
        AnyValue::StringOwned(timestamp) => Some(timestamp.to_string()),
        _ => None,
    }
}

/// Filters to tickers in `weights` and `benchmark_ticker`, keeps last `lookback` timestamps,
/// computes log returns. Returns `DataFrame` with columns: `timestamp`, `ticker`, `close`, `log_return`.
fn load_log_returns_last_n_candles(
    df: &DataFrame,
    weights: &[(String, f64)],
    benchmark_ticker: &str,
    lookback: usize,
) -> Result<DataFrame, ReturnsError> {
    let tickers: Vec<String> = weights
        .iter()
        .map(|(t, _)| t.clone())
        .chain(std::iter::once(benchmark_ticker.to_string()))
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let ticker_df = DataFrame::new(vec![Series::new("ticker".into(), tickers).into()])?;

    let filtered = df.join(
        &ticker_df,
        ["ticker"],
        ["ticker"],
        JoinArgs::new(JoinType::Inner),
        None,
    )?;

    let ts_col = filtered.column("timestamp")?;
    let unique_ts = ts_col.unique()?.sort(SortOptions::default())?;
    let ts_series = unique_ts.as_materialized_series().clone();
    let n_ts = ts_series.len();
    let start = i64::try_from(n_ts.saturating_sub(lookback)).unwrap_or(0);
    let last_ts_series = ts_series.slice(start, lookback.min(n_ts));
    let ts_window_df = DataFrame::new(vec![last_ts_series.with_name("timestamp".into()).into()])?;

    let windowed = filtered.join(
        &ts_window_df,
        ["timestamp"],
        ["timestamp"],
        JoinArgs::new(JoinType::Inner),
        None,
    )?;

    compute_log_returns(&windowed).map_err(ReturnsError::from)
}

/// Synchronous core: sort by ticker and timestamp, then add `log_return` per group.
fn compute_log_returns(df: &DataFrame) -> Result<DataFrame, PolarsError> {
    let sorted = df
        .clone()
        .lazy()
        .sort(["ticker", "timestamp"], SortMultipleOptions::default())
        .collect()?;

    let close_prev = col("close").shift(lit(1)).over([col("ticker")]);
    let ratio = col("close") / close_prev;

    let mut out = sorted
        .lazy()
        .with_columns([ratio.alias("_ratio")])
        .collect()?;

    let ratio_series = out.column("_ratio")?;
    let log_return_series = ratio_series
        .f64()?
        .apply_values(f64::ln)
        .into_series()
        .with_name("log_return".into());
    out.with_column(log_return_series)?;
    out.drop_in_place("_ratio")?;

    Ok(out)
}

/// Builds a `DataFrame` with columns `portfolio_log_return` and `benchmark_log_return`
/// from long-format log returns (timestamp, ticker, `log_return`) and weighted portfolio.
/// Rows are aligned by timestamp; null where any required ticker is missing.
fn build_portfolio_and_benchmark_df(
    log_returns_df: &DataFrame,
    weights: &[(String, f64)],
    benchmark_ticker: &str,
) -> Result<DataFrame, ReturnsError> {
    let ts_col = log_returns_df.column("timestamp")?;
    let ticker_col = log_returns_df.column("ticker")?;
    let log_return_col = log_returns_df.column("log_return")?;

    // Group log returns by timestamp once (O(rows)), instead of scanning the
    // full DataFrame for every timestamp (O(timestamps × rows)).
    let mut returns_by_timestamp: BTreeMap<String, HashMap<String, Option<f64>>> = BTreeMap::new();

    for row_idx in 0..log_returns_df.height() {
        let Some(ts_value) = ts_col.get(row_idx).ok() else {
            continue;
        };
        let timestamp = match ts_value {
            AnyValue::String(s) => s.to_string(),
            AnyValue::StringOwned(s) => s.to_string(),
            _ => continue,
        };

        let ticker = ticker_col.get(row_idx).ok().and_then(|av| match av {
            AnyValue::String(s) => Some(s.to_string()),
            AnyValue::StringOwned(s) => Some(s.to_string()),
            _ => None,
        });
        let Some(ticker) = ticker else {
            continue;
        };

        let log_return = log_return_col
            .get(row_idx)
            .ok()
            .and_then(|v| v.try_extract::<f64>().ok());

        let entry = returns_by_timestamp.entry(timestamp).or_default();
        entry.insert(ticker, log_return);
    }

    let mut portfolio = Vec::with_capacity(returns_by_timestamp.len());
    let mut benchmark = Vec::with_capacity(returns_by_timestamp.len());

    for (_timestamp, row_returns) in returns_by_timestamp {
        let mut sum = 0.0_f64;
        let mut any_null = false;

        for (ticker, weight) in weights {
            if let Some(r) = row_returns.get(ticker).and_then(|v| *v) {
                sum += weight * r;
            } else {
                any_null = true;
                break;
            }
        }
        portfolio.push(if any_null { None } else { Some(sum) });

        let bench = row_returns.get(benchmark_ticker).and_then(|v| *v);
        benchmark.push(bench);
    }

    let portfolio_series = Series::new("portfolio_log_return".into(), portfolio);
    let benchmark_series = Series::new("benchmark_log_return".into(), benchmark);
    DataFrame::new(vec![portfolio_series.into(), benchmark_series.into()])
        .map_err(ReturnsError::from)
}

fn compute_beta_report_from_log_returns(
    log_returns_df: &DataFrame,
    weights: &[(String, f64)],
    benchmark_ticker: &str,
    data_age_hours: i64,
) -> Result<PortfolioBetaReport, ReturnsError> {
    let return_timestamps = finite_return_timestamps_by_ticker(log_returns_df)?;
    let benchmark_return_timestamps = return_timestamps
        .get(benchmark_ticker)
        .ok_or(ReturnsError::BetaUndefined)?;
    if benchmark_return_timestamps.is_empty() {
        return Err(ReturnsError::BetaUndefined);
    }

    let (included_weights, excluded_tickers): (Vec<_>, Vec<_>) =
        weights.iter().cloned().partition(|(ticker, _weight)| {
            return_timestamps
                .get(ticker)
                .is_some_and(|ticker_return_timestamps| {
                    ticker_return_timestamps == benchmark_return_timestamps
                })
        });

    let effective_weights = match renormalize_abs_weights(&included_weights) {
        Ok(effective_weights) => effective_weights,
        Err(ReturnsError::BetaUndefined) => {
            return Ok(PortfolioBetaReport {
                beta: None,
                excluded_tickers: excluded_tickers
                    .into_iter()
                    .map(|(ticker, _weight)| ticker)
                    .collect(),
                effective_weights: BTreeMap::new(),
                data_age_hours,
            });
        }
        Err(err) => return Err(err),
    };
    let beta_weights = effective_weights
        .iter()
        .map(|(ticker, weight)| (ticker.clone(), *weight))
        .collect::<Vec<_>>();
    let beta = compute_beta_from_log_returns(log_returns_df, &beta_weights, benchmark_ticker)?;

    Ok(PortfolioBetaReport {
        beta,
        excluded_tickers: excluded_tickers
            .into_iter()
            .map(|(ticker, _weight)| ticker)
            .collect(),
        effective_weights,
        data_age_hours,
    })
}

fn finite_return_timestamps_by_ticker(
    log_returns_df: &DataFrame,
) -> Result<HashMap<String, BTreeSet<String>>, ReturnsError> {
    let timestamp_col = log_returns_df.column("timestamp")?;
    let ticker_col = log_returns_df.column("ticker")?;
    let log_return_col = log_returns_df.column("log_return")?;
    let mut return_timestamps = HashMap::new();

    for row_index in 0..log_returns_df.height() {
        let timestamp = timestamp_col
            .get(row_index)
            .ok()
            .and_then(|value| match value {
                AnyValue::String(timestamp) => Some(timestamp.to_string()),
                AnyValue::StringOwned(timestamp) => Some(timestamp.to_string()),
                _ => None,
            });
        let Some(timestamp) = timestamp else {
            continue;
        };

        let ticker = ticker_col
            .get(row_index)
            .ok()
            .and_then(|value| match value {
                AnyValue::String(ticker) => Some(ticker.to_string()),
                AnyValue::StringOwned(ticker) => Some(ticker.to_string()),
                _ => None,
            });
        let Some(ticker) = ticker else {
            continue;
        };
        let has_return = log_return_col
            .get(row_index)
            .ok()
            .and_then(|value| value.try_extract::<f64>().ok())
            .is_some_and(f64::is_finite);
        if has_return {
            return_timestamps
                .entry(ticker)
                .or_insert_with(BTreeSet::new)
                .insert(timestamp);
        }
    }

    Ok(return_timestamps)
}

fn renormalize_abs_weights(
    weights: &[(String, f64)],
) -> Result<BTreeMap<String, f64>, ReturnsError> {
    let absolute_weight_sum = weights
        .iter()
        .map(|(_ticker, weight)| weight.abs())
        .sum::<f64>();
    if absolute_weight_sum <= 0.0 {
        return Err(ReturnsError::BetaUndefined);
    }

    Ok(weights
        .iter()
        .map(|(ticker, weight)| (ticker.clone(), weight / absolute_weight_sum))
        .collect())
}

/// Covariance of two return series. `Cov(P, B) = E[(P - μ_P)(B - μ_B)]`.
fn covariance(portfolio: &Series, benchmark: &Series) -> Result<f64, ReturnsError> {
    let df = DataFrame::new(vec![portfolio.clone().into(), benchmark.clone().into()])
        .map_err(ReturnsError::from)?;
    let out = df
        .lazy()
        .select([
            ((col("portfolio_log_return") - col("portfolio_log_return").mean())
                * (col("benchmark_log_return") - col("benchmark_log_return").mean()))
            .mean()
            .alias("_cov"),
        ])
        .collect()?;
    out.column("_cov")?
        .get(0)
        .ok()
        .and_then(|v| v.try_extract::<f64>().ok())
        .ok_or(ReturnsError::BetaUndefined)
}

/// Variance of a return series. `Var(B) = E[(B - μ_B)²]`.
fn variance(benchmark: &Series) -> Result<f64, ReturnsError> {
    let df = DataFrame::new(vec![benchmark.clone().into()]).map_err(ReturnsError::from)?;
    let out = df
        .lazy()
        .select([
            (col("benchmark_log_return") - col("benchmark_log_return").mean())
                .pow(lit(2))
                .mean()
                .alias("_var"),
        ])
        .collect()?;
    let variance = out
        .column("_var")?
        .get(0)
        .ok()
        .and_then(|x| x.try_extract::<f64>().ok())
        .ok_or(ReturnsError::BetaUndefined)?;
    if variance.abs() < 1e-20 {
        return Err(ReturnsError::BetaUndefined);
    }
    Ok(variance)
}

/// Per-ticker factor scores from a timeframe's candles.
///
/// For each ticker, over the last `lookback_periods` daily log returns:
/// - `annualized_volatility` = sample stddev (ddof=1) * sqrt(annualized_factor)
/// - `cum_return` = exp(sum of log returns) - 1 (cumulative / momentum return)
///
/// Returns a `DataFrame` keyed by `ticker`. New factors are added as columns.
#[instrument(skip_all, fields(data_dir = %data_dir.display()))]
pub(crate) async fn compute_factors(
    data_dir: &Path,
    timeframe: Timeframe,
) -> Result<DataFrame, ReturnsError> {
    let path = data_dir.join(timeframe.file_name());
    let df = crate::dataframe::read_csv(path.clone()).await?;
    let Some(df) = df else {
        return Err(ReturnsError::NoData { path });
    };
    let config = timeframe.config();
    let out = tokio::task::spawn_blocking(move || per_ticker_factors(&df, &config)).await??;
    info!(tickers = out.height(), "factors computed");
    Ok(out)
}

/// Synchronous core: log returns per ticker, then per-ticker factor scores over
/// the last `lookback_periods` returns. Stddev uses ddof=1 to match the legacy
/// Spark `stddev`; the cumulative return is `exp(sum) - 1`.
fn per_ticker_factors(
    candles: &DataFrame,
    config: &TimeframeConfig,
) -> Result<DataFrame, PolarsError> {
    let with_returns = compute_log_returns(candles)?;
    let lookback = config.lookback_periods;
    let annualizer = config.annualized_factor.sqrt();
    let mut factors = with_returns
        .lazy()
        .group_by([col("ticker")])
        .agg([
            (col("log_return").tail(Some(lookback)).std(1) * lit(annualizer))
                .alias("annualized_volatility"),
            col("log_return")
                .tail(Some(lookback))
                .sum()
                .alias("cum_log_return"),
        ])
        .sort(["ticker"], SortMultipleOptions::default())
        .collect()?;

    // cum_return = exp(sum of log returns) - 1. exp is applied on the series
    // (like compute_log_returns does for ln) to avoid a polars math-expr feature.
    let cum_return = factors
        .column("cum_log_return")?
        .f64()?
        .apply_values(f64::exp_m1)
        .into_series()
        .with_name("cum_return".into());
    factors.with_column(cum_return)?;
    factors.drop_in_place("cum_log_return")?;
    Ok(factors)
}

/// Per-ticker factor scores serialized as a JSON array, for the `/factors`
/// endpoint. Currently exposes `annualized_volatility`; further factors are
/// added as columns here as they land.
pub(crate) async fn compute_factors_json(
    data_dir: &Path,
    timeframe: Timeframe,
) -> Result<Vec<u8>, ReturnsError> {
    let mut factors = compute_factors(data_dir, timeframe).await?;
    let mut buf = Vec::new();
    JsonWriter::new(&mut buf)
        .with_json_format(JsonFormat::Json)
        .finish(&mut factors)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use polars::prelude::df;
    use proptest::prelude::*;
    use std::fs;
    use tempfile::TempDir;
    use tracing_test::traced_test;

    proptest! {
        /// `log_return` equals `ln(close_t / close_{t-1})` for any positive close series.
        #[test]
        fn log_returns_are_ln_of_close_ratio(
            closes in prop::collection::vec(1.0_f64..1_000_000.0, 2..30),
        ) {
            let n = closes.len();
            let timestamps: Vec<String> = (0..n).map(|i| format!("{i:04}")).collect();
            let tickers = vec!["BTC"; n];
            let frame = df! {
                "timestamp" => timestamps,
                "ticker" => tickers,
                "close" => closes.clone(),
            }
            .unwrap();

            let out = compute_log_returns(&frame).unwrap();
            let log_return = out.column("log_return").unwrap();

            prop_assert!(log_return.get(0).unwrap().is_null());
            for (idx, pair) in closes.windows(2).enumerate() {
                let expected = (pair[1] / pair[0]).ln();
                let actual = log_return.get(idx + 1).unwrap().try_extract::<f64>().unwrap();
                prop_assert!((actual - expected).abs() < 1e-9);
            }
        }

        /// For a single-ticker portfolio measured against that same ticker,
        /// `beta = Cov(w*r, r) / Var(r) = w` whenever `Var(r) > 0`.
        #[traced_test]
        #[test]
        fn single_ticker_beta_equals_weight(
            returns in prop::collection::vec(-0.5_f64..0.5, 3..40),
            weight in -5.0_f64..5.0,
        ) {
            prop_assume!(returns.windows(2).any(|pair| (pair[0] - pair[1]).abs() > 1e-6));
            let n = returns.len();
            let timestamps: Vec<String> = (0..n).map(|i| format!("{i:04}")).collect();
            let tickers = vec!["BTC"; n];
            let frame = df! {
                "timestamp" => timestamps,
                "ticker" => tickers,
                "log_return" => returns,
            }
            .unwrap();

            let weights = [("BTC".to_string(), weight)];
            let beta = compute_beta_from_log_returns(&frame, &weights, "BTC")
                .unwrap()
                .unwrap();
            prop_assert!((beta - weight).abs() < 1e-9, "beta {beta} != weight {weight}");
            prop_assert!(crate::logs_contain_at(
                tracing::Level::INFO,
                &["portfolio beta calculated", "beta"]
            ));
        }
    }

    proptest! {
        /// Volatility is a scaled standard deviation, so it is always finite and
        /// non-negative for any positive close series.
        #[test]
        fn volatility_is_non_negative(
            closes in prop::collection::vec(1.0_f64..1_000_000.0, 3..50),
        ) {
            let n = closes.len();
            let timestamps: Vec<String> = (0..n).map(|i| format!("{i:04}")).collect();
            let tickers = vec!["BTC"; n];
            let candles = df! {
                "timestamp" => timestamps,
                "ticker" => tickers,
                "close" => closes,
            }
            .unwrap();
            let config = TimeframeConfig { lookback_periods: 100, annualized_factor: 365.0 };

            let out = per_ticker_factors(&candles, &config).unwrap();
            let vol = out
                .column("annualized_volatility")
                .unwrap()
                .f64()
                .unwrap()
                .get(0)
                .unwrap();
            prop_assert!(vol >= 0.0, "volatility must be non-negative, got {vol}");
            prop_assert!(vol.is_finite());

            let cum = out
                .column("cum_return")
                .unwrap()
                .f64()
                .unwrap()
                .get(0)
                .unwrap();
            prop_assert!(cum.is_finite(), "cum_return must be finite, got {cum}");
        }
    }

    #[test]
    fn per_ticker_factors_match_manual_values() {
        let candles = df! {
            "timestamp" => &["0", "1", "2", "3", "4"],
            "ticker" => &["BTC", "BTC", "BTC", "BTC", "BTC"],
            "close" => &[100.0, 101.0, 100.0, 101.0, 100.0_f64],
        }
        .unwrap();
        let config = TimeframeConfig {
            lookback_periods: 10,
            annualized_factor: 365.0,
        };

        let out = per_ticker_factors(&candles, &config).unwrap();
        let vol = out
            .column("annualized_volatility")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();

        // log returns are [a, -a, a, -a] with a = ln(1.01), mean 0, so the
        // sample variance is 4a^2/3 and volatility = sqrt(4a^2/3) * sqrt(365).
        let a = (101.0_f64 / 100.0).ln();
        let expected = (4.0 * a * a / 3.0).sqrt() * 365.0_f64.sqrt();
        assert!(
            (vol - expected).abs() < 1e-10,
            "vol {vol} != expected {expected}"
        );

        // log returns sum to a - a + a - a = 0, so cum_return = exp(0) - 1 = 0.
        let cum = out
            .column("cum_return")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(cum.abs() < 1e-12, "cum_return should be ~0, got {cum}");
    }

    #[test]
    fn per_ticker_factors_are_zero_for_constant_prices() {
        let candles = df! {
            "timestamp" => &["0", "1", "2", "3"],
            "ticker" => &["BTC", "BTC", "BTC", "BTC"],
            "close" => &[100.0, 100.0, 100.0, 100.0_f64],
        }
        .unwrap();
        let config = TimeframeConfig {
            lookback_periods: 10,
            annualized_factor: 365.0,
        };

        let out = per_ticker_factors(&candles, &config).unwrap();
        let vol = out
            .column("annualized_volatility")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            vol.abs() < 1e-12,
            "constant prices give zero volatility, got {vol}"
        );

        let cum = out
            .column("cum_return")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            cum.abs() < 1e-12,
            "constant prices give zero cum_return, got {cum}"
        );
    }

    #[traced_test]
    #[tokio::test]
    async fn compute_factors_reads_candles_and_logs() {
        let tmp_dir = TempDir::new().unwrap();
        let src = Path::new("fixtures/ohlcv_1d_beta.csv");
        let dst = tmp_dir.path().join("ohlcv_1d.csv");
        fs::copy(src, &dst).unwrap();

        let out = compute_factors(tmp_dir.path(), Timeframe::OneDay)
            .await
            .unwrap();

        assert!(out.height() > 0, "expected a factor row per ticker");
        assert!(out.column("annualized_volatility").is_ok());
        assert!(out.column("cum_return").is_ok());
        assert!(crate::logs_contain_at(
            tracing::Level::INFO,
            &["factors computed"]
        ));
    }

    #[test]
    fn daily_candles_path_uses_ohlcv_1d() {
        let dir = TempDir::new().unwrap();
        let path = daily_candles_path(dir.path());
        assert!(path.ends_with("ohlcv_1d.csv"));
    }

    #[tokio::test]
    async fn compute_portfolio_beta_errors_when_daily_candles_file_missing() {
        let dir = TempDir::new().unwrap();
        let result = compute_portfolio_beta_report(dir.path(), &[], "BTC").await;
        assert!(matches!(result, Err(ReturnsError::NoData { .. })));
    }

    #[test]
    fn compute_log_returns_produces_ln_ratio() {
        let df = df! {
            "timestamp" => &["2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z"],
            "ticker" => &["BTC", "BTC", "BTC"],
            "close" => &[100.0, 102.0, 99.0_f64],
        }
        .unwrap();

        let out = compute_log_returns(&df).unwrap();
        let log_return = out.column("log_return").unwrap();
        assert!(
            log_return.get(0).unwrap().is_null(),
            "first row has no previous close"
        );
        let r1 = log_return.get(1).unwrap().try_extract::<f64>().unwrap();
        let r2 = log_return.get(2).unwrap().try_extract::<f64>().unwrap();
        assert!((r1 - (102.0_f64 / 100.0).ln()).abs() < 1e-10);
        assert!((r2 - (99.0_f64 / 102.0).ln()).abs() < 1e-10);
    }

    #[test]
    fn data_age_hours_uses_most_recent_candle_timestamp() {
        let df = df! {
            "timestamp" => &["2024-01-01T00:00:00.000Z", "2024-01-02T00:00:00.000Z"],
            "ticker" => &["BTC", "ETH"],
            "close" => &[100.0, 200.0],
        }
        .unwrap();
        let now = DateTime::parse_from_rfc3339("2024-01-03T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);

        let age_hours = data_age_hours_at(&df, now).unwrap();

        assert_eq!(age_hours, 36);
    }

    #[test]
    fn data_age_hours_rejects_future_candle_timestamp() {
        let df = df! {
            "timestamp" => &["2024-01-04T00:00:00.000Z"],
            "ticker" => &["BTC"],
            "close" => &[100.0],
        }
        .unwrap();
        let now = DateTime::parse_from_rfc3339("2024-01-03T12:00:00.000Z")
            .unwrap()
            .with_timezone(&Utc);

        let age_hours = data_age_hours_at(&df, now);

        assert!(matches!(
            age_hours,
            Err(ReturnsError::FutureTimestamp { .. })
        ));
    }

    #[traced_test]
    #[test]
    fn compute_beta_from_log_returns_portfolio_vs_self_benchmark_is_one() {
        let log_returns_df = df! {
            "timestamp" => &["2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z"],
            "ticker" => &["BTC", "BTC", "BTC"],
            "log_return" => &[0.01_f64, -0.02, 0.015],
        }
        .unwrap();
        let weights = [("BTC".to_string(), 1.0)];
        let result = compute_beta_from_log_returns(&log_returns_df, &weights, "BTC").unwrap();
        let b = result.expect("beta defined");
        assert!(
            (b - 1.0).abs() < 1e-10,
            "beta of portfolio vs self should be 1, got {b}"
        );
        assert!(crate::logs_contain_at(
            tracing::Level::INFO,
            &["portfolio beta calculated"]
        ));
    }

    #[test]
    fn compute_beta_from_log_returns_errors_when_benchmark_variance_zero() {
        let log_returns_df = df! {
            "timestamp" => &["2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z"],
            "ticker" => &["BTC", "BTC"],
            "log_return" => &[0.0_f64, 0.0],
        }
        .unwrap();
        let weights = [("BTC".to_string(), 1.0)];
        let result = compute_beta_from_log_returns(&log_returns_df, &weights, "BTC");
        assert!(matches!(result, Err(ReturnsError::BetaUndefined)));
    }

    #[traced_test]
    #[test]
    fn beta_report_excludes_missing_assets_and_renormalizes_remaining_weights() {
        let log_returns_df = df! {
            "timestamp" => &[
                "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z",
                "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z",
                "2024-01-02T00:00:00Z",
            ],
            "ticker" => &["BTC", "BTC", "BTC", "ETH", "ETH", "ETH", "DOGE"],
            "log_return" => &[0.01_f64, -0.02, 0.015, 0.01, -0.02, 0.015, 0.04],
        }
        .unwrap();
        let weights = [("ETH".to_string(), 0.4_f64), ("DOGE".to_string(), -0.6_f64)];

        let report = compute_beta_report_from_log_returns(&log_returns_df, &weights, "BTC", 12)
            .expect("beta report");

        assert_eq!(report.excluded_tickers, vec!["DOGE"]);
        assert_eq!(report.effective_weights.get("ETH"), Some(&1.0));
        assert_eq!(report.data_age_hours, 12);
        assert!((report.beta.expect("beta") - 1.0).abs() < 1e-10);
        assert!(crate::logs_contain_at(
            tracing::Level::INFO,
            &["portfolio beta calculated"]
        ));
    }

    #[traced_test]
    #[test]
    fn beta_report_returns_none_when_all_portfolio_assets_are_excluded() {
        let log_returns_df = df! {
            "timestamp" => &[
                "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z",
                "2024-01-02T00:00:00Z",
            ],
            "ticker" => &["BTC", "BTC", "BTC", "DOGE"],
            "log_return" => &[0.01_f64, -0.02, 0.015, 0.04],
        }
        .unwrap();
        let weights = [("DOGE".to_string(), -1.0_f64)];

        let report = compute_beta_report_from_log_returns(&log_returns_df, &weights, "BTC", 2)
            .expect("beta report");

        assert_eq!(report.beta, None);
        assert_eq!(report.excluded_tickers, vec!["DOGE"]);
        assert!(report.effective_weights.is_empty());
        assert_eq!(report.data_age_hours, 2);

        // The log buffer is process-global, so other tests legitimately logging
        // "portfolio beta calculated" would trip a bare negative assertion.
        // Scope it to this test's own span (traced_test prefixes every line
        // emitted here with the test name).
        assert!(!crate::logs_contain_at(
            tracing::Level::INFO,
            &[
                "beta_report_returns_none_when_all_portfolio_assets_are_excluded",
                "portfolio beta calculated",
            ]
        ));
    }

    #[traced_test]
    #[test]
    fn beta_report_excludes_assets_with_same_return_count_but_different_timestamps() {
        let log_returns_df = df! {
            "timestamp" => &[
                "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z",
                "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z",
                "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z", "2024-01-04T00:00:00Z",
            ],
            "ticker" => &["BTC", "BTC", "BTC", "ETH", "ETH", "ETH", "DOGE", "DOGE", "DOGE"],
            "log_return" => &[0.01_f64, -0.02, 0.015, 0.01, -0.02, 0.015, 0.02, -0.01, 0.03],
        }
        .unwrap();
        let weights = [("ETH".to_string(), 0.4_f64), ("DOGE".to_string(), -0.6_f64)];

        let report = compute_beta_report_from_log_returns(&log_returns_df, &weights, "BTC", 12)
            .expect("beta report");

        assert_eq!(report.excluded_tickers, vec!["DOGE"]);
        assert_eq!(report.effective_weights.get("ETH"), Some(&1.0));
        assert_eq!(report.data_age_hours, 12);
        assert!((report.beta.expect("beta") - 1.0).abs() < 1e-10);
        assert!(crate::logs_contain_at(
            tracing::Level::INFO,
            &["portfolio beta calculated"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn compute_portfolio_beta_matches_manual_beta_for_ohlcv_1d_data() {
        let tmp_dir = TempDir::new().unwrap();
        let src = Path::new("fixtures/ohlcv_1d_beta.csv");
        let dst = tmp_dir.path().join("ohlcv_1d.csv");
        fs::copy(src, &dst).unwrap();

        // 60% long BTC, 40% short ETH, benchmark BTC
        let weights = [("BTC".to_string(), 0.6_f64), ("ETH".to_string(), -0.4_f64)];

        let report = compute_portfolio_beta_report(tmp_dir.path(), &weights, "BTC")
            .await
            .unwrap()
            .beta;
        let beta = report.expect("beta defined");

        assert!(
            (beta - 0.592_091_722_3_f64).abs() < 1e-10,
            "beta mismatch: got {beta}"
        );
        assert!(crate::logs_contain_at(
            tracing::Level::INFO,
            &["portfolio beta calculated"]
        ));
    }
}
