//! Risk analytics for the active portfolio (story 0x01b).
//!
//! Every metric shares one measurement contract -- the window, sampling
//! frequency, and confidence levels -- so they describe the same portfolio under
//! the same assumptions. This module owns that contract and its validation, and
//! the metrics computed under it; remaining metric math (correlation, ENB,
//! Monte Carlo) is added on top as it lands.
//!
//! Return convention (methodology doc, "Shared foundation"): per-asset returns
//! are log returns for estimation, but the portfolio aggregates in
//! simple-return space -- `r_p = sum_i w_i * (exp(r_i) - 1)` -- because log
//! returns are additive across time, not across assets. Losses are positive
//! fractions of portfolio value per sampling period (`0.05` = a 5% loss).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, NaiveDate};
use polars::prelude::{AnyValue, DataFrame};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, instrument};

use crate::dataframe::DataFrameError;
use crate::timeframe::Timeframe;

/// Inclusive lower bound on the measurement window, in days (story 0x01b).
const MIN_WINDOW_DAYS: i64 = 30;
/// Inclusive upper bound on the measurement window, in days (story 0x01b).
const MAX_WINDOW_DAYS: i64 = 365;
/// Default lookback when none is supplied (story 0x01b).
const DEFAULT_LOOKBACK_DAYS: u16 = 90;
/// Confidence levels VaR/CVaR may use, and the default set (story 0x01b).
const ALLOWED_CONFIDENCE_LEVELS: [f64; 3] = [0.90, 0.95, 0.99];
/// Fewest portfolio returns the tail metrics accept; below this a quantile is
/// degenerate (a single observation is its own VaR at every level).
const MIN_PORTFOLIO_RETURNS: usize = 2;

#[derive(Debug, Error, PartialEq)]
pub(crate) enum RiskError {
    #[error("lookback_days {days} is outside the [{MIN_WINDOW_DAYS}, {MAX_WINDOW_DAYS}] range")]
    LookbackOutOfRange { days: u16 },
    #[error("start_date and end_date must be provided together")]
    IncompleteDateRange,
    #[error("invalid date {value}, expected YYYY-MM-DD")]
    InvalidDate { value: String },
    #[error("start_date must be strictly earlier than end_date")]
    NonChronologicalRange,
    #[error("window span {days} days is outside the [{MIN_WINDOW_DAYS}, {MAX_WINDOW_DAYS}] range")]
    WindowSpanOutOfRange { days: i64 },
    #[error("confidence level {value} is not one of 0.90, 0.95, 0.99")]
    UnsupportedConfidenceLevel { value: f64 },
    #[error("portfolio weights must not be empty")]
    EmptyWeights,
    #[error("portfolio weights must sum to 1 in absolute value, got {sum}")]
    WeightsNotNormalized { sum: f64 },
}

/// Sampling frequency for the return series the metrics are computed over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SamplingFrequency {
    Daily,
    Weekly,
}

/// A confidence level for VaR/CVaR; only 0.90, 0.95, and 0.99 are allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfidenceLevel {
    Ninety,
    NinetyFive,
    NinetyNine,
}

impl ConfidenceLevel {
    fn new(value: f64) -> Result<Self, RiskError> {
        let matches_level = |allowed: f64| (allowed - value).abs() < 1e-9;
        if matches_level(0.90) {
            Ok(Self::Ninety)
        } else if matches_level(0.95) {
            Ok(Self::NinetyFive)
        } else if matches_level(0.99) {
            Ok(Self::NinetyNine)
        } else {
            Err(RiskError::UnsupportedConfidenceLevel { value })
        }
    }

    fn value(self) -> f64 {
        match self {
            Self::Ninety => 0.90,
            Self::NinetyFive => 0.95,
            Self::NinetyNine => 0.99,
        }
    }

    /// The tail probability `1 - confidence` in exact basis points, so tail
    /// counts can be derived in integer arithmetic without float casts.
    fn tail_basis_points(self) -> u64 {
        match self {
            Self::Ninety => 1_000,
            Self::NinetyFive => 500,
            Self::NinetyNine => 100,
        }
    }
}

impl Serialize for ConfidenceLevel {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_f64(self.value())
    }
}

/// The resolved measurement window: a trailing lookback or an explicit range.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum MeasurementWindow {
    Lookback {
        #[serde(rename = "lookbackDays")]
        lookback_days: u16,
    },
    Range {
        #[serde(rename = "startDate")]
        start_date: NaiveDate,
        #[serde(rename = "endDate")]
        end_date: NaiveDate,
    },
}

/// A request for the active portfolio's risk analytics.
///
/// Dates are `YYYY-MM-DD` strings. When `start_date`/`end_date` are present they
/// take precedence over `lookback_days`. Weights are signed active-position
/// proportions and must sum to 1 in absolute value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RiskRequest {
    lookback_days: Option<u16>,
    start_date: Option<String>,
    end_date: Option<String>,
    sampling_frequency: Option<SamplingFrequency>,
    confidence_levels: Option<Vec<f64>>,
    weights: HashMap<String, f64>,
}

/// The validated measurement contract every metric shares.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeasurementContract {
    window: MeasurementWindow,
    sampling_frequency: SamplingFrequency,
    confidence_levels: Vec<ConfidenceLevel>,
}

/// VaR and CVaR at one confidence level, as positive loss fractions of
/// portfolio value per sampling period.
///
/// VaR is the empirical `(1 - confidence)` upper quantile of losses; CVaR is
/// the Acerbi-Tasche expected shortfall (the interpolated tail average), so
/// `cvar >= var` always holds.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TailRisk {
    confidence_level: ConfidenceLevel,
    #[serde(rename = "var")]
    value_at_risk: f64,
    #[serde(rename = "cvar")]
    conditional_value_at_risk: f64,
}

/// Historical drawdown of the realized cumulative portfolio path over the
/// measurement window.
///
/// `max_drawdown` is the deepest peak-to-trough decline as a positive fraction
/// of the peak (`0.4` = a 40% decline); `peak_to_trough_periods` is that
/// decline's length in sampling periods. A wealth path that touches zero (a
/// leveraged or short leg can lose more than 100% in one period) reports a
/// full `1.0` drawdown.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Drawdown {
    max_drawdown: f64,
    peak_to_trough_periods: usize,
}

/// The shrunk correlation matrix across held positions over the measurement
/// window.
///
/// Estimated on per-asset log returns: the sample covariance is shrunk toward
/// the constant-correlation target with the closed-form Ledoit-Wolf intensity
/// before converting to correlations, regularizing near-degenerate sample
/// estimates (methodology doc, decision 2). The reported matrix is the shrunk
/// one; `shrinkage_intensity` in `[0, 1]` says how far it moved from the
/// sample estimate (`0` = pure sample covariance).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CorrelationReport {
    tickers: Vec<String>,
    /// Row-major entries ordered like `tickers`; symmetric with unit diagonal.
    matrix: Vec<Vec<f64>>,
    shrinkage_intensity: f64,
}

/// Risk analytics for the active portfolio: the resolved measurement contract
/// plus every metric computed under it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RiskResponse {
    contract: MeasurementContract,
    tail_risk: Vec<TailRisk>,
    drawdown: Drawdown,
    correlation: CorrelationReport,
}

