//! Type-safe CQRS wiring infrastructure.
//!
//! This module prevents a class of bugs where query processors are created but
//! never registered with their CQRS frameworks, causing events to persist
//! without updating materialized views.
//!
//! # Type-Level Tracking
//!
//! The system uses phantom types to track wiring dependencies at compile time:
//!
//! - [`Cons<A, Tail>`] - A type-level linked list cell. `A` is the aggregate
//!   that must be wired next, `Tail` is the remaining list.
//!
//! - [`Nil`] - Empty list, indicating all dependencies satisfied.
//!
//! - [`UnwiredQuery<Q, Deps>`] - Wraps a query processor `Q` with its
//!   wiring dependencies. The [`into_inner`](UnwiredQuery::into_inner) method
//!   is only available when `Deps = Nil`, enforcing complete wiring.
//!
//! # Examples
//!
//! ## Single-aggregate queries (simple case)
//!
//! ```ignore
//! // Query only needs wiring to Position aggregate
//! type ViewDeps = Cons<PositionAgg, Nil>;
//! let view: UnwiredQuery<PositionView, ViewDeps> = UnwiredQuery::new(view);
//!
//! // Build and discard - query dependencies satisfied after this wiring
//! let position_cqrs = CqrsBuilder::new(pool)
//!     .wire(view)
//!     .build(());
//! ```
//!
//! ## Multi-aggregate queries
//!
//! ```ignore
//! // Query requiring wiring to Position, then Mint aggregates
//! type TriggerDeps = Cons<PositionAgg, Cons<MintAgg, Nil>>;
//! let trigger: UnwiredQuery<Trigger, TriggerDeps> = UnwiredQuery::new(trigger);
//!
//! // Build Position CQRS - use build to get trigger back
//! let (position_cqrs, (trigger, ())) = CqrsBuilder::new(pool.clone())
//!     .wire(trigger)
//!     .build(());
//! // trigger is now: UnwiredQuery<Trigger, Cons<MintAgg, Nil>>
//!
//! // Build Mint CQRS - trigger's last dependency, can use simple build
//! let mint_cqrs = CqrsBuilder::new(pool.clone())
//!     .wire(trigger)
//!     .build(());
//! ```
//!
//! # Clippy Enforcement
//!
//! Direct calls to `postgres_cqrs` are blocked via clippy's
//! `disallowed-methods`. All CQRS construction must go through [`CqrsBuilder`],
//! which contains the single `#[allow]` escape hatch.

use std::marker::PhantomData;
use std::sync::Arc;

use cqrs_es::persist::{PersistenceError, ViewRepository};
use cqrs_es::{Aggregate, AggregateError, Query};
use postgres_es::{PostgresCqrs, PostgresViewRepository, postgres_cqrs};
use sqlx::PgPool;

/// Type-safe aggregate ID construction.
///
/// Prevents mixing up aggregate IDs by associating each ID type with its
/// aggregate and providing a typed construction method.
pub(crate) trait AggregateId<A: Aggregate> {
    /// Arguments needed to construct the ID (use `()` for singleton aggregates).
    type Args;

    /// Constructs the string ID from typed arguments.
    fn aggregate_id(args: Self::Args) -> String;
}

/// Associates a view table name with an aggregate type.
pub(crate) trait ViewTable: Aggregate {
    const TABLE: &'static str;
}

/// Type-safe CQRS wrapper that owns the `execute` namespace.
///
/// Wraps `PostgresCqrs` to provide type-safe command execution with proper
/// aggregate ID types instead of raw strings.
pub(crate) struct Cqrs<A: Aggregate>(PostgresCqrs<A>);

/// Type-safe view wrapper that owns the `load` namespace.
///
/// Wraps `PostgresViewRepository` to provide type-safe view loading with proper
/// aggregate ID types instead of raw strings.
pub(crate) struct View<A: Aggregate>(Arc<PostgresViewRepository<A, A>>);

impl<A: Aggregate> Cqrs<A> {
    pub(crate) fn new(inner: PostgresCqrs<A>) -> Self {
        Self(inner)
    }

