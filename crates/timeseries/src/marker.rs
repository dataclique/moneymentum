use crate::series::Observation;

/// Absolute price level (e.g., USD spot price of an asset).
pub struct Price;

impl Observation for Price {
    fn label() -> &'static str {
        "price"
    }
}

/// Arithmetic (simple) return: r_t = (P_t - P_{t-1}) / P_{t-1}.
pub struct SimpleReturn;

impl Observation for SimpleReturn {
    fn label() -> &'static str {
        "simple return"
    }
}

/// Logarithmic return: r_t = ln(P_t / P_{t-1}).
pub struct LogReturn;

impl Observation for LogReturn {
    fn label() -> &'static str {
        "log return"
    }
}

/// Realized volatility (rolling standard deviation of returns).
pub struct RealizedVol;

impl Observation for RealizedVol {
    fn label() -> &'static str {
        "realized vol"
    }
}

/// Drawdown from peak: dd_t = (P_t - max(P_0..P_t)) / max(P_0..P_t).
pub struct Drawdown;

impl Observation for Drawdown {
    fn label() -> &'static str {
        "drawdown"
    }
}

/// Standardized observation: z = (x - mu) / sigma.
pub struct ZScore;

impl Observation for ZScore {
    fn label() -> &'static str {
        "z-score"
    }
}
