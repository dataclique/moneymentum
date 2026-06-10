//! OHLCV candle timeframes with lookback configuration.
//!
//! Each timeframe has a different historical lookback depth: shorter intervals
//! have shorter lookbacks (30 days for 15m) while longer intervals go further
//! back (3 years for weekly). This balances storage costs against analytical
//! utility - higher-frequency data is most relevant for recent periods.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Timeframe {
    FifteenMin,
    OneHour,
    OneDay,
    OneWeek,
}

impl Timeframe {
    pub(crate) fn from_interval_string(interval: &str) -> Option<Self> {
        match interval {
            "15m" => Some(Self::FifteenMin),
            "1h" => Some(Self::OneHour),
            "1d" => Some(Self::OneDay),
            "1w" => Some(Self::OneWeek),
            _ => None,
        }
    }

    pub(crate) fn interval_string(self) -> &'static str {
        match self {
            Self::FifteenMin => "15m",
            Self::OneHour => "1h",
            Self::OneDay => "1d",
            Self::OneWeek => "1w",
        }
    }

    /// Duration covered by a window of `max_entries` candles for this timeframe.
    ///
    /// Callers (e.g. exchange adapters) pass their API's maximum history size;
    /// this keeps the domain independent of any specific data source.
    pub(crate) fn window_duration(self, max_entries: i64) -> chrono::Duration {
        match self {
            Self::FifteenMin => chrono::Duration::minutes(15 * max_entries),
            Self::OneHour => chrono::Duration::hours(max_entries),
            Self::OneDay => chrono::Duration::days(max_entries),
            Self::OneWeek => chrono::Duration::days(7 * max_entries),
        }
    }

    pub(crate) fn file_name(self) -> &'static str {
        match self {
            Self::FifteenMin => "ohlcv_15m.csv",
            Self::OneHour => "ohlcv_1h.csv",
            Self::OneDay => "ohlcv_1d.csv",
            Self::OneWeek => "ohlcv_1w.csv",
        }
    }

    /// Factor-engine parameters for this timeframe, ported from the legacy
    /// `util.py` `TIMEFRAME_CONFIGS`. Fields are added as factors that consume
    /// them land (e.g. `min_acceptable_return` arrives with the Sortino factor).
    pub(crate) fn config(self) -> TimeframeConfig {
        match self {
            Self::FifteenMin => TimeframeConfig {
                lookback_periods: 7 * 24 * 4,
                annualized_factor: 365.0 * 24.0 * 4.0,
            },
            Self::OneHour => TimeframeConfig {
                lookback_periods: 7 * 24,
                annualized_factor: 365.0 * 24.0,
            },
            Self::OneDay => TimeframeConfig {
                lookback_periods: 90,
                annualized_factor: 365.0,
            },
            Self::OneWeek => TimeframeConfig {
                lookback_periods: 52,
                annualized_factor: 52.0,
            },
        }
    }
}

/// Per-timeframe parameters that drive the factor engine's windowed math.
pub(crate) struct TimeframeConfig {
    /// Number of candles in the lookback window for rolling factor math.
    pub(crate) lookback_periods: usize,
    /// Scaling factor to annualize per-period returns and volatility.
    pub(crate) annualized_factor: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_matches_legacy_timeframe_constants() {
        let fifteen = Timeframe::FifteenMin.config();
        assert_eq!(fifteen.lookback_periods, 672);
        assert!((fifteen.annualized_factor - 35040.0).abs() < f64::EPSILON);

        let hour = Timeframe::OneHour.config();
        assert_eq!(hour.lookback_periods, 168);
        assert!((hour.annualized_factor - 8760.0).abs() < f64::EPSILON);

        let day = Timeframe::OneDay.config();
        assert_eq!(day.lookback_periods, 90);
        assert!((day.annualized_factor - 365.0).abs() < f64::EPSILON);

        let week = Timeframe::OneWeek.config();
        assert_eq!(week.lookback_periods, 52);
        assert!((week.annualized_factor - 52.0).abs() < f64::EPSILON);
    }

    #[test]
    fn interval_strings_are_valid() {
        assert_eq!(Timeframe::FifteenMin.interval_string(), "15m");
        assert_eq!(Timeframe::OneHour.interval_string(), "1h");
        assert_eq!(Timeframe::OneDay.interval_string(), "1d");
        assert_eq!(Timeframe::OneWeek.interval_string(), "1w");
    }

    #[test]
    fn interval_string_roundtrips() {
        for timeframe in [
            Timeframe::FifteenMin,
            Timeframe::OneHour,
            Timeframe::OneDay,
            Timeframe::OneWeek,
        ] {
            assert_eq!(
                Timeframe::from_interval_string(timeframe.interval_string()),
                Some(timeframe)
            );
        }
    }

    #[test]
    fn window_duration_increases_with_granularity() {
        let max_entries = 5000_i64;
        assert!(
            Timeframe::FifteenMin.window_duration(max_entries)
                < Timeframe::OneHour.window_duration(max_entries)
        );
        assert!(
            Timeframe::OneHour.window_duration(max_entries)
                < Timeframe::OneDay.window_duration(max_entries)
        );
        assert!(
            Timeframe::OneDay.window_duration(max_entries)
                < Timeframe::OneWeek.window_duration(max_entries)
        );
    }
}
