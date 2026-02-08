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

    pub(crate) fn lookback_days(self) -> i64 {
        match self {
            Self::FifteenMin => 30,
            Self::OneHour => 90,
            Self::OneDay => 365,
            Self::OneWeek => 365 * 3,
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