    /// Execute a command using a typed aggregate ID.
    #[allow(clippy::disallowed_methods)] // the only authorized call site
    pub(crate) async fn execute<Id: AggregateId<A>>(
        &self,
        args: Id::Args,
        command: A::Command,
    ) -> Result<(), AggregateError<A::Error>> {
        let id = Id::aggregate_id(args);
        self.0.execute(&id, command).await
    }
}

impl<A: ViewTable + cqrs_es::View<A>> View<A> {
    pub(crate) fn new(pool: PgPool) -> Self {
        Self(Arc::new(PostgresViewRepository::new(A::TABLE, pool)))
    }

    /// Returns a clone of the inner repository for sharing with queries.
    pub(crate) fn repo(&self) -> Arc<PostgresViewRepository<A, A>> {
        Arc::clone(&self.0)
    }

    /// Load a view using a typed aggregate ID.
    #[allow(clippy::disallowed_methods)] // the only authorized call site
    pub(crate) async fn load<Id: AggregateId<A>>(
        &self,
        args: Id::Args,
    ) -> Result<Option<A>, PersistenceError> {
        let id = Id::aggregate_id(args);
        self.0.load(&id).await
    }
}

/// Type-level cons cell for building linked lists of aggregates.
///
/// Forms a compile-time linked list: `Cons<Agg1, Cons<Agg2, Nil>>`.
pub(crate) struct Cons<Head, Tail>(PhantomData<(Head, Tail)>);

/// Type-level empty list (nil).
///
/// Terminal element for type-level lists. When an [`UnwiredQuery`] reaches
/// this state, [`into_inner`](UnwiredQuery::into_inner) becomes available.
pub(crate) struct Nil;

/// A query processor with compile-time wiring dependencies.
///
/// Wraps an `Arc<Q>` and tracks which aggregates it still needs to be wired to
/// via the `Deps` phantom type. The inner Arc is only extractable via
/// [`into_inner`](Self::into_inner) when `Deps = Nil`.
///
/// # Type Parameter Evolution
///
/// Each call to [`CqrsBuilder::wire`] consumes this and returns a new instance
/// with the head aggregate removed from `Deps`:
///
/// ```text
/// UnwiredQuery<Q, Cons<A, Cons<B, Nil>>>
///     --wire to A-->
/// UnwiredQuery<Q, Cons<B, Nil>>
///     --wire to B-->
/// UnwiredQuery<Q, Nil>
///     --into_inner-->
/// Arc<Q>
/// ```
#[must_use = "query must be wired via CqrsBuilder, then extracted with into_inner"]
pub(crate) struct UnwiredQuery<Q, Deps> {
    query: Arc<Q>,
    _deps: PhantomData<Deps>,
}

impl<Q, Deps> UnwiredQuery<Q, Deps> {
    /// Creates a new unwired query with the given dependencies.
    ///
    /// The `Deps` type parameter should encode all aggregates this query
    /// needs to be wired to before it can be used.
    pub(crate) fn new(query: Q) -> Self {
        Self {
            query: Arc::new(query),
            _deps: PhantomData,
        }
    }
}

impl<Q> UnwiredQuery<Q, Nil> {
    /// Extracts the inner Arc. Only available when all dependencies are satisfied.
    ///
    /// This method's availability is the compile-time proof that all required
    /// aggregates have been wired via [`CqrsBuilder::wire`].
    pub(crate) fn into_inner(self) -> Arc<Q> {
        self.query
    }
}

/// Builder for a single CQRS framework with type-tracked query wiring.
///
/// Accumulates query processors via [`wire`](Self::wire) calls, tracking them
/// at the type level in the `Wired` parameter. Call [`build`](Self::build) to
/// construct the framework and get back wired queries for continued wiring.
pub(crate) struct CqrsBuilder<A: Aggregate, Wired = ()> {
    pool: PgPool,
    queries: Vec<Box<dyn Query<A>>>,
    wired: Wired,
}

impl<A: Aggregate> CqrsBuilder<A, ()> {
    /// Creates a new builder for aggregate type `A`.
    pub(crate) fn new(pool: PgPool) -> Self {
        Self {
            pool,
            queries: vec![],
            wired: (),
        }
    }

