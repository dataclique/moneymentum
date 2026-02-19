//! Log returns from daily OHLCV candles.
//!
//! Reads `ohlcv_1d.csv` from a data directory and computes per-ticker log returns:
//! `log_return = ln(close_t / close_{t-1})` within each ticker's time series.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::iter::once;
use std::path::{Path, PathBuf};

/// Number of most recent daily candles used to compute log returns for beta.
pub const LOG_RETURNS_LOOKBACK_CANDLES: usize = 101;

use chrono::{Duration, Utc};
use polars::datatypes::AnyValue;
use polars::prelude::{
    ChunkApply, DataFrame, DataFrameJoinOps, IntoLazy, IntoSeries, JoinArgs, JoinType, NamedFrom,
    PolarsError, Series, SortMultipleOptions, SortOptions, col, lit,
};
use thiserror::Error;
use tracing::{debug, info, instrument};

use crate::candle::{CandleError, candles_to_dataframe};
use crate::dataframe::DataFrameError;
use crate::finance::Market;
use crate::hyperliquid::{Hyperliquid, HyperliquidError};
use crate::timeframe::Timeframe;

#[derive(Debug, Error)]
pub enum ReturnsError {
    #[error(transparent)]
    DataFrame(#[from] DataFrameError),
    #[error(transparent)]
    Polars(#[from] PolarsError),
    #[error(transparent)]
    Join(#[from] tokio::task::JoinError),
    #[error(transparent)]
    Hyperliquid(#[from] HyperliquidError),
    #[error(transparent)]
    Candle(#[from] CandleError),
    #[error("no daily candle data at {path}")]
    NoData { path: PathBuf },
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

/// Loads last `LOG_RETURNS_LOOKBACK_CANDLES` daily candles for tickers in `weights` and `benchmark_ticker`,
/// computes log returns, then β = Cov(portfolio, benchmark) / Var(benchmark).
#[instrument(skip_all, fields(data_dir = %data_dir.display(), benchmark = benchmark_ticker))]
pub async fn compute_portfolio_beta(
    data_dir: &Path,
    weights: &[(String, f64)],
    benchmark_ticker: &str,
) -> Result<Option<f64>, ReturnsError> {
    let path = daily_candles_path(data_dir);
    debug!(path = %path.display(), "checking daily candles CSV");
    let df = crate::dataframe::read_csv(path.clone()).await?;
    let Some(df) = df else {
        info!(path = %path.display(), "daily candles CSV not found");
        return Err(ReturnsError::NoData { path: path.clone() });
    };
    debug!(
        path = %path.display(),
        rows = df.height(),
        "daily candles CSV loaded"
    );
    let weights_clone = weights.to_vec();
    let benchmark_ticker_clone = benchmark_ticker.to_string();
    let lookback = LOG_RETURNS_LOOKBACK_CANDLES;
    let log_returns_df = tokio::task::spawn_blocking(move || {
        load_log_returns_last_n_candles(&df, &weights_clone, &benchmark_ticker_clone, lookback)
    })
    .await??;
    compute_beta_from_log_returns(&log_returns_df, weights, benchmark_ticker)
}

/// Fetches daily candles from the API for the tickers in `weights` + `benchmark_ticker`,
/// then computes portfolio beta without needing a local CSV file.
#[instrument(skip_all, fields(benchmark = benchmark_ticker))]
pub(crate) async fn fetch_daily_candles_and_compute_beta(
    client: &dyn Hyperliquid,
    weights: &[(String, f64)],
    benchmark_ticker: &str,
) -> Result<Option<f64>, ReturnsError> {
    let tickers: Vec<String> = weights
        .iter()
        .map(|(ticker, _)| ticker.clone())
        .chain(once(benchmark_ticker.to_string()))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let lookback_days = i64::try_from(LOG_RETURNS_LOOKBACK_CANDLES).unwrap_or(101);
    let start = Utc::now() - Duration::days(lookback_days + 10);

    debug!(
        ?tickers,
        %start,
        lookback_days,
        "fetching daily candles from API"
    );

    let mut all_candles = Vec::new();
    for ticker in &tickers {
        let market = Market::new(ticker.clone());
        let candles = client
            .fetch_candles(&market, Timeframe::OneDay, start)
            .await?;
        debug!(ticker, candles = candles.len(), "fetched daily candles");
        all_candles.extend(candles);
    }

    info!(
        ?tickers,
        candles = all_candles.len(),
        "daily candles fetched from API"
    );

    if all_candles.is_empty() {
        return Err(ReturnsError::NoData {
            path: PathBuf::from("<api>"),
        });
    }

    let df = candles_to_dataframe(all_candles).await?;
    let weights_clone = weights.to_vec();
    let benchmark_clone = benchmark_ticker.to_string();
    let lookback = LOG_RETURNS_LOOKBACK_CANDLES;

    let log_returns_df = tokio::task::spawn_blocking(move || {
        load_log_returns_last_n_candles(&df, &weights_clone, &benchmark_clone, lookback)
    })
    .await??;

    compute_beta_from_log_returns(&log_returns_df, weights, benchmark_ticker)
}

/// Path of the daily candles file relative to the data directory.
fn daily_candles_path(data_dir: &Path) -> PathBuf {
    data_dir.join(Timeframe::OneDay.file_name())
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
        .chain(once(benchmark_ticker.to_string()))
        .collect::<HashSet<_>>()
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

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::{TimeZone, Utc};
    use polars::prelude::df;
    use std::fs;
    use tempfile::TempDir;
    use tracing::Level;
    use tracing_test::traced_test;

    use crate::candle::Candle;
    use crate::finance::{Market, Symbol};
    use crate::funding::FundingRate;
    use crate::hyperliquid::HyperliquidError;

    struct MockHyperliquid {
        candles_by_market: HashMap<String, Vec<Candle>>,
    }

    type OhlcvRow = (f64, f64, f64, f64, f64);

    impl MockHyperliquid {
        fn with_daily_candles(candles_by_ticker: Vec<(&str, Vec<OhlcvRow>)>) -> Self {
            let mut candles_by_market = HashMap::new();
            for (ticker, prices) in candles_by_ticker {
                let candles: Vec<Candle> = prices
                    .into_iter()
                    .enumerate()
                    .map(|(day, (open, high, low, close, volume))| Candle {
                        timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap()
                            + chrono::Duration::days(i64::try_from(day).unwrap()),
                        open,
                        high,
                        low,
                        close,
                        volume,
                        symbol: format!("{ticker}/USDC:USDC"),
                        ticker: Symbol::from_raw(ticker),
                    })
                    .collect();
                candles_by_market.insert(ticker.to_string(), candles);
            }
            Self { candles_by_market }
        }
    }

    #[async_trait]
    impl Hyperliquid for MockHyperliquid {
        async fn list_markets(&self) -> Result<Vec<Market>, HyperliquidError> {
            Ok(self
                .candles_by_market
                .keys()
                .map(|ticker| Market::new(ticker.clone()))
                .collect())
        }

        async fn fetch_candles(
            &self,
            market: &Market,
            _timeframe: Timeframe,
            _start: chrono::DateTime<Utc>,
        ) -> Result<Vec<Candle>, HyperliquidError> {
            Ok(self
                .candles_by_market
                .get(market.as_str())
                .cloned()
                .unwrap_or_default())
        }

        async fn fetch_funding_rates(
            &self,
            _market: &Market,
            _start: chrono::DateTime<Utc>,
        ) -> Result<Vec<FundingRate>, HyperliquidError> {
            Ok(vec![])
        }
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
        let result = compute_portfolio_beta(dir.path(), &[], "BTC").await;
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
    #[tokio::test]
    async fn compute_portfolio_beta_matches_manual_beta_for_ohlcv_1d_data() {
        let tmp_dir = TempDir::new().unwrap();
        let src = Path::new("fixtures/ohlcv_1d_beta.csv");
        let dst = tmp_dir.path().join("ohlcv_1d.csv");
        fs::copy(src, &dst).unwrap();

        // 60% long BTC, 40% short ETH, benchmark BTC
        let weights = [("BTC".to_string(), 0.6_f64), ("ETH".to_string(), -0.4_f64)];

        let beta = compute_portfolio_beta(tmp_dir.path(), &weights, "BTC")
            .await
            .unwrap()
            .expect("beta defined");

        assert!(
            (beta - 0.592_091_722_3_f64).abs() < 1e-10,
            "beta mismatch: got {beta}"
        );
        assert!(crate::logs_contain_at(
            tracing::Level::INFO,
            &["portfolio beta calculated"]
        ));
        assert!(crate::logs_contain_at(
            tracing::Level::DEBUG,
            &["checking daily candles CSV", "ohlcv_1d.csv"]
        ));
        assert!(crate::logs_contain_at(
            tracing::Level::DEBUG,
            &["daily candles CSV loaded"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn fetch_daily_candles_and_compute_beta_self_benchmark_is_one() {
        let mock = MockHyperliquid::with_daily_candles(vec![(
            "BTC",
            vec![
                (100.0, 105.0, 95.0, 102.0, 1000.0),
                (102.0, 108.0, 100.0, 105.0, 1100.0),
                (105.0, 110.0, 103.0, 107.0, 900.0),
                (107.0, 112.0, 104.0, 103.0, 1200.0),
            ],
        )]);

        let weights = [("BTC".to_string(), 1.0)];
        let beta = fetch_daily_candles_and_compute_beta(&mock, &weights, "BTC")
            .await
            .unwrap()
            .expect("beta should be defined");

        assert!(
            (beta - 1.0).abs() < 1e-10,
            "beta of BTC vs self should be 1.0, got {beta}"
        );
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["portfolio beta calculated"]
        ));
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["daily candles fetched from API", "BTC"]
        ));
        assert!(crate::logs_contain_at(
            Level::DEBUG,
            &["fetching daily candles from API", "BTC"]
        ));
        assert!(crate::logs_contain_at(
            Level::DEBUG,
            &["fetched daily candles", "BTC", "4"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn fetch_daily_candles_and_compute_beta_with_multi_asset_portfolio() {
        let mock = MockHyperliquid::with_daily_candles(vec![
            (
                "BTC",
                vec![
                    (100.0, 105.0, 95.0, 100.0, 1000.0),
                    (100.0, 108.0, 95.0, 110.0, 1100.0),
                    (110.0, 115.0, 105.0, 108.0, 900.0),
                    (108.0, 112.0, 104.0, 112.0, 1200.0),
                ],
            ),
            (
                "ETH",
                vec![
                    (50.0, 55.0, 45.0, 50.0, 2000.0),
                    (50.0, 58.0, 48.0, 55.0, 2100.0),
                    (55.0, 60.0, 52.0, 53.0, 1800.0),
                    (53.0, 56.0, 50.0, 56.0, 2200.0),
                ],
            ),
        ]);

        let weights = [("BTC".to_string(), 0.6), ("ETH".to_string(), 0.4)];
        let result = fetch_daily_candles_and_compute_beta(&mock, &weights, "BTC").await;

        assert!(result.is_ok(), "should compute beta: {:?}", result.err());
        let beta = result.unwrap().expect("beta should be defined");
        assert!(beta.is_finite(), "beta should be finite, got {beta}");
        assert!(crate::logs_contain_at(
            Level::INFO,
            &["portfolio beta calculated"]
        ));
        assert!(crate::logs_contain_at(
            Level::DEBUG,
            &["fetched daily candles", "BTC"]
        ));
        assert!(crate::logs_contain_at(
            Level::DEBUG,
            &["fetched daily candles", "ETH"]
        ));
    }
}