/// Errors from assessing risk: contract validation, candle data access, or a
/// window without enough usable observations.
#[derive(Debug, Error)]
pub(crate) enum RiskAssessmentError {
    #[error(transparent)]
    Contract(#[from] RiskError),
    #[error(transparent)]
    DataFrame(#[from] DataFrameError),
    #[error(transparent)]
    Polars(#[from] polars::prelude::PolarsError),
    #[error("no candle data at {path}")]
    NoData { path: PathBuf },
    #[error("no candle data for {ticker} in the measurement window")]
    MissingTickerData { ticker: String },
    #[error(
        "only {observations} portfolio returns in the window, need at least {MIN_PORTFOLIO_RETURNS}"
    )]
    InsufficientObservations { observations: usize },
    #[error("ticker {ticker} has zero return variance in the window, correlation is undefined")]
    ZeroVarianceTicker { ticker: String },
}

/// Assesses the active portfolio's risk: resolves the measurement contract,
/// builds the portfolio return series from ingested daily candles, and computes
/// historical VaR/CVaR at each contract confidence level.
#[instrument(skip_all, fields(data_dir = %data_dir.display()))]
pub(crate) async fn assess_risk(
    data_dir: &Path,
    request: &RiskRequest,
) -> Result<RiskResponse, RiskAssessmentError> {
    let contract = resolve_contract(request)?;
    let path = data_dir.join(Timeframe::OneDay.file_name());
    let candles = crate::dataframe::read_csv(path.clone())
        .await?
        .ok_or(RiskAssessmentError::NoData { path })?;

    let log_returns_by_ticker = log_returns_in_window(&candles, &contract, &request.weights)?;
    let portfolio_returns = aggregate_in_simple_space(&log_returns_by_ticker, &request.weights)?;
    let tail_risk = compute_tail_risk(&portfolio_returns, &contract.confidence_levels)?;
    let drawdown = compute_drawdown(&portfolio_returns);
    let correlation = compute_correlation(&log_returns_by_ticker)?;
    debug!(
        observations = portfolio_returns.len(),
        levels = tail_risk.len(),
        max_drawdown = drawdown.max_drawdown,
        shrinkage_intensity = correlation.shrinkage_intensity,
        "risk metrics computed"
    );

    Ok(RiskResponse {
        contract,
        tail_risk,
        drawdown,
        correlation,
    })
}

/// Resolves and validates a [`RiskRequest`] into the [`MeasurementContract`] the
/// metrics run against. Applies the story-0x01b defaults where fields are absent.
#[instrument(skip_all)]
fn resolve_contract(request: &RiskRequest) -> Result<MeasurementContract, RiskError> {
    let window = resolve_window(request)?;
    let sampling_frequency = request
        .sampling_frequency
        .unwrap_or(SamplingFrequency::Daily);
    let confidence_levels = resolve_confidence_levels(request.confidence_levels.as_deref())?;
    validate_weights(&request.weights)?;

    debug!(
        sampling_frequency = ?sampling_frequency,
        positions = request.weights.len(),
        "risk contract resolved"
    );
    Ok(MeasurementContract {
        window,
        sampling_frequency,
        confidence_levels,
    })
}

fn resolve_window(request: &RiskRequest) -> Result<MeasurementWindow, RiskError> {
    match (&request.start_date, &request.end_date) {
        (Some(start), Some(end)) => {
            let start_date = parse_date(start)?;
            let end_date = parse_date(end)?;
            if start_date >= end_date {
                return Err(RiskError::NonChronologicalRange);
            }
            let span = (end_date - start_date).num_days();
            if !(MIN_WINDOW_DAYS..=MAX_WINDOW_DAYS).contains(&span) {
                return Err(RiskError::WindowSpanOutOfRange { days: span });
            }
            Ok(MeasurementWindow::Range {
                start_date,
                end_date,
            })
        }
        (None, None) => {
            let lookback_days = request.lookback_days.unwrap_or(DEFAULT_LOOKBACK_DAYS);
            let span = i64::from(lookback_days);
            if !(MIN_WINDOW_DAYS..=MAX_WINDOW_DAYS).contains(&span) {
                return Err(RiskError::LookbackOutOfRange {
                    days: lookback_days,
                });
            }
            Ok(MeasurementWindow::Lookback { lookback_days })
        }
        _ => Err(RiskError::IncompleteDateRange),
    }
}

fn resolve_confidence_levels(levels: Option<&[f64]>) -> Result<Vec<ConfidenceLevel>, RiskError> {
    // Defaults to all allowed levels when none are supplied (story 0x01b).
    levels
        .unwrap_or(&ALLOWED_CONFIDENCE_LEVELS)
        .iter()
        .map(|level| ConfidenceLevel::new(*level))
        .collect()
}

/// Validates active-position weights: non-empty and summing to 1 in absolute
/// value. The weights themselves are consumed by the metrics as they land.
fn validate_weights(weights: &HashMap<String, f64>) -> Result<(), RiskError> {
    if weights.is_empty() {
        return Err(RiskError::EmptyWeights);
    }
    let absolute_sum: f64 = weights.values().map(|weight| weight.abs()).sum();
    if (absolute_sum - 1.0).abs() > 1e-6 {
        return Err(RiskError::WeightsNotNormalized { sum: absolute_sum });
    }
    Ok(())
}

fn parse_date(value: &str) -> Result<NaiveDate, RiskError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| RiskError::InvalidDate {
        value: value.to_string(),
    })
}

/// Each weighted ticker's log returns over the contract window at the contract
/// sampling frequency -- the shared estimation input for every metric.
fn log_returns_in_window(
    candles: &DataFrame,
    contract: &MeasurementContract,
    weights: &HashMap<String, f64>,
) -> Result<BTreeMap<String, BTreeMap<NaiveDate, f64>>, RiskAssessmentError> {
    let closes_by_ticker = window_closes_by_ticker(candles, contract.window, weights)?;
    let sampled_closes = sample_closes(closes_by_ticker, contract.sampling_frequency);
    Ok(per_ticker_log_returns(sampled_closes))
}

/// The Ledoit-Wolf-shrunk correlation matrix over the tickers' log returns on
/// their common dates.
///
/// The sample covariance (maximum-likelihood, `1/T`) is shrunk toward the
/// constant-correlation target with the closed-form optimal intensity
/// (Ledoit & Wolf 2004, "Honey, I Shrunk the Sample Covariance Matrix"), then
/// converted to a correlation matrix.
fn compute_correlation(
    log_returns_by_ticker: &BTreeMap<String, BTreeMap<NaiveDate, f64>>,
) -> Result<CorrelationReport, RiskAssessmentError> {
    let DemeanedReturns {
        tickers,
        demeaned_columns,
        observations,
    } = demeaned_return_columns(log_returns_by_ticker)?;
    let scale = f64::from(observations);

    let covariance: Vec<Vec<f64>> = demeaned_columns
        .iter()
        .map(|left_column| {
            demeaned_columns
                .iter()
                .map(|right_column| inner_product(left_column, right_column) / scale)
                .collect()
        })
        .collect();
    let variances: Vec<f64> = demeaned_columns
        .iter()
        .map(|column| inner_product(column, column) / scale)
        .collect();
    if let Some((ticker, _)) = tickers
        .iter()
        .zip(&variances)
        .find(|(_, variance)| **variance <= 0.0)
    {
        return Err(RiskAssessmentError::ZeroVarianceTicker {
            ticker: ticker.clone(),
        });
    }

    let average_correlation = average_pairwise_correlation(&covariance, &variances);
    let shrinkage_intensity = ledoit_wolf_intensity(
        &demeaned_columns,
        &covariance,
        &variances,
        average_correlation,
        scale,
    );

    let matrix: Vec<Vec<f64>> = variances
        .iter()
        .zip(&covariance)
        .enumerate()
        .map(|(row_index, (left_variance, covariance_row))| {
            variances
                .iter()
                .zip(covariance_row)
                .enumerate()
                .map(|(col_index, (right_variance, sample_entry))| {
                    if row_index == col_index {
                        return 1.0;
                    }
                    let denominator = (left_variance * right_variance).sqrt();
                    let target_entry = average_correlation * denominator;
                    let shrunk_entry =
                        shrinkage_intensity.mul_add(target_entry - sample_entry, *sample_entry);

                    shrunk_entry / denominator
                })
                .collect()
        })
        .collect();

    Ok(CorrelationReport {
        tickers,
        matrix,
        shrinkage_intensity,
    })
}

