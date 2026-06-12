//! Per-ticker factor scores for the screener, computed over a timeframe's
//! lookback window and served by the `/factors` endpoint.

use std::path::Path;

use polars::prelude::{
    ChunkApply, DataFrame, IntoLazy, IntoSeries, JsonFormat, JsonWriter, NULL, PolarsError,
    SerWriter, SortMultipleOptions, col, lit, when,
};
use tracing::{info, instrument};

use super::ReturnsError;
use super::returns::compute_log_returns;
use crate::timeframe::{Timeframe, TimeframeConfig};

const PRICE_STDDEV_EPS: f64 = 1e-8;

/// Per-ticker factor scores serialized as a JSON array, for the `/factors`
/// endpoint. Exposes `annualized_volatility`, `cum_return`, `sma`,
/// `mean_return`, and `price_zscore`; further factors are added as columns as
/// they land.
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

/// Per-ticker factor scores from a timeframe's candles.
///
/// For each ticker, over the last `lookback_periods` candles:
/// - `annualized_volatility` = sample stddev (ddof=1) of log returns * sqrt(annualized_factor)
/// - `cum_return` = exp(sum of log returns) - 1 (cumulative / momentum return)
/// - `sma` = simple moving average of close prices
/// - `mean_return` = mean log return
/// - `price_zscore` = (latest close - `sma`) / sample stddev of close prices
///
/// Returns a `DataFrame` keyed by `ticker`. New factors are added as columns.
#[instrument(skip_all, fields(data_dir = %data_dir.display()))]
async fn compute_factors(data_dir: &Path, timeframe: Timeframe) -> Result<DataFrame, ReturnsError> {
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
/// the last `lookback_periods` candles. Stddev uses ddof=1 to match the legacy
/// Spark `stddev`; the cumulative return is `exp(sum) - 1`.
fn per_ticker_factors(
    candles: &DataFrame,
    config: &TimeframeConfig,
) -> Result<DataFrame, PolarsError> {
    let with_returns = compute_log_returns(candles)?;
    let lookback = config.lookback_periods;
    let annualization_multiplier = config.annualized_factor.sqrt();
    let mut factors = with_returns
        .lazy()
        .group_by([col("ticker")])
        .agg([
            (col("log_return").tail(Some(lookback)).std(1) * lit(annualization_multiplier))
                .alias("annualized_volatility"),
            col("log_return")
                .tail(Some(lookback))
                .sum()
                .alias("cum_log_return"),
            col("close").tail(Some(lookback)).mean().alias("sma"),
            col("log_return")
                .tail(Some(lookback))
                .mean()
                .alias("mean_return"),
            col("close")
                .tail(Some(lookback))
                .std(1)
                .alias("price_stddev"),
            col("close").last().alias("last_close"),
        ])
        // price z-score = (latest close - SMA) / price stddev; undefined (null)
        // when there is no price dispersion (constant prices over the window).
        .with_column(
            when(col("price_stddev").gt(lit(PRICE_STDDEV_EPS)))
                .then((col("last_close") - col("sma")) / col("price_stddev"))
                .otherwise(lit(NULL))
                .alias("price_zscore"),
        )
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
    factors.drop_in_place("price_stddev")?;
    factors.drop_in_place("last_close")?;
    Ok(factors)
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
        /// Volatility is a scaled standard deviation, so it is always finite and
        /// non-negative for any positive close series; the SMA stays within the
        /// price range, mean return is finite, and a present z-score is finite.
        #[test]
        fn volatility_is_non_negative(
            closes in prop::collection::vec(1.0_f64..1_000_000.0, 3..50),
        ) {
            let n = closes.len();
            let min_close = closes.iter().copied().fold(f64::INFINITY, f64::min);
            let max_close = closes.iter().copied().fold(f64::NEG_INFINITY, f64::max);
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

            let sma = out.column("sma").unwrap().f64().unwrap().get(0).unwrap();
            prop_assert!(sma.is_finite());
            prop_assert!(
                sma >= min_close - 1e-6 && sma <= max_close + 1e-6,
                "sma {sma} outside price range [{min_close}, {max_close}]"
            );

            let mean_return = out.column("mean_return").unwrap().f64().unwrap().get(0).unwrap();
            prop_assert!(mean_return.is_finite(), "mean_return must be finite, got {mean_return}");

            if let Some(zscore) = out.column("price_zscore").unwrap().f64().unwrap().get(0) {
                prop_assert!(
                    zscore.is_finite(),
                    "price_zscore must be finite when present, got {zscore}"
                );
            }
        }

        /// For a strictly increasing close series the latest close is the maximum,
        /// so it sits above the moving average and the price z-score is positive.
        #[test]
        fn price_zscore_positive_for_strictly_increasing_closes(
            base in 1.0_f64..1000.0,
            increments in prop::collection::vec(0.01_f64..100.0, 3..40),
        ) {
            let closes: Vec<f64> = std::iter::once(base)
                .chain(increments.iter().scan(base, |price, increment| {
                    *price += increment;
                    Some(*price)
                }))
                .collect();
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
            let zscore = out.column("price_zscore").unwrap().f64().unwrap().get(0).unwrap();
            prop_assert!(zscore > 0.0, "increasing closes must give a positive z-score, got {zscore}");
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

        // sma = mean([100, 101, 100, 101, 100]) = 502 / 5 = 100.4.
        let sma = out.column("sma").unwrap().f64().unwrap().get(0).unwrap();
        assert!((sma - 100.4).abs() < 1e-10, "sma {sma} != 100.4");

        // mean of the non-null log returns [a, -a, a, -a] is 0.
        let mean_return = out
            .column("mean_return")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            mean_return.abs() < 1e-12,
            "mean_return should be ~0, got {mean_return}"
        );

        // price stddev (ddof=1) of the closes is sqrt(1.2 / 4) = sqrt(0.3), so
        // the z-score of the latest close (100) is (100 - 100.4) / sqrt(0.3).
        let zscore = out
            .column("price_zscore")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        let expected_zscore = -0.4 / 0.3_f64.sqrt();
        assert!(
            (zscore - expected_zscore).abs() < 1e-10,
            "zscore {zscore} != {expected_zscore}"
        );
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

        let sma = out.column("sma").unwrap().f64().unwrap().get(0).unwrap();
        assert!((sma - 100.0).abs() < 1e-12, "sma should be 100, got {sma}");

        let mean_return = out
            .column("mean_return")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            mean_return.abs() < 1e-12,
            "constant prices give zero mean_return, got {mean_return}"
        );

        // No price dispersion means the z-score is undefined -> null.
        let zscore = out.column("price_zscore").unwrap().f64().unwrap().get(0);
        assert!(
            zscore.is_none(),
            "constant prices give an undefined (null) z-score, got {zscore:?}"
        );
    }

    #[test]
    fn per_ticker_factors_treat_near_zero_price_stddev_as_undefined_zscore() {
        let tiny_move = PRICE_STDDEV_EPS / 100.0;
        let candles = df! {
            "timestamp" => &["0", "1", "2", "3"],
            "ticker" => &["BTC", "BTC", "BTC", "BTC"],
            "close" => &[100.0, 100.0 + tiny_move, 100.0, 100.0 + tiny_move],
        }
        .unwrap();
        let config = TimeframeConfig {
            lookback_periods: 10,
            annualized_factor: 365.0,
        };

        let out = per_ticker_factors(&candles, &config).unwrap();
        let zscore = out.column("price_zscore").unwrap().f64().unwrap().get(0);

        assert!(
            zscore.is_none(),
            "near-zero price dispersion gives an undefined (null) z-score, got {zscore:?}"
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
        assert!(out.column("sma").is_ok());
        assert!(out.column("mean_return").is_ok());
        assert!(out.column("price_zscore").is_ok());
        assert!(crate::logs_contain_at(
            tracing::Level::INFO,
            &["factors computed"]
        ));
    }
}
