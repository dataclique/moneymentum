//! Per-ticker factor scores for the screener, computed over a timeframe's
//! lookback window and served by the `/factors` endpoint.

use std::path::Path;

use polars::prelude::{
    ChunkApply, DataFrame, DataFrameJoinOps, DataType, IntoLazy, IntoSeries, JoinArgs, JoinType,
    JsonFormat, JsonWriter, NULL, PolarsError, SerWriter, SortMultipleOptions, col, cols, lit,
    when,
};
use tracing::{info, instrument};

use super::ReturnsError;
use super::autocorrelation::autocorrelation_by_ticker;
use super::returns::compute_log_returns;
use crate::timeframe::{Timeframe, TimeframeConfig};

const PRICE_STDDEV_EPS: f64 = 1e-8;

/// Per-ticker factor scores serialized as a JSON array, for the `/factors`
/// endpoint. Exposes `annualized_volatility`, `cum_return`, `sma`,
/// `mean_return`, `price_zscore`, `annualized_return`, `sharpe`, `sortino`,
/// `autocorrelation`, and `information_discreteness`; further factors are added
/// as columns as they land.
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
/// - `annualized_return` = exp(`mean_return` * annualized_factor) - 1
/// - `sharpe` = `annualized_return` / `annualized_volatility` (risk-free 0);
///   null when there is no volatility
/// - `sortino` = `annualized_return` / downside deviation below the MAR; null
///   when there is no downside
/// - `autocorrelation` = lag-1 autocorrelation of returns over the last
///   `lookback_periods` / 4 pairs; null when returns have no variation
/// - `information_discreteness` = sign(`cum_return`) * (fraction of negative
///   returns - fraction of positive returns); -1 for a smooth trend
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

    // Lag-1 autocorrelation needs its own complete-pairs pass over a shorter
    // window, computed separately and joined back in by ticker below.
    //
    // The pair window is a quarter of the factor lookback (e.g. 22 pairs on
    // the 90-period daily window): a shorter window makes the score track the
    // recent regime instead of averaging lag-1 persistence over the whole
    // lookback.
    const AUTOCORRELATION_WINDOW_DIVISOR: usize = 4;
    let autocorrelation =
        autocorrelation_by_ticker(&with_returns, lookback / AUTOCORRELATION_WINDOW_DIVISOR)?;

    // Downside deviation inputs for Sortino: sum of squared shortfalls below the
    // minimum acceptable return, and the observation count to average over.
    let above_mar = col("log_return").tail(Some(lookback)) - lit(config.min_acceptable_return);
    let downside_sq_sum = when(above_mar.clone().lt(lit(0.0)))
        .then(above_mar.pow(lit(2)))
        .otherwise(lit(0.0))
        .sum()
        .alias("downside_sq_sum");

    let factors = with_returns
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
            downside_sq_sum,
            col("log_return")
                .tail(Some(lookback))
                .count()
                .alias("obs_count"),
            (col("log_return").tail(Some(lookback)).gt(lit(0.0)))
                .sum()
                .alias("pos_count"),
            (col("log_return").tail(Some(lookback)).lt(lit(0.0)))
                .sum()
                .alias("neg_count"),
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

    let factors = add_return_and_risk_factors(factors, config.annualized_factor)?;

    let factors = factors.join(
        &autocorrelation,
        ["ticker"],
        ["ticker"],
        JoinArgs::new(JoinType::Left),
        None,
    )?;

    Ok(factors)
}