/// Per-ticker demeaned log-return columns on the dates shared by every ticker.
struct DemeanedReturns {
    tickers: Vec<String>,
    demeaned_columns: Vec<Vec<f64>>,
    observations: u32,
}

/// Demeans each ticker's log returns on the dates shared by every ticker.
fn demeaned_return_columns(
    log_returns_by_ticker: &BTreeMap<String, BTreeMap<NaiveDate, f64>>,
) -> Result<DemeanedReturns, RiskAssessmentError> {
    let common_dates: BTreeSet<NaiveDate> = log_returns_by_ticker
        .values()
        .map(|log_returns| log_returns.keys().copied().collect::<BTreeSet<NaiveDate>>())
        .reduce(|common, dates| common.intersection(&dates).copied().collect())
        .unwrap_or_default();
    let observations = common_dates.len();
    if observations < MIN_PORTFOLIO_RETURNS {
        return Err(RiskAssessmentError::InsufficientObservations { observations });
    }
    let observations = u32::try_from(observations)
        .map_err(|_| RiskAssessmentError::InsufficientObservations { observations: 0 })?;
    let scale = f64::from(observations);

    let tickers: Vec<String> = log_returns_by_ticker.keys().cloned().collect();
    let demeaned_columns: Vec<Vec<f64>> = log_returns_by_ticker
        .values()
        .map(|log_returns| {
            let column: Vec<f64> = common_dates
                .iter()
                .filter_map(|date| log_returns.get(date).copied())
                .collect();
            let mean: f64 = column.iter().sum::<f64>() / scale;

            column.iter().map(|log_return| log_return - mean).collect()
        })
        .collect();

    Ok(DemeanedReturns {
        tickers,
        demeaned_columns,
        observations,
    })
}

/// Sum of elementwise products of two equally long columns.
fn inner_product(left_column: &[f64], right_column: &[f64]) -> f64 {
    left_column
        .iter()
        .zip(right_column)
        .map(|(left_value, right_value)| left_value * right_value)
        .sum()
}

/// Mean of the sample correlations over distinct ticker pairs; zero for a
/// single-ticker portfolio, where the constant-correlation target has no
/// off-diagonal entries.
fn average_pairwise_correlation(covariance: &[Vec<f64>], variances: &[f64]) -> f64 {
    let pair_correlations: Vec<f64> = covariance
        .iter()
        .zip(variances)
        .enumerate()
        .flat_map(|(row_index, (covariance_row, left_variance))| {
            covariance_row
                .iter()
                .zip(variances)
                .skip(row_index + 1)
                .map(move |(sample_entry, right_variance)| {
                    sample_entry / (left_variance * right_variance).sqrt()
                })
        })
        .collect();
    if pair_correlations.is_empty() {
        return 0.0;
    }

    let pair_count = u32::try_from(pair_correlations.len()).unwrap_or(u32::MAX);
    pair_correlations.iter().sum::<f64>() / f64::from(pair_count)
}

/// The closed-form optimal shrinkage intensity toward the constant-correlation
/// target (Ledoit & Wolf 2004): `clamp(((pi - rho) / gamma) / T, 0, 1)`, where
/// `pi` estimates the variance of the sample covariance entries, `rho` its
/// covariance with the target, and `gamma` the target's distance from the
/// sample. A sample already on the target (`gamma = 0`) needs no shrinkage.
fn ledoit_wolf_intensity(
    demeaned_columns: &[Vec<f64>],
    covariance: &[Vec<f64>],
    variances: &[f64],
    average_correlation: f64,
    scale: f64,
) -> f64 {
    let pi_estimate: f64 = demeaned_columns
        .iter()
        .zip(covariance)
        .map(|(left_column, covariance_row)| {
            demeaned_columns
                .iter()
                .zip(covariance_row)
                .map(|(right_column, sample_entry)| {
                    left_column
                        .iter()
                        .zip(right_column)
                        .map(|(left_value, right_value)| {
                            (left_value * right_value - sample_entry).powi(2)
                        })
                        .sum::<f64>()
                        / scale
                })
                .sum::<f64>()
        })
        .sum();

    let rho_diagonal: f64 = demeaned_columns
        .iter()
        .zip(variances)
        .map(|(column, variance)| {
            column
                .iter()
                .map(|value| (value * value - variance).powi(2))
                .sum::<f64>()
                / scale
        })
        .sum();
    let rho_off_diagonal: f64 = demeaned_columns
        .iter()
        .zip(variances)
        .zip(covariance)
        .enumerate()
        .map(
            |(row_index, ((left_column, left_variance), covariance_row))| {
                demeaned_columns
                    .iter()
                    .zip(variances)
                    .zip(covariance_row)
                    .enumerate()
                    .filter(|(col_index, _)| *col_index != row_index)
                    .map(|(_, ((right_column, right_variance), sample_entry))| {
                        let theta_left = asymptotic_covariance_with_variance(
                            left_column,
                            right_column,
                            *left_variance,
                            *sample_entry,
                            scale,
                        );
                        let theta_right = asymptotic_covariance_with_variance(
                            right_column,
                            left_column,
                            *right_variance,
                            *sample_entry,
                            scale,
                        );

                        (average_correlation / 2.0)
                            * (right_variance / left_variance).sqrt().mul_add(
                                theta_left,
                                (left_variance / right_variance).sqrt() * theta_right,
                            )
                    })
                    .sum::<f64>()
            },
        )
        .sum();
    let rho_estimate = rho_diagonal + rho_off_diagonal;

    let gamma_estimate: f64 = variances
        .iter()
        .zip(covariance)
        .enumerate()
        .map(|(row_index, (left_variance, covariance_row))| {
            variances
                .iter()
                .zip(covariance_row)
                .enumerate()
                .filter(|(col_index, _)| *col_index != row_index)
                .map(|(_, (right_variance, sample_entry))| {
                    average_correlation
                        .mul_add((left_variance * right_variance).sqrt(), -sample_entry)
                        .powi(2)
                })
                .sum::<f64>()
        })
        .sum();

    if gamma_estimate <= f64::EPSILON {
        return 0.0;
    }

    (((pi_estimate - rho_estimate) / gamma_estimate) / scale).clamp(0.0, 1.0)
}

/// `theta` term of the Ledoit-Wolf `rho`: the asymptotic covariance between a
/// ticker's sample variance and a pair's sample covariance,
/// `(1/T) sum_t (x_t^2 - s_xx)(x_t y_t - s_xy)`.
fn asymptotic_covariance_with_variance(
    own_column: &[f64],
    other_column: &[f64],
    own_variance: f64,
    sample_entry: f64,
    scale: f64,
) -> f64 {
    own_column
        .iter()
        .zip(other_column)
        .map(|(own_value, other_value)| {
            (own_value * own_value - own_variance) * (own_value * other_value - sample_entry)
        })
        .sum::<f64>()
        / scale
}

