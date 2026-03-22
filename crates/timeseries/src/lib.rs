pub mod marker;
pub mod pipeline;
pub mod series;
pub mod transform;

pub use marker::{Drawdown, LogReturn, Price, RealizedVol, SimpleReturn, ZScore};
pub use pipeline::chain;
pub use series::{Observation, SeriesError, TimeSeries};
pub use transform::{
    LogRollingVolatility, Normalize, PeakDrawdown, PriceLogReturn, PriceReturn, RollingVolatility,
    TransformError,
};
