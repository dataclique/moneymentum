use std::marker::PhantomData;

use crate::series::Observation;

// -- Leaf markers (no type parameter) --

/// Absolute price level (e.g., USD spot price of an asset).
pub struct Price;

impl Observation for Price {
    fn label() -> String {
        "price".into()
    }
}

/// Arithmetic (simple) return variant.
pub struct Simple;

impl Observation for Simple {
    fn label() -> String {
        "simple".into()
    }
}

/// Logarithmic return variant.
pub struct Log;

impl Observation for Log {
    fn label() -> String {
        "log".into()
    }
}

// -- Composable markers (wrap an inner observation type) --

/// Return series parameterized by kind (`Simple` or `Log`).
///
/// - `Return<Simple>`: r_t = (P_t - P_{t-1}) / P_{t-1}
/// - `Return<Log>`:    r_t = ln(P_t / P_{t-1})
pub struct Return<Kind>(PhantomData<Kind>);

impl<K: Observation> Observation for Return<K> {
    fn label() -> String {
        format!("{} return", K::label())
    }
}

/// Realized volatility (rolling standard deviation) of a source series.
///
/// `Vol<Return<Simple>>` -- realized vol of simple returns.
/// `Vol<Return<Log>>`    -- realized vol of log returns.
pub struct Vol<Source>(PhantomData<Source>);

impl<S: Observation> Observation for Vol<S> {
    fn label() -> String {
        format!("{} vol", S::label())
    }
}

/// Drawdown from peak of a source series.
///
/// dd_t = (X_t - max(X_0..X_t)) / max(X_0..X_t)
pub struct Drawdown<Source>(PhantomData<Source>);

impl<S: Observation> Observation for Drawdown<S> {
    fn label() -> String {
        format!("{} drawdown", S::label())
    }
}

/// Standardized (z-score) observation of a source series.
///
/// z = (x - mu) / sigma
pub struct Normalized<Source>(PhantomData<Source>);

impl<S: Observation> Observation for Normalized<S> {
    fn label() -> String {
        format!("normalized {}", S::label())
    }
}