/// Historical VaR and Acerbi-Tasche CVaR of the portfolio return series at
/// each confidence level.
fn compute_tail_risk(
    portfolio_returns: &[f64],
    confidence_levels: &[ConfidenceLevel],
) -> Result<Vec<TailRisk>, RiskAssessmentError> {
    if portfolio_returns.len() < MIN_PORTFOLIO_RETURNS {
        return Err(RiskAssessmentError::InsufficientObservations {
            observations: portfolio_returns.len(),
        });
    }

    let mut descending_losses: Vec<f64> = portfolio_returns
        .iter()
        .map(|simple_return| -simple_return)
        .collect();
    descending_losses.sort_by(|left, right| right.total_cmp(left));

    confidence_levels
        .iter()
        .map(|confidence_level| tail_risk_at(&descending_losses, *confidence_level))
        .collect()
}

/// Scale of [`ConfidenceLevel::tail_basis_points`]: 10,000 bp = 100%.
const BASIS_POINTS_SCALE: u64 = 10_000;
/// [`BASIS_POINTS_SCALE`] as the divisor for fractional tail masses.
const BASIS_POINTS_SCALE_F64: f64 = 10_000.0;

/// VaR and CVaR for one confidence level over losses sorted worst-first.
///
/// With `n` losses and tail mass `m = n * (1 - confidence)`: VaR is the
/// `ceil(m)`-th worst loss (the empirical upper quantile), and CVaR is the
/// Acerbi-Tasche estimator -- the sum of the worst `floor(m)` losses plus the
/// fractional remainder of the boundary loss, normalized by `m`. The tail mass
/// is split into whole and fractional parts in exact basis-point integer
/// arithmetic, so the interpolation rule has no float-rounding ambiguity.
fn tail_risk_at(
    descending_losses: &[f64],
    confidence_level: ConfidenceLevel,
) -> Result<TailRisk, RiskAssessmentError> {
    let observations = descending_losses.len();
    let insufficient = || RiskAssessmentError::InsufficientObservations { observations };

    let tail_mass_basis_points = u64::try_from(observations)
        .map_err(|_| insufficient())?
        .checked_mul(confidence_level.tail_basis_points())
        .ok_or_else(insufficient)?;
    let whole_tail_count =
        usize::try_from(tail_mass_basis_points / BASIS_POINTS_SCALE).map_err(|_| insufficient())?;
    let remainder_basis_points =
        u16::try_from(tail_mass_basis_points % BASIS_POINTS_SCALE).map_err(|_| insufficient())?;
    let fractional_tail = f64::from(remainder_basis_points) / BASIS_POINTS_SCALE_F64;
    let whole_tail_mass = u32::try_from(whole_tail_count).map_err(|_| insufficient())?;
    let tail_mass = f64::from(whole_tail_mass) + fractional_tail;

    let quantile_rank = if fractional_tail > 0.0 {
        whole_tail_count + 1
    } else {
        whole_tail_count
    }
    .max(1);
    let value_at_risk = descending_losses
        .get(quantile_rank - 1)
        .copied()
        .ok_or_else(insufficient)?;

    let whole_tail_sum: f64 = descending_losses.iter().take(whole_tail_count).sum();
    let fractional_contribution = if fractional_tail > 0.0 {
        // The boundary loss is always in range: floor(m) < n for confidence > 0.
        let boundary_loss = descending_losses
            .get(whole_tail_count)
            .copied()
            .ok_or_else(insufficient)?;
        fractional_tail * boundary_loss
    } else {
        0.0
    };
    let conditional_value_at_risk = (whole_tail_sum + fractional_contribution) / tail_mass;

    Ok(TailRisk {
        confidence_level,
        value_at_risk,
        conditional_value_at_risk,
    })
}

/// Deepest peak-to-trough decline of the compounded portfolio wealth path.
///
/// Wealth starts at 1 and compounds each simple return; the drawdown at every
/// step is measured against the running peak, and the deepest one is reported
/// with its peak-to-trough length in sampling periods.
fn compute_drawdown(portfolio_returns: &[f64]) -> Drawdown {
    let initial = DrawdownScan {
        wealth: 1.0,
        running_peak: 1.0,
        periods_since_peak: 0,
        max_drawdown: 0.0,
        peak_to_trough_periods: 0,
    };

    let scan = portfolio_returns
        .iter()
        .fold(initial, |state, simple_return| {
            // A leveraged or short leg can lose more than 100% in one period;
            // wealth is floored at zero because the path cannot recover from a
            // wipeout under proportional weights.
            let wealth = (state.wealth * (1.0 + simple_return)).max(0.0);
            let (running_peak, periods_since_peak) = if wealth > state.running_peak {
                (wealth, 0)
            } else {
                (state.running_peak, state.periods_since_peak + 1)
            };

            let drawdown = 1.0 - wealth / running_peak;
            let (max_drawdown, peak_to_trough_periods) = if drawdown > state.max_drawdown {
                (drawdown, periods_since_peak)
            } else {
                (state.max_drawdown, state.peak_to_trough_periods)
            };

            DrawdownScan {
                wealth,
                running_peak,
                periods_since_peak,
                max_drawdown,
                peak_to_trough_periods,
            }
        });

    Drawdown {
        max_drawdown: scan.max_drawdown,
        peak_to_trough_periods: scan.peak_to_trough_periods,
    }
}

/// Accumulator for the single pass over the wealth path in
/// [`compute_drawdown`].
struct DrawdownScan {
    wealth: f64,
    running_peak: f64,
    periods_since_peak: usize,
    max_drawdown: f64,
    peak_to_trough_periods: usize,
}

/// Each weighted ticker's closes within the measurement window, keyed by date.
///
/// A lookback window is anchored on the latest date observed across the
/// weighted tickers. Errors with [`RiskAssessmentError::MissingTickerData`]
/// when a weighted ticker has no close inside the window.
fn window_closes_by_ticker(
    candles: &DataFrame,
    window: MeasurementWindow,
    weights: &HashMap<String, f64>,
) -> Result<BTreeMap<String, BTreeMap<NaiveDate, f64>>, RiskAssessmentError> {
    let timestamp_column = candles.column("timestamp")?;
    let ticker_column = candles.column("ticker")?;
    let close_column = candles.column("close")?;

    let mut closes_by_ticker: BTreeMap<String, BTreeMap<NaiveDate, f64>> = BTreeMap::new();
    for row_index in 0..candles.height() {
        let ticker = string_at(ticker_column, row_index);
        let Some(ticker) = ticker.filter(|ticker| weights.contains_key(ticker)) else {
            continue;
        };
        let date = string_at(timestamp_column, row_index)
            .and_then(|timestamp| DateTime::parse_from_rfc3339(&timestamp).ok())
            .map(|timestamp| timestamp.date_naive());
        let Some(date) = date else {
            continue;
        };
        let close = close_column
            .get(row_index)
            .ok()
            .and_then(|value| value.try_extract::<f64>().ok())
            .filter(|close| close.is_finite() && *close > 0.0);
        let Some(close) = close else {
            continue;
        };

        closes_by_ticker
            .entry(ticker)
            .or_default()
            .insert(date, close);
    }

    if let Some(ticker) = first_missing_ticker(&closes_by_ticker, weights) {
        return Err(RiskAssessmentError::MissingTickerData { ticker });
    }

    let (window_start, window_end) = match window {
        MeasurementWindow::Range {
            start_date,
            end_date,
        } => (start_date, end_date),
        MeasurementWindow::Lookback { lookback_days } => {
            let latest_date = closes_by_ticker
                .values()
                .filter_map(|closes| closes.keys().next_back())
                .max()
                .copied();
            let Some(latest_date) = latest_date else {
                return Err(RiskAssessmentError::InsufficientObservations { observations: 0 });
            };
            (
                latest_date - chrono::Days::new(u64::from(lookback_days)),
                latest_date,
            )
        }
    };

    for closes in closes_by_ticker.values_mut() {
        closes.retain(|date, _| (window_start..=window_end).contains(date));
    }
    closes_by_ticker.retain(|_, closes| !closes.is_empty());
    if let Some(ticker) = first_missing_ticker(&closes_by_ticker, weights) {
        return Err(RiskAssessmentError::MissingTickerData { ticker });
    }

    Ok(closes_by_ticker)
}