    /// Builds the CQRS framework when no queries were wired.
    ///
    /// Use this for aggregates that don't need materialized views - where
    /// replaying events on demand is sufficient. Currently unused because
    /// our only aggregate (Ingestion) has a view.
    #[allow(dead_code)]
    pub(crate) fn build<S>(self, services: S) -> Cqrs<A>
    where
        A: Aggregate<Services = S>,
    {
        #[allow(clippy::disallowed_methods)]
        Cqrs::new(postgres_cqrs(self.pool, self.queries, services))
    }
}

impl<A: Aggregate, W> CqrsBuilder<A, W> {
    /// Wires a query processor to this CQRS framework.
    ///
    /// Consumes the [`UnwiredQuery`] and returns a new builder with:
    /// - The query added to the internal processors list
    /// - An updated `UnwiredQuery` (with `A` removed from dependencies) added
    ///   to the `Wired` tuple for return at build time
    ///
    /// # Type Evolution
    ///
    /// The input query must have `A` as its next dependency:
    /// `UnwiredQuery<Q, Cons<A, Tail>>`. The returned query in the tuple
    /// will be `UnwiredQuery<Q, Tail>`.
    pub(crate) fn wire<Q, Tail>(
        mut self,
        query: UnwiredQuery<Q, Cons<A, Tail>>,
    ) -> CqrsBuilder<A, (UnwiredQuery<Q, Tail>, W)>
    where
        Q: Send + Sync + 'static,
        Arc<Q>: Query<A>,
    {
        self.queries.push(Box::new(query.query.clone()));

        CqrsBuilder {
            pool: self.pool,
            queries: self.queries,
            wired: (
                UnwiredQuery {
                    query: query.query,
                    _deps: PhantomData,
                },
                self.wired,
            ),
        }
    }
}

