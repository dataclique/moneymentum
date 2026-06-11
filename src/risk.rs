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

/// Risk analytics for the active portfolio: the resolved measurement contract
/// plus every metric computed under it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RiskResponse {
    contract: MeasurementContract,
    tail_risk: Vec<TailRisk>,
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

    let portfolio_returns = portfolio_simple_returns(&candles, &contract, &request.weights)?;
    let tail_risk = compute_tail_risk(&portfolio_returns, &contract.confidence_levels)?;
    debug!(
        observations = portfolio_returns.len(),
        levels = tail_risk.len(),
        "risk metrics computed"
    );

    Ok(RiskResponse {
        contract,
        tail_risk,
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

/// The portfolio's simple-return series over the contract window at the
/// contract sampling frequency, ordered chronologically.
///
/// Per-asset log returns are aggregated in simple-return space
/// (`sum_i w_i * (exp(r_i) - 1)`) on the dates where every weighted ticker has
/// a return.
fn portfolio_simple_returns(
    candles: &DataFrame,
    contract: &MeasurementContract,
    weights: &HashMap<String, f64>,
) -> Result<Vec<f64>, RiskAssessmentError> {
    let closes_by_ticker = window_closes_by_ticker(candles, contract.window, weights)?;
    let sampled_closes = sample_closes(closes_by_ticker, contract.sampling_frequency);
    let log_returns_by_ticker = per_ticker_log_returns(sampled_closes);
    aggregate_in_simple_space(&log_returns_by_ticker, weights)
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
        let contract = resolve_contract(&request).unwrap();

        let returns = portfolio_simple_returns(&candles, &contract, &request.weights).unwrap();

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
        let contract = resolve_contract(&request).unwrap();

        let returns = portfolio_simple_returns(&candles, &contract, &request.weights).unwrap();

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
        let contract = resolve_contract(&request).unwrap();

        let returns = portfolio_simple_returns(&candles, &contract, &request.weights).unwrap();

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
        let contract = resolve_contract(&request).unwrap();

        let returns = portfolio_simple_returns(&candles, &contract, &request.weights).unwrap();

        // Jan 1 through Jan 31 inclusive is 31 closes -> 30 returns.
        assert_eq!(returns.len(), 30);
    }

    #[test]
    fn errors_when_a_weighted_ticker_has_no_data_in_window() {
        let candles = candle_frame(&[("2024-01-01", "BTC", 100.0), ("2024-01-02", "BTC", 110.0)]);
        let request = request_with(&[("BTC", 0.5), ("DOGE", 0.5)]);
        let contract = resolve_contract(&request).unwrap();

        let result = portfolio_simple_returns(&candles, &contract, &request.weights);

        assert!(matches!(
            result,
            Err(RiskAssessmentError::MissingTickerData { ticker }) if ticker == "DOGE"
        ));
    }

    #[test]
    fn errors_when_the_window_yields_too_few_returns() {
        let candles = candle_frame(&[("2024-01-01", "BTC", 100.0), ("2024-01-02", "BTC", 110.0)]);
        let request = request_with(&[("BTC", 1.0)]);
        let contract = resolve_contract(&request).unwrap();

        let result = portfolio_simple_returns(&candles, &contract, &request.weights);

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
        assert!(logs_contain_at(
            Level::DEBUG,
            &["risk metrics computed", "observations="]
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