/// The alphabetically first weighted ticker without closes, for deterministic
/// missing-data errors.
fn first_missing_ticker(
    closes_by_ticker: &BTreeMap<String, BTreeMap<NaiveDate, f64>>,
    weights: &HashMap<String, f64>,
) -> Option<String> {
    weights
        .keys()
        .filter(|ticker| !closes_by_ticker.contains_key(*ticker))
        .min()
        .cloned()
}

/// The string value of a column cell, when it is a string.
fn string_at(column: &polars::prelude::Column, row_index: usize) -> Option<String> {
    column.get(row_index).ok().and_then(|value| match value {
        AnyValue::String(text) => Some(text.to_string()),
        AnyValue::StringOwned(text) => Some(text.to_string()),
        _ => None,
    })
}

/// Resamples each ticker's closes to the sampling frequency: daily passes
/// through; weekly keeps the last close of each ISO week, keyed by its date.
fn sample_closes(
    closes_by_ticker: BTreeMap<String, BTreeMap<NaiveDate, f64>>,
    frequency: SamplingFrequency,
) -> BTreeMap<String, BTreeMap<NaiveDate, f64>> {
    match frequency {
        SamplingFrequency::Daily => closes_by_ticker,
        SamplingFrequency::Weekly => closes_by_ticker
            .into_iter()
            .map(|(ticker, closes)| (ticker, last_close_per_iso_week(closes)))
            .collect(),
    }
}

/// Keeps the chronologically last close of each ISO week, keyed by its date.
fn last_close_per_iso_week(closes: BTreeMap<NaiveDate, f64>) -> BTreeMap<NaiveDate, f64> {
    closes
        .into_iter()
        .map(|(date, close)| {
            let iso_week = date.iso_week();
            ((iso_week.year(), iso_week.week()), (date, close))
        })
        // BTreeMap insertion keeps the last entry per key, and the input is
        // date-ascending, so each week resolves to its latest close.
        .collect::<BTreeMap<(i32, u32), (NaiveDate, f64)>>()
        .into_values()
        .collect()
}

/// Per-ticker log returns between consecutive sampled closes, keyed by the
/// later close's date.
fn per_ticker_log_returns(
    closes_by_ticker: BTreeMap<String, BTreeMap<NaiveDate, f64>>,
) -> BTreeMap<String, BTreeMap<NaiveDate, f64>> {
    closes_by_ticker
        .into_iter()
        .map(|(ticker, closes)| {
            let ordered_closes: Vec<(NaiveDate, f64)> = closes.into_iter().collect();
            let log_returns = ordered_closes
                .windows(2)
                .filter_map(|consecutive| match consecutive {
                    [(_, previous_close), (date, close)] => {
                        Some((*date, (close / previous_close).ln()))
                    }
                    _ => None,
                })
                .collect();
            (ticker, log_returns)
        })
        .collect()
}