impl<A: Aggregate, H, T> CqrsBuilder<A, (H, T)> {
    /// Builds the CQRS framework, returning it with all wired queries.
    ///
    /// Destructure the returned tuple to continue wiring to other builders
    /// or extract via [`UnwiredQuery::into_inner`].
    pub(crate) fn build<S>(self, services: S) -> (Cqrs<A>, (H, T))
    where
        A: Aggregate<Services = S>,
    {
        // This is the only authorized call site for postgres_cqrs
        #[allow(clippy::disallowed_methods)]
        let cqrs = Cqrs::new(postgres_cqrs(self.pool, self.queries, services));
        (cqrs, self.wired)
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use cqrs_es::event_sink::EventSink;
    use cqrs_es::{DomainEvent, EventEnvelope};
    use serde::{Deserialize, Serialize};
    use sqlx::postgres::PgPoolOptions;

    use super::*;
    use crate::lifecycle::{Lifecycle, Never};

    const TEST_DATABASE_URL: &str = env!("DATABASE_URL");

    fn test_pool() -> PgPool {
        PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy(TEST_DATABASE_URL)
            .expect("lazy pool creation should not fail")
    }

    #[derive(Debug, Clone, Default, Serialize, Deserialize)]
    struct AggregateA;

    #[derive(Debug, Clone, Default, Serialize, Deserialize)]
    struct AggregateB;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct EventA;

    impl DomainEvent for EventA {
        fn event_type(&self) -> String {
            "EventA".to_string()
        }

        fn event_version(&self) -> String {
            "1.0".to_string()
        }
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct EventB;

    impl DomainEvent for EventB {
        fn event_type(&self) -> String {
            "EventB".to_string()
        }

        fn event_version(&self) -> String {
            "1.0".to_string()
        }
    }

    impl Aggregate for Lifecycle<AggregateA, Never> {
        const TYPE: &'static str = "AggregateA";
        type Command = ();
        type Event = EventA;
        type Error = Never;
        type Services = ();

        async fn handle(
            &mut self,
            _cmd: Self::Command,
            _svc: &Self::Services,
            _sink: &EventSink<Self>,
        ) -> Result<(), Self::Error> {
            Ok(())
        }

        fn apply(&mut self, _event: Self::Event) {}
    }

    impl Aggregate for Lifecycle<AggregateB, Never> {
        const TYPE: &'static str = "AggregateB";
        type Command = ();
        type Event = EventB;
        type Error = Never;
        type Services = ();

        async fn handle(
            &mut self,
            _cmd: Self::Command,
            _svc: &Self::Services,
            _sink: &EventSink<Self>,
        ) -> Result<(), Self::Error> {
            Ok(())
        }

        fn apply(&mut self, _event: Self::Event) {}
    }

    struct MultiAggregateQuery {
        name: &'static str,
    }

    #[async_trait]
    impl Query<Lifecycle<AggregateA, Never>> for Arc<MultiAggregateQuery> {
        async fn dispatch(&self, _: &str, _: &[EventEnvelope<Lifecycle<AggregateA, Never>>]) {}
    }

    #[async_trait]
    impl Query<Lifecycle<AggregateB, Never>> for Arc<MultiAggregateQuery> {
        async fn dispatch(&self, _: &str, _: &[EventEnvelope<Lifecycle<AggregateB, Never>>]) {}
    }

    struct SingleAggregateQuery;

    #[async_trait]
    impl Query<Lifecycle<AggregateA, Never>> for Arc<SingleAggregateQuery> {
        async fn dispatch(&self, _: &str, _: &[EventEnvelope<Lifecycle<AggregateA, Never>>]) {}
    }

    type AggA = Lifecycle<AggregateA, Never>;
    type AggB = Lifecycle<AggregateB, Never>;

    #[test]
    fn single_aggregate_query_wiring() {
        // Query that only needs wiring to AggregateA
        type Deps = Cons<AggA, Nil>;
        let query: UnwiredQuery<SingleAggregateQuery, Deps> =
            UnwiredQuery::new(SingleAggregateQuery);

        // Cannot call into_inner yet - would be compile error:
        // let _ = query.into_inner();

        // Simulate wiring (no actual pool needed for type-level test)
        let query: UnwiredQuery<SingleAggregateQuery, Nil> = UnwiredQuery {
            query: query.query,
            _deps: PhantomData,
        };

        // Now we can extract
        let _arc: Arc<SingleAggregateQuery> = query.into_inner();
    }

    #[test]
    fn multi_aggregate_query_wiring_sequence() {
        // Query requiring wiring to A and B
        type Deps = Cons<AggA, Cons<AggB, Nil>>;
        let query: UnwiredQuery<MultiAggregateQuery, Deps> =
            UnwiredQuery::new(MultiAggregateQuery { name: "test" });

        // After wiring to A, only B remains
        let query: UnwiredQuery<MultiAggregateQuery, Cons<AggB, Nil>> = UnwiredQuery {
            query: query.query,
            _deps: PhantomData,
        };

        // After wiring to B, Nil
        let query: UnwiredQuery<MultiAggregateQuery, Nil> = UnwiredQuery {
            query: query.query,
            _deps: PhantomData,
        };

        let arc = query.into_inner();
        assert_eq!(arc.name, "test");
    }

    #[tokio::test]
    async fn full_wiring_flow_with_builders() {
        // Create queries with their full dependencies
        type MultiDeps = Cons<AggA, Cons<AggB, Nil>>;
        type SingleDeps = Cons<AggA, Nil>;

        let multi: UnwiredQuery<MultiAggregateQuery, MultiDeps> =
            UnwiredQuery::new(MultiAggregateQuery { name: "multi" });
        let single: UnwiredQuery<SingleAggregateQuery, SingleDeps> =
            UnwiredQuery::new(SingleAggregateQuery);

        // Build AggregateA CQRS - multi needs further wiring, single doesn't
        // Use build to get multi back for continued wiring
        let (cqrs_a, (single, (multi, ()))) = CqrsBuilder::<AggA>::new(test_pool())
            .wire(multi)
            .wire(single)
            .build(());

        // single is now Nil (only needed AggA)
        let _single_arc: Arc<SingleAggregateQuery> = single.into_inner();

        // Build AggregateB CQRS - multi's last dependency
        let (_cqrs_b, (multi, ())) = CqrsBuilder::<AggB>::new(test_pool()).wire(multi).build(());

        // multi is now Nil, can extract
        let _multi_arc: Arc<MultiAggregateQuery> = multi.into_inner();

        // Both CQRS frameworks are ready
        drop(cqrs_a);
    }
}
