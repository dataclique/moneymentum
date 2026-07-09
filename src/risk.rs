//! Risk analytics for the active portfolio (story 0x01b).
//!
//! Every metric shares one measurement contract -- the window, sampling
//! frequency, and confidence levels -- so they describe the same portfolio under
//! the same assumptions. This module owns that contract and its validation;
//! metric math (VaR, CVaR, correlation, drawdown, ENB, Monte Carlo) is added on
//! top as it lands.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, instrument};

/// Inclusive lower bound on the measurement window, in days (story 0x01b).
const MIN_WINDOW_DAYS: i64 = 30;
/// Inclusive upper bound on the measurement window, in days (story 0x01b).
const MAX_WINDOW_DAYS: i64 = 365;
/// Default lookback when none is supplied (story 0x01b).
const DEFAULT_LOOKBACK_DAYS: u16 = 90;
/// Confidence levels VaR/CVaR may use, and the default set (story 0x01b).
const ALLOWED_CONFIDENCE_LEVELS: [f64; 3] = [0.90, 0.95, 0.99];

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
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub(crate) struct ConfidenceLevel(f64);

impl ConfidenceLevel {
    fn new(value: f64) -> Result<Self, RiskError> {
        if ALLOWED_CONFIDENCE_LEVELS
            .iter()
            .any(|allowed| (allowed - value).abs() < 1e-9)
        {
            Ok(Self(value))
        } else {
            Err(RiskError::UnsupportedConfidenceLevel { value })
        }
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

/// Resolves and validates a [`RiskRequest`] into the [`MeasurementContract`] the
/// metrics run against. Applies the story-0x01b defaults where fields are absent.
#[instrument(skip_all)]
pub(crate) fn resolve_contract(request: &RiskRequest) -> Result<MeasurementContract, RiskError> {
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