/// Aggregates per-ticker log returns into portfolio simple returns on the
/// dates where every weighted ticker has a return.
fn aggregate_in_simple_space(
    log_returns_by_ticker: &BTreeMap<String, BTreeMap<NaiveDate, f64>>,
    weights: &HashMap<String, f64>,
) -> Result<Vec<f64>, RiskAssessmentError> {
    let common_dates: Vec<NaiveDate> = log_returns_by_ticker
        .values()
        .map(|log_returns| log_returns.keys().copied().collect::<BTreeSet<NaiveDate>>())
        .reduce(|common, dates| common.intersection(&dates).copied().collect())
        .unwrap_or_default()
        .into_iter()
        .collect();

    let portfolio_returns: Vec<f64> = common_dates
        .iter()
        .map(|date| {
            log_returns_by_ticker
                .iter()
                .try_fold(0.0, |aggregated, (ticker, log_returns)| {
                    let missing = || RiskAssessmentError::MissingTickerData {
                        ticker: ticker.clone(),
                    };
                    let weight = weights.get(ticker).copied().ok_or_else(missing)?;
                    let log_return = log_returns.get(date).copied().ok_or_else(missing)?;

                    Ok(weight.mul_add(log_return.exp_m1(), aggregated))
                })
        })
        .collect::<Result<_, RiskAssessmentError>>()?;

    if portfolio_returns.len() < MIN_PORTFOLIO_RETURNS {
        return Err(RiskAssessmentError::InsufficientObservations {
            observations: portfolio_returns.len(),
        });
    }

    Ok(portfolio_returns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use tracing::Level;
    use tracing_test::traced_test;

    use crate::logs_contain_at;

    fn request_with(weights: &[(&str, f64)]) -> RiskRequest {
        RiskRequest {
            lookback_days: None,
            start_date: None,
            end_date: None,
            sampling_frequency: None,
            confidence_levels: None,
            weights: weights
                .iter()
                .map(|(symbol, weight)| ((*symbol).to_string(), *weight))
                .collect(),
        }
    }

    #[traced_test]
    #[test]
    fn resolves_story_defaults_when_fields_absent() {
        let contract = resolve_contract(&request_with(&[("BTC", 1.0)])).unwrap();

        assert_eq!(
            contract.window,
            MeasurementWindow::Lookback { lookback_days: 90 }
        );
        assert_eq!(contract.sampling_frequency, SamplingFrequency::Daily);
        assert_eq!(contract.confidence_levels.len(), 3);
        assert!(logs_contain_at(Level::DEBUG, &["risk contract resolved"]));
    }

    #[test]
    fn rejects_lookback_outside_the_allowed_range() {
        let mut request = request_with(&[("BTC", 1.0)]);
        request.lookback_days = Some(10);
        assert_eq!(
            resolve_contract(&request),
            Err(RiskError::LookbackOutOfRange { days: 10 })
        );
    }

    #[test]
    fn explicit_range_takes_precedence_and_is_validated() {
        let mut request = request_with(&[("BTC", 1.0)]);
        request.lookback_days = Some(90);
        request.start_date = Some("2024-01-01".to_string());
        request.end_date = Some("2024-03-01".to_string());

        let contract = resolve_contract(&request).unwrap();
        assert_eq!(
            contract.window,
            MeasurementWindow::Range {
                start_date: NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
                end_date: NaiveDate::from_ymd_opt(2024, 3, 1).unwrap(),
            }
        );
    }

    #[test]
    fn rejects_non_chronological_range() {
        let mut request = request_with(&[("BTC", 1.0)]);
        request.start_date = Some("2024-03-01".to_string());
        request.end_date = Some("2024-01-01".to_string());
        assert_eq!(
            resolve_contract(&request),
            Err(RiskError::NonChronologicalRange)
        );
    }

    #[test]
    fn rejects_range_span_outside_bounds() {
        let mut request = request_with(&[("BTC", 1.0)]);
        request.start_date = Some("2024-01-01".to_string());
        request.end_date = Some("2024-01-10".to_string());
        assert_eq!(
            resolve_contract(&request),
            Err(RiskError::WindowSpanOutOfRange { days: 9 })
        );
    }

    #[test]
    fn rejects_a_half_specified_range() {
        let mut request = request_with(&[("BTC", 1.0)]);
        request.start_date = Some("2024-01-01".to_string());
        assert_eq!(
            resolve_contract(&request),
            Err(RiskError::IncompleteDateRange)
        );
    }

    #[test]
    fn rejects_unsupported_confidence_level() {
        let mut request = request_with(&[("BTC", 1.0)]);
        request.confidence_levels = Some(vec![0.80]);
        assert_eq!(
            resolve_contract(&request),
            Err(RiskError::UnsupportedConfidenceLevel { value: 0.80 })
        );
    }

    #[test]
    fn rejects_weights_that_do_not_sum_to_one_in_absolute_value() {
        let result = resolve_contract(&request_with(&[("BTC", 0.6), ("ETH", 0.6)]));
        assert!(matches!(
            result,
            Err(RiskError::WeightsNotNormalized { .. })
        ));
    }

    #[test]
    fn accepts_long_short_weights_summing_to_one_in_absolute_value() {
        assert!(resolve_contract(&request_with(&[("BTC", 0.6), ("ETH", -0.4)])).is_ok());
    }

    /// Builds a daily-candle frame from `(date, ticker, close)` rows; dates are
    /// `YYYY-MM-DD` and become midnight-UTC timestamps like the ingested CSVs.
    fn candle_frame(rows: &[(&str, &str, f64)]) -> DataFrame {
        let timestamps: Vec<String> = rows
            .iter()
            .map(|(date, _, _)| format!("{date}T00:00:00.000Z"))
            .collect();
        let tickers: Vec<&str> = rows.iter().map(|(_, ticker, _)| *ticker).collect();
        let closes: Vec<f64> = rows.iter().map(|(_, _, close)| *close).collect();
        polars::prelude::df! {
            "timestamp" => timestamps,
            "ticker" => tickers,
            "close" => closes,
        }
        .unwrap()
    }

    /// Runs the shared return pipeline (window, sampling, log returns) and the
    /// simple-space aggregation for a request, as `assess_risk` does.
    fn portfolio_returns_for(
        candles: &DataFrame,
        request: &RiskRequest,
    ) -> Result<Vec<f64>, RiskAssessmentError> {
        let contract = resolve_contract(request).unwrap();
        let log_returns = log_returns_in_window(candles, &contract, &request.weights)?;
        aggregate_in_simple_space(&log_returns, &request.weights)
    }

    #[test]
    fn aggregates_portfolio_returns_in_simple_space() {
        let candles = candle_frame(&[
            ("2024-01-01", "BTC", 100.0),
            ("2024-01-01", "ETH", 200.0),
            ("2024-01-02", "BTC", 110.0),
            ("2024-01-02", "ETH", 180.0),
            ("2024-01-03", "BTC", 99.0),
            ("2024-01-03", "ETH", 189.0),
        ]);
        let request = request_with(&[("BTC", 0.5), ("ETH", 0.5)]);

        let returns = portfolio_returns_for(&candles, &request).unwrap();

        // Simple-space aggregation: r_p = sum_i w_i * (close_t/close_{t-1} - 1),
        // NOT exp(sum of weighted log returns) - 1.
        assert_eq!(returns.len(), 2);
        assert!((returns[0] - 0.5f64.mul_add(0.1, 0.5 * -0.1)).abs() < 1e-12);
        assert!((returns[1] - 0.5f64.mul_add(99.0 / 110.0 - 1.0, 0.5 * 0.05)).abs() < 1e-12);
    }

    #[test]
    fn weekly_sampling_uses_last_close_of_each_iso_week() {
        // 2024-01-01 is a Monday: days 1-7 are ISO week 1, 8-14 week 2, 15 week 3.
        let closes_by_day: Vec<(String, f64)> = (1..=15)
            .map(|day| (format!("2024-01-{day:02}"), 100.0 + f64::from(day)))
            .collect();
        let rows: Vec<(&str, &str, f64)> = closes_by_day
            .iter()
            .map(|(date, close)| (date.as_str(), "BTC", *close))
            .collect();
        let candles = candle_frame(&rows);
        let mut request = request_with(&[("BTC", 1.0)]);
        request.sampling_frequency = Some(SamplingFrequency::Weekly);

        let returns = portfolio_returns_for(&candles, &request).unwrap();

        // Week-end closes are Jan 7 (107), Jan 14 (114), Jan 15 (115).
        assert_eq!(returns.len(), 2);
        assert!((returns[0] - (114.0 / 107.0 - 1.0)).abs() < 1e-12);
        assert!((returns[1] - (115.0 / 114.0 - 1.0)).abs() < 1e-12);
    }

    #[test]
    fn lookback_window_keeps_only_trailing_days() {
        let closes_by_day: Vec<(String, f64)> = (0..40)
            .map(|offset| {
                let date = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap() + chrono::Days::new(offset);
                (date.format("%Y-%m-%d").to_string(), 100.0)
            })
            .collect();
        let rows: Vec<(&str, &str, f64)> = closes_by_day
            .iter()
            .map(|(date, close)| (date.as_str(), "BTC", *close))
            .collect();
        let candles = candle_frame(&rows);
        let mut request = request_with(&[("BTC", 1.0)]);
        request.lookback_days = Some(30);

        let returns = portfolio_returns_for(&candles, &request).unwrap();

        // 30 lookback days anchored on the latest close keep 31 closes -> 30 returns.
        assert_eq!(returns.len(), 30);
    }

    #[test]
    fn explicit_range_window_keeps_only_in_range_days() {
        let closes_by_day: Vec<(String, f64)> = (0..40)
            .map(|offset| {
                let date = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap() + chrono::Days::new(offset);
                (date.format("%Y-%m-%d").to_string(), 100.0)
            })
            .collect();
        let rows: Vec<(&str, &str, f64)> = closes_by_day
            .iter()
            .map(|(date, close)| (date.as_str(), "BTC", *close))
            .collect();
        let candles = candle_frame(&rows);
        let mut request = request_with(&[("BTC", 1.0)]);
        request.start_date = Some("2024-01-01".to_string());
        request.end_date = Some("2024-01-31".to_string());

        let returns = portfolio_returns_for(&candles, &request).unwrap();

        // Jan 1 through Jan 31 inclusive is 31 closes -> 30 returns.
        assert_eq!(returns.len(), 30);
    }

    #[test]
    fn errors_when_a_weighted_ticker_has_no_data_in_window() {
        let candles = candle_frame(&[("2024-01-01", "BTC", 100.0), ("2024-01-02", "BTC", 110.0)]);
        let request = request_with(&[("BTC", 0.5), ("DOGE", 0.5)]);

        let result = portfolio_returns_for(&candles, &request);

        assert!(matches!(
            result,
            Err(RiskAssessmentError::MissingTickerData { ticker }) if ticker == "DOGE"
        ));
    }

    #[test]
    fn errors_when_the_window_yields_too_few_returns() {
        let candles = candle_frame(&[("2024-01-01", "BTC", 100.0), ("2024-01-02", "BTC", 110.0)]);
        let request = request_with(&[("BTC", 1.0)]);

        let result = portfolio_returns_for(&candles, &request);

        assert!(matches!(
            result,
            Err(RiskAssessmentError::InsufficientObservations { observations: 1 })
        ));
    }

    #[test]
    fn tail_risk_matches_the_acerbi_tasche_closed_form() {
        // Losses are 0.01, 0.02, ..., 1.00 (returns are their negations).
        let returns: Vec<f64> = (1..=100).map(|loss| -f64::from(loss) / 100.0).collect();
        let levels: Vec<ConfidenceLevel> = [0.90, 0.95, 0.99]
            .iter()
            .map(|level| ConfidenceLevel::new(*level).unwrap())
            .collect();

        let tail = compute_tail_risk(&returns, &levels).unwrap();

        // At 0.90 the tail holds 10 observations: VaR is the 10th-worst loss,
        // CVaR the mean of the worst 10. Same shape at 0.95 (5) and 0.99 (1).
        assert!((tail[0].value_at_risk - 0.91).abs() < 1e-12);
        assert!((tail[0].conditional_value_at_risk - 0.955).abs() < 1e-12);
        assert!((tail[1].value_at_risk - 0.96).abs() < 1e-12);
        assert!((tail[1].conditional_value_at_risk - 0.98).abs() < 1e-12);
        assert!((tail[2].value_at_risk - 1.0).abs() < 1e-12);
        assert!((tail[2].conditional_value_at_risk - 1.0).abs() < 1e-12);
    }

    #[test]
    fn tail_risk_interpolates_a_fractional_tail() {
        // 8 observations at 0.90: tail mass is 0.8 < 1, so VaR is the worst
        // loss and CVaR equals it (the whole tail is the fractional boundary).
        let returns: Vec<f64> = (1..=8).map(|loss| -f64::from(loss) / 10.0).collect();
        let levels = vec![ConfidenceLevel::new(0.90).unwrap()];

        let tail = compute_tail_risk(&returns, &levels).unwrap();

        assert!((tail[0].value_at_risk - 0.8).abs() < 1e-12);
        assert!((tail[0].conditional_value_at_risk - 0.8).abs() < 1e-12);
    }

    proptest! {
        /// CVaR dominates VaR, both are monotone in the confidence level, and
        /// neither exceeds the worst observed loss.
        #[test]
        fn cvar_dominates_var_and_both_are_monotone(
            returns in prop::collection::vec(-0.5_f64..0.5, 5..60),
        ) {
            let levels: Vec<ConfidenceLevel> = [0.90, 0.95, 0.99]
                .iter()
                .map(|level| ConfidenceLevel::new(*level).unwrap())
                .collect();

            let tail = compute_tail_risk(&returns, &levels).unwrap();

            let worst_loss = returns.iter().fold(f64::MIN, |max, ret| max.max(-ret));
            for metric in &tail {
                prop_assert!(metric.conditional_value_at_risk >= metric.value_at_risk - 1e-12);
                prop_assert!(metric.conditional_value_at_risk <= worst_loss + 1e-12);
            }
            for pair in tail.windows(2) {
                prop_assert!(pair[1].value_at_risk >= pair[0].value_at_risk - 1e-12);
                prop_assert!(
                    pair[1].conditional_value_at_risk >= pair[0].conditional_value_at_risk - 1e-12
                );
            }
        }
    }

    /// Builds the per-ticker log-return map [`compute_correlation`] consumes,
    /// with each series keyed on consecutive dates from 2024-01-01.
    fn log_returns_map(series: &[(&str, &[f64])]) -> BTreeMap<String, BTreeMap<NaiveDate, f64>> {
        series
            .iter()
            .map(|(ticker, log_returns)| {
                let by_date = log_returns
                    .iter()
                    .enumerate()
                    .map(|(day_offset, log_return)| {
                        let date = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap()
                            + chrono::Days::new(u64::try_from(day_offset).unwrap());
                        (date, *log_return)
                    })
                    .collect();
                ((*ticker).to_string(), by_date)
            })
            .collect()
    }

    /// Pearson correlation with maximum-likelihood (`1/T`) normalization, as a
    /// reference for the two-asset case where shrinkage is a no-op.
    fn sample_correlation(left: &[f64], right: &[f64]) -> f64 {
        let observations = u32::try_from(left.len()).unwrap();
        let scale = f64::from(observations);
        let left_mean: f64 = left.iter().sum::<f64>() / scale;
        let right_mean: f64 = right.iter().sum::<f64>() / scale;
        let covariance: f64 = left
            .iter()
            .zip(right)
            .map(|(left_value, right_value)| (left_value - left_mean) * (right_value - right_mean))
            .sum::<f64>()
            / scale;
        let left_variance: f64 = left
            .iter()
            .map(|value| (value - left_mean).powi(2))
            .sum::<f64>()
            / scale;
        let right_variance: f64 = right
            .iter()
            .map(|value| (value - right_mean).powi(2))
            .sum::<f64>()
            / scale;

        covariance / (left_variance * right_variance).sqrt()
    }

    #[test]
    fn two_asset_shrunk_correlation_equals_sample_correlation() {
        // With two assets the constant-correlation target equals the sample
        // covariance, so shrinkage cannot move the estimate.
        let btc_returns = [0.01, 0.02, -0.01, 0.03];
        let eth_returns = [0.02, 0.01, -0.02, 0.01];
        let log_returns = log_returns_map(&[("BTC", &btc_returns), ("ETH", &eth_returns)]);

        let report = compute_correlation(&log_returns).unwrap();

        let expected = sample_correlation(&btc_returns, &eth_returns);
        assert_eq!(report.tickers, vec!["BTC", "ETH"]);
        assert!((report.matrix[0][1] - expected).abs() < 1e-12);
        assert!((report.matrix[1][0] - expected).abs() < 1e-12);
        assert!((report.matrix[0][0] - 1.0).abs() < 1e-12);
        assert!((report.matrix[1][1] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn identical_assets_report_unit_correlation_without_shrinkage() {
        let shared_returns = [0.01, -0.02, 0.03, 0.005];
        let log_returns = log_returns_map(&[
            ("AAA", &shared_returns),
            ("BBB", &shared_returns),
            ("CCC", &shared_returns),
        ]);

        let report = compute_correlation(&log_returns).unwrap();

        // Perfectly correlated assets already sit on the constant-correlation
        // target, so the intensity is zero and every entry is 1.
        assert!(report.shrinkage_intensity.abs() < 1e-12);
        for row in &report.matrix {
            for entry in row {
                assert!(
                    (entry - 1.0).abs() < 1e-9,
                    "expected unit correlation, got {entry}"
                );
            }
        }
    }

    #[test]
    fn zero_variance_ticker_makes_correlation_undefined() {
        let btc_returns = [0.01, 0.02, -0.01, 0.03];
        let flat_returns = [0.0, 0.0, 0.0, 0.0];
        let log_returns = log_returns_map(&[("BTC", &btc_returns), ("USDC", &flat_returns)]);

        let result = compute_correlation(&log_returns);

        assert!(matches!(
            result,
            Err(RiskAssessmentError::ZeroVarianceTicker { ticker }) if ticker == "USDC"
        ));
    }

    #[test]
    fn shrinkage_intensity_scales_inversely_with_observations() {
        let first = [0.02, -0.01, 0.03, -0.02, 0.01, 0.04, -0.03, 0.02];
        let second = [-0.01, 0.02, -0.02, 0.03, -0.01, 0.01, 0.02, -0.02];
        let third = [0.03, 0.01, -0.01, 0.02, -0.03, 0.02, 0.01, -0.01];
        let log_returns = log_returns_map(&[("AAA", &first), ("BBB", &second), ("CCC", &third)]);
        let intensity = compute_correlation(&log_returns)
            .unwrap()
            .shrinkage_intensity;
        assert!(
            intensity > 0.0 && intensity < 1.0,
            "fixture must produce an interior intensity, got {intensity}"
        );

        // Duplicating the sample tenfold leaves every moment estimate unchanged
        // but divides the optimal intensity kappa/T by ten.
        let repeat = |values: &[f64]| -> Vec<f64> { values.repeat(10) };
        let duplicated = log_returns_map(&[
            ("AAA", &repeat(&first)),
            ("BBB", &repeat(&second)),
            ("CCC", &repeat(&third)),
        ]);
        let duplicated_intensity = compute_correlation(&duplicated)
            .unwrap()
            .shrinkage_intensity;

        assert!(
            (duplicated_intensity - intensity / 10.0).abs() < 1e-12,
            "expected {}, got {duplicated_intensity}",
            intensity / 10.0
        );
    }

    proptest! {
        /// The shrunk correlation matrix is symmetric with a unit diagonal,
        /// every entry within [-1, 1], and an intensity within [0, 1].
        #[test]
        fn shrunk_correlation_is_symmetric_bounded_with_unit_diagonal(
            first in prop::collection::vec(-0.2_f64..0.2, 6..30),
            jitter in prop::collection::vec(-0.05_f64..0.05, 6..30),
        ) {
            let observations = first.len().min(jitter.len());
            prop_assume!(observations >= 6);
            let first: Vec<f64> = first.iter().copied().take(observations).collect();
            prop_assume!(
                first.windows(2).any(|pair| (pair[0] - pair[1]).abs() > 1e-6)
            );
            // Derive two more series with index-dependent tilts so every
            // column varies and no pair is exactly collinear.
            let second: Vec<f64> = first
                .iter()
                .zip(&jitter)
                .map(|(base, noise)| -base + noise + 0.001)
                .collect();
            let third: Vec<f64> = first
                .iter()
                .zip(jitter.iter().rev())
                .map(|(base, noise)| 0.5 * base + 2.0 * noise - 0.002)
                .collect();
            prop_assume!(second.windows(2).any(|pair| (pair[0] - pair[1]).abs() > 1e-6));
            prop_assume!(third.windows(2).any(|pair| (pair[0] - pair[1]).abs() > 1e-6));

            let log_returns =
                log_returns_map(&[("AAA", &first), ("BBB", &second), ("CCC", &third)]);
            let report = compute_correlation(&log_returns).unwrap();

            prop_assert!((0.0..=1.0).contains(&report.shrinkage_intensity));
            for (row_index, row) in report.matrix.iter().enumerate() {
                for (col_index, entry) in row.iter().enumerate() {
                    if row_index == col_index {
                        prop_assert!((entry - 1.0).abs() < 1e-12);
                    } else {
                        prop_assert!(entry.abs() <= 1.0 + 1e-9);
                        prop_assert!(
                            (entry - report.matrix[col_index][row_index]).abs() < 1e-12
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn drawdown_reports_deepest_peak_to_trough_decline_and_its_length() {
        // Wealth path: 1.1, 0.88, 0.66, 0.99 -- the peak is 1.1, the trough
        // 0.66, so the deepest decline is 40% over two periods.
        let drawdown = compute_drawdown(&[0.1, -0.2, -0.25, 0.5]);

        assert!((drawdown.max_drawdown - 0.4).abs() < 1e-12);
        assert_eq!(drawdown.peak_to_trough_periods, 2);
    }

    #[test]
    fn drawdown_is_zero_for_a_monotonically_rising_path() {
        let drawdown = compute_drawdown(&[0.01, 0.02, 0.03]);

        assert!(drawdown.max_drawdown.abs() < 1e-12);
        assert_eq!(drawdown.peak_to_trough_periods, 0);
    }

    #[test]
    fn drawdown_caps_at_full_loss_when_wealth_touches_zero() {
        // A 150% single-period loss (leveraged short leg) wipes the path out.
        let drawdown = compute_drawdown(&[0.1, -1.5, 0.2]);

        assert!((drawdown.max_drawdown - 1.0).abs() < 1e-12);
    }

    proptest! {
        /// Drawdown is a fraction of the peak: within [0, 1] for any return
        /// path bounded below by -100%, with a duration within the path length.
        #[test]
        fn drawdown_is_bounded_by_zero_and_one(
            returns in prop::collection::vec(-0.99_f64..2.0, 1..60),
        ) {
            let drawdown = compute_drawdown(&returns);

            prop_assert!(drawdown.max_drawdown >= 0.0);
            prop_assert!(drawdown.max_drawdown <= 1.0 + 1e-12);
            prop_assert!(drawdown.peak_to_trough_periods <= returns.len());
        }
    }

    #[traced_test]
    #[tokio::test]
    async fn assess_risk_reports_tail_metrics_for_ingested_candles() {
        let data_dir = tempfile::TempDir::new().unwrap();
        std::fs::copy(
            "fixtures/ohlcv_1d_beta.csv",
            data_dir.path().join("ohlcv_1d.csv"),
        )
        .unwrap();
        let request = request_with(&[("BTC", 0.6), ("ETH", -0.4)]);

        let response = assess_risk(data_dir.path(), &request).await.unwrap();

        assert_eq!(response.tail_risk.len(), 3);
        for metric in &response.tail_risk {
            assert!(
                metric.value_at_risk.is_finite() && metric.value_at_risk > 0.0,
                "VaR must be a positive loss fraction, got {}",
                metric.value_at_risk
            );
            assert!(
                metric.conditional_value_at_risk >= metric.value_at_risk,
                "CVaR {} must dominate VaR {}",
                metric.conditional_value_at_risk,
                metric.value_at_risk
            );
        }
        assert!(
            response.drawdown.max_drawdown > 0.0 && response.drawdown.max_drawdown <= 1.0,
            "the fixture's oscillating closes must produce a real drawdown, got {}",
            response.drawdown.max_drawdown
        );
        assert_eq!(response.correlation.tickers, vec!["BTC", "ETH"]);
        assert!(
            response.correlation.matrix[0][1].abs() <= 1.0,
            "off-diagonal correlation must be within [-1, 1], got {}",
            response.correlation.matrix[0][1]
        );
        assert!((0.0..=1.0).contains(&response.correlation.shrinkage_intensity));
        assert!(logs_contain_at(
            Level::DEBUG,
            &["risk metrics computed", "observations=", "max_drawdown="]
        ));
    }

    #[tokio::test]
    async fn assess_risk_errors_when_no_candle_data() {
        let data_dir = tempfile::TempDir::new().unwrap();
        let request = request_with(&[("BTC", 1.0)]);

        let result = assess_risk(data_dir.path(), &request).await;

        assert!(matches!(result, Err(RiskAssessmentError::NoData { .. })));
    }
}
