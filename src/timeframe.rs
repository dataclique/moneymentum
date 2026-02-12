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

    /// Duration covered by a full 5000-candle window for this timeframe.
    ///
    /// Hyperliquid's `candleSnapshot` endpoint returns at most 5000 candles per
    /// request ([docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#candle-snapshot)).
    /// We use this to choose the start time so that we always request the
    /// maximum useful history per market.
    pub(crate) fn window_duration(self) -> chrono::Duration {
        match self {
            Self::FifteenMin => chrono::Duration::minutes(15 * 5000),
            Self::OneHour => chrono::Duration::hours(5000),
            Self::OneDay => chrono::Duration::days(5000),
            Self::OneWeek => chrono::Duration::days(7 * 5000),
        }
    }

    pub(crate) fn file_name(self) -> &'static str {
        match self {
            Self::FifteenMin => "ohlcv_15m.csv",
            Self::OneHour => "ohlcv1h.csv",
            Self::OneDay => "ohlcv_1d.csv",
            Self::OneWeek => "ohlcv_1w.csv",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn lookback_increases_with_granularity() {
        assert!(Timeframe::FifteenMin.lookback_days() < Timeframe::OneHour.lookback_days());
        assert!(Timeframe::OneHour.lookback_days() < Timeframe::OneDay.lookback_days());
        assert!(Timeframe::OneDay.lookback_days() < Timeframe::OneWeek.lookback_days());
    }
}