/// Derives the return and risk-adjusted factors from the aggregated columns and
/// drops the intermediate sums/counts they were computed from.
///
/// Adds `cum_return`, `annualized_return`, `sharpe`, `sortino`, and
/// `information_discreteness`. `sharpe`/`sortino` are null when their risk
/// denominator is zero; `information_discreteness` is `sign(cum_return)` times
/// the negative-minus-positive return fraction.
fn add_return_and_risk_factors(
    mut factors: DataFrame,
    annualized_factor: f64,
) -> Result<DataFrame, PolarsError> {
    // cum_return = exp(sum of log returns) - 1, and annualized_return =
    // exp(mean_return * annualized_factor) - 1. exp is applied on the series
    // (like compute_log_returns does for ln) to avoid a polars math-expr feature.
    let cum_return = factors
        .column("cum_log_return")?
        .f64()?
        .apply_values(f64::exp_m1)
        .into_series()
        .with_name("cum_return".into());
    factors.with_column(cum_return)?;

    let annualized_return = factors
        .column("mean_return")?
        .f64()?
        .apply_values(|mean| (mean * annualized_factor).exp_m1())
        .into_series()
        .with_name("annualized_return".into());
    factors.with_column(annualized_return)?;

    // An extreme mean return overflows exp() to a non-finite value; null it so
    // the screener never ranks on inf. sharpe and sortino derive from
    // annualized_return and stay null too.
    let mut factors = factors
        .lazy()
        .with_column(
            when(col("annualized_return").is_finite())
                .then(col("annualized_return"))
                .otherwise(lit(NULL))
                .alias("annualized_return"),
        )
        .collect()?;

    factors.drop_in_place("cum_log_return")?;
    factors.drop_in_place("price_stddev")?;
    factors.drop_in_place("last_close")?;

    let downside_deviation = (col("downside_sq_sum") / col("obs_count")).pow(lit(0.5));

    // information discreteness = sign(cum_return) * (pct_negative - pct_positive):
    // -1 for a smooth one-directional trend, near 0 for choppy or flat returns.
    let return_sign = when(col("cum_return").gt(lit(0.0)))
        .then(lit(1.0))
        .otherwise(
            when(col("cum_return").lt(lit(0.0)))
                .then(lit(-1.0))
                .otherwise(lit(0.0)),
        );
    let pct_difference = (col("neg_count").cast(DataType::Float64)
        - col("pos_count").cast(DataType::Float64))
        / col("obs_count").cast(DataType::Float64);

    let factors = factors
        .lazy()
        .with_columns([
            // NaN != 0.0 is true in IEEE 754, so a NaN volatility (e.g. from a
            // corrupt zero close producing a -inf log return) must be rejected
            // explicitly -- mirroring the price_zscore stddev guard.
            when(
                col("annualized_volatility")
                    .is_finite()
                    .and(col("annualized_volatility").neq(lit(0.0))),
            )
            .then(col("annualized_return") / col("annualized_volatility"))
            .otherwise(lit(NULL))
            .alias("sharpe"),
            // Same NaN hazard as the sharpe guard: a single-candle ticker
            // yields sqrt(0/0) = NaN downside deviation, and NaN != 0.0 is
            // true, so the zero check alone would emit a NaN sortino.
            when(
                downside_deviation
                    .clone()
                    .is_finite()
                    .and(downside_deviation.clone().neq(lit(0.0))),
            )
            .then(col("annualized_return") / downside_deviation)
            .otherwise(lit(NULL))
            .alias("sortino"),
            // NaN > 0.0 and NaN < 0.0 are both false, so a NaN-poisoned
            // cum_return would slip through return_sign as a legitimate-looking
            // 0.0 ("perfectly choppy") without the explicit finiteness guard
            // its sibling factors all carry.
            when(
                col("obs_count")
                    .gt(lit(0))
                    .and(col("cum_return").is_finite()),
            )
            .then(return_sign * pct_difference)
            .otherwise(lit(NULL))
            .alias("information_discreteness"),
        ])
        .drop(cols([
            "downside_sq_sum",
            "obs_count",
            "pos_count",
            "neg_count",
        ]))
        .collect()?;

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
            let config = TimeframeConfig {
                lookback_periods: 100,
                annualized_factor: 365.0,
                min_acceptable_return: 0.0,
            };

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

            if let Some(annualized_return) =
                out.column("annualized_return").unwrap().f64().unwrap().get(0)
            {
                prop_assert!(
                    annualized_return.is_finite(),
                    "annualized_return must be finite when present, got {annualized_return}"
                );
            }

            if let Some(sharpe) = out.column("sharpe").unwrap().f64().unwrap().get(0) {
                prop_assert!(sharpe.is_finite(), "sharpe must be finite when present, got {sharpe}");
            }

            if let Some(sortino) = out.column("sortino").unwrap().f64().unwrap().get(0) {
                prop_assert!(
                    sortino.is_finite(),
                    "sortino must be finite when present, got {sortino}"
                );
            }

            let information_discreteness = out
                .column("information_discreteness")
                .unwrap()
                .f64()
                .unwrap()
                .get(0)
                .unwrap();
            prop_assert!(
                (-1.0 - 1e-9..=1.0 + 1e-9).contains(&information_discreteness),
                "information_discreteness {information_discreteness} outside [-1, 1]"
            );
        }

        /// For a strictly increasing close series the latest close is the maximum,
        /// so it sits above the moving average (positive z-score) and every log
        /// return is positive, so the annualized return and (when volatility is
        /// non-zero) the Sharpe ratio are positive too.
        #[test]
        fn increasing_closes_give_positive_momentum_factors(
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
            let config = TimeframeConfig {
                lookback_periods: 100,
                annualized_factor: 365.0,
                min_acceptable_return: 0.0,
            };

            let out = per_ticker_factors(&candles, &config).unwrap();
            let zscore = out.column("price_zscore").unwrap().f64().unwrap().get(0).unwrap();
            prop_assert!(zscore > 0.0, "increasing closes must give a positive z-score, got {zscore}");

            let annualized_return = out
                .column("annualized_return")
                .unwrap()
                .f64()
                .unwrap()
                .get(0)
                .unwrap();
            prop_assert!(
                annualized_return > 0.0,
                "increasing closes must give a positive annualized_return, got {annualized_return}"
            );

            if let Some(sharpe) = out.column("sharpe").unwrap().f64().unwrap().get(0) {
                prop_assert!(
                    sharpe > 0.0,
                    "positive return with volatility must give a positive sharpe, got {sharpe}"
                );
            }

            // Every return is above the MAR (0), so there is no downside and
            // sortino is undefined -> null.
            let sortino = out.column("sortino").unwrap().f64().unwrap().get(0);
            prop_assert!(
                sortino.is_none(),
                "increasing closes have no downside, so sortino must be null, got {sortino:?}"
            );

            // A smooth uptrend is fully positive returns, so information
            // discreteness is sign(+) * (0 - 1) = -1.
            let information_discreteness = out
                .column("information_discreteness")
                .unwrap()
                .f64()
                .unwrap()
                .get(0)
                .unwrap();
            prop_assert!(
                (information_discreteness - (-1.0)).abs() < 1e-12,
                "a smooth uptrend must give information_discreteness -1, got {information_discreteness}"
            );
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
            min_acceptable_return: 0.0,
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

        // mean_return is 0, so annualized_return = exp(0) - 1 = 0 and, with a
        // positive volatility, sharpe = 0 / vol = 0.
        let annualized_return = out
            .column("annualized_return")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            annualized_return.abs() < 1e-12,
            "annualized_return should be ~0, got {annualized_return}"
        );

        let sharpe = out.column("sharpe").unwrap().f64().unwrap().get(0).unwrap();
        assert!(sharpe.abs() < 1e-12, "sharpe should be ~0, got {sharpe}");

        // There is downside (the -a returns), so sortino is defined; with a zero
        // annualized_return it is 0 / downside_deviation = 0.
        let sortino = out
            .column("sortino")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(sortino.abs() < 1e-12, "sortino should be ~0, got {sortino}");

        // cum_return is 0, so sign(cum_return) is 0 and information discreteness
        // is 0 regardless of the positive/negative return split.
        let information_discreteness = out
            .column("information_discreteness")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            information_discreteness.abs() < 1e-12,
            "information_discreteness should be ~0, got {information_discreteness}"
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
            min_acceptable_return: 0.0,
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

        let annualized_return = out
            .column("annualized_return")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            annualized_return.abs() < 1e-12,
            "constant prices give zero annualized_return, got {annualized_return}"
        );

        // Zero volatility means sharpe is undefined -> null.
        let sharpe = out.column("sharpe").unwrap().f64().unwrap().get(0);
        assert!(
            sharpe.is_none(),
            "constant prices give an undefined (null) sharpe, got {sharpe:?}"
        );

        // No returns fall below the MAR, so downside deviation is zero and
        // sortino is undefined -> null.
        let sortino = out.column("sortino").unwrap().f64().unwrap().get(0);
        assert!(
            sortino.is_none(),
            "constant prices give an undefined (null) sortino, got {sortino:?}"
        );

        // No return variation means autocorrelation is undefined -> null.
        let autocorrelation = out.column("autocorrelation").unwrap().f64().unwrap().get(0);
        assert!(
            autocorrelation.is_none(),
            "constant prices give an undefined (null) autocorrelation, got {autocorrelation:?}"
        );

        // cum_return is 0 (sign 0) with no positive or negative returns, so
        // information discreteness is exactly 0.
        let information_discreteness = out
            .column("information_discreteness")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            information_discreteness.abs() < 1e-12,
            "constant prices give zero information_discreteness, got {information_discreteness}"
        );
    }

    #[test]
    fn per_ticker_sortino_matches_manual_downside_deviation() {
        // closes [100, 99, 101] give log returns [-p, q] with p = ln(100/99)
        // (a down move below the MAR of 0) and q = ln(101/99) (an up move).
        let candles = df! {
            "timestamp" => &["0", "1", "2"],
            "ticker" => &["BTC", "BTC", "BTC"],
            "close" => &[100.0, 99.0, 101.0_f64],
        }
        .unwrap();
        // annualized_factor 1 keeps annualized_return = exp(mean_return) - 1.
        let config = TimeframeConfig {
            lookback_periods: 10,
            annualized_factor: 1.0,
            min_acceptable_return: 0.0,
        };

        let out = per_ticker_factors(&candles, &config).unwrap();
        let sortino = out
            .column("sortino")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();

        let down_move = (100.0_f64 / 99.0).ln();
        let up_move = (101.0_f64 / 99.0).ln();
        let mean_return = f64::midpoint(-down_move, up_move);
        let annualized_return = mean_return.exp_m1();
        // Only the down move is below the MAR, so downside variance = p^2 / 2.
        let downside_deviation = (down_move * down_move / 2.0).sqrt();
        let expected_sortino = annualized_return / downside_deviation;
        assert!(
            (sortino - expected_sortino).abs() < 1e-12,
            "sortino {sortino} != expected {expected_sortino}"
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
            min_acceptable_return: 0.0,
        };

        let out = per_ticker_factors(&candles, &config).unwrap();
        let zscore = out.column("price_zscore").unwrap().f64().unwrap().get(0);

        assert!(
            zscore.is_none(),
            "near-zero price dispersion gives an undefined (null) z-score, got {zscore:?}"
        );
    }

    #[test]
    fn information_discreteness_matches_manual_value_for_mixed_signs() {
        // Three up moves and one down move with a net-positive cum_return:
        // sign(+) * (pct_negative - pct_positive) = 1 * (1/4 - 3/4) = -0.5.
        let candles = df! {
            "timestamp" => &["0", "1", "2", "3", "4"],
            "ticker" => &["BTC", "BTC", "BTC", "BTC", "BTC"],
            "close" => &[100.0, 102.0, 101.0, 103.0, 105.0_f64],
        }
        .unwrap();
        let config = TimeframeConfig {
            lookback_periods: 10,
            annualized_factor: 365.0,
            min_acceptable_return: 0.0,
        };

        let out = per_ticker_factors(&candles, &config).unwrap();
        let information_discreteness = out
            .column("information_discreteness")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();

        assert!(
            (information_discreteness - (-0.5)).abs() < 1e-12,
            "1 down of 4 returns on a net uptrend must give -0.5, got {information_discreteness}"
        );
    }

    #[test]
    fn information_discreteness_is_minus_one_for_smooth_downtrend() {
        // A smooth downtrend is fully negative returns, so information
        // discreteness is sign(-) * (1 - 0) = -1, mirroring the uptrend case.
        let candles = df! {
            "timestamp" => &["0", "1", "2", "3"],
            "ticker" => &["BTC", "BTC", "BTC", "BTC"],
            "close" => &[100.0, 99.0, 98.0, 97.0_f64],
        }
        .unwrap();
        let config = TimeframeConfig {
            lookback_periods: 10,
            annualized_factor: 365.0,
            min_acceptable_return: 0.0,
        };

        let out = per_ticker_factors(&candles, &config).unwrap();
        let information_discreteness = out
            .column("information_discreteness")
            .unwrap()
            .f64()
            .unwrap()
            .get(0)
            .unwrap();
        assert!(
            (information_discreteness - (-1.0)).abs() < 1e-12,
            "a smooth downtrend must give information_discreteness -1, got {information_discreteness}"
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
        assert!(out.column("annualized_return").is_ok());
        assert!(out.column("sharpe").is_ok());
        assert!(out.column("sortino").is_ok());
        assert!(out.column("autocorrelation").is_ok());
        assert!(out.column("information_discreteness").is_ok());
        assert!(crate::logs_contain_at(
            tracing::Level::INFO,
            &["factors computed"]
        ));
    }
}
