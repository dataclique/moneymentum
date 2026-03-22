use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use tower::Service;

/// Chains two services into a sequential pipeline.
///
/// The output of `first` feeds into `second`. Only compiles when
/// the response type of `A` matches the request type of `B`,
/// enforcing type-safe composition at compile time.
///
/// ```text
/// TimeSeries<Price> --[PriceReturn]--> TimeSeries<SimpleReturn> --[RollingVolatility]--> TimeSeries<RealizedVol>
/// ```
pub struct Pipeline<A, B> {
    first: A,
    second: B,
}

/// Creates a pipeline that feeds the output of `first` into `second`.
///
/// Type-safe: only compiles when `first`'s `Response` matches
/// `second`'s request type.
pub fn chain<A, B>(first: A, second: B) -> Pipeline<A, B> {
    Pipeline { first, second }
}

impl<A, B, Req> Service<Req> for Pipeline<A, B>
where
    A: Service<Req> + Clone,
    B: Service<A::Response, Error = A::Error> + Clone + Unpin,
    A::Future: Unpin,
    B::Future: Unpin,
{
    type Response = B::Response;
    type Error = A::Error;
    type Future = PipelineFuture<A, B, Req>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // Both services must be ready
        match self.first.poll_ready(cx) {
            Poll::Ready(Ok(())) => {}
            other => return other,
        }
        self.second.poll_ready(cx)
    }

    fn call(&mut self, request: Req) -> Self::Future {
        let first_future = self.first.call(request);
        PipelineFuture::First {
            future: first_future,
            second: self.second.clone(),
        }
    }
}

impl<A: Clone, B: Clone> Clone for Pipeline<A, B> {
    fn clone(&self) -> Self {
        Self {
            first: self.first.clone(),
            second: self.second.clone(),
        }
    }
}

/// Future for a two-stage pipeline execution.
pub enum PipelineFuture<A, B, Req>
where
    A: Service<Req>,
    B: Service<A::Response>,
{
    First { future: A::Future, second: B },
    Second { future: B::Future },
}

impl<A, B, Req> Future for PipelineFuture<A, B, Req>
where
    A: Service<Req>,
    B: Service<A::Response, Error = A::Error> + Unpin,
    A::Future: Unpin,
    B::Future: Unpin,
{
    type Output = Result<B::Response, A::Error>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        // SAFETY: We never move the inner fields, and both futures are Unpin.
        let this = self.get_mut();

        loop {
            match this {
                Self::First { future, second } => {
                    let intermediate = match Pin::new(future).poll(cx) {
                        Poll::Ready(Ok(value)) => value,
                        Poll::Ready(Err(err)) => return Poll::Ready(Err(err)),
                        Poll::Pending => return Poll::Pending,
                    };
                    let second_future = second.call(intermediate);
                    *this = Self::Second {
                        future: second_future,
                    };
                }
                Self::Second { future } => {
                    return Pin::new(future).poll(cx);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use polars::prelude::{Column, DataFrame, DataType, NamedFrom, Series, TimeUnit};
    use tracing_test::traced_test;

    use super::*;
    use crate::marker::Price;
    use crate::series::TimeSeries;
    use crate::transform::{PriceReturn, RollingVolatility};

    const DAY_MS: i64 = 86_400_000;

    fn sample_price_series(prices: &[f64]) -> TimeSeries<Price> {
        let epoch_start: i64 = 1_704_067_200_000; // 2024-01-01T00:00:00Z
        let millis: Vec<i64> = (0..prices.len())
            .map(|idx| epoch_start + (idx as i64) * DAY_MS)
            .collect();
        let timestamps = Series::new("timestamp".into(), millis)
            .cast(&DataType::Datetime(TimeUnit::Milliseconds, None))
            .unwrap();

        let value_series = Series::new("value".into(), prices);
        let df =
            DataFrame::new(vec![Column::from(timestamps), Column::from(value_series)]).unwrap();

        TimeSeries::new(df).unwrap()
    }

    #[traced_test]
    #[tokio::test]
    async fn pipeline_chains_price_to_volatility() {
        // 10 prices -> 9 returns, window=3 -> 7 vol observations
        let prices = sample_price_series(&[
            100.0, 102.0, 101.0, 105.0, 103.0, 108.0, 107.0, 110.0, 109.0, 112.0,
        ]);

        let mut pipeline = chain(PriceReturn, RollingVolatility::new(3));
        let result = pipeline.call(prices).await.unwrap();

        assert_eq!(result.len(), 7);

        let values: Vec<f64> = result
            .as_dataframe()
            .column("value")
            .unwrap()
            .as_materialized_series()
            .f64()
            .unwrap()
            .into_no_null_iter()
            .collect();

        for value in &values {
            assert!(*value > 0.0, "vol should be positive, got {value}");
        }

        // Verify both stages logged
        assert!(logs_contain("computed simple returns"));
        assert!(logs_contain("computed rolling volatility"));
    }
}
