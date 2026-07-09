//! Ingestion orchestration and the event-sourced [`IngestionRun`] lifecycle.
//!
//! Each ingestion attempt is its own [`IngestionRun`] stream -- a monotone
//! `Running -> {Completed, Failed, Abandoned}` state machine -- so crashed and
//! abandoned runs stay visible without a database reset. The "one running"
//! invariant is the /ingest handler checking the projection plus a partial
//! unique index; an unconditional startup reconciler abandons every still-running
//! stream before /ingest is served, so a crash can never wedge the slot.

use std::fmt::{self, Display};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use chrono::{DateTime, Utc};
use event_sorcery::{
    Column, DomainEvent, EventSourced, Job, JobQueue, Label, Projection, ProjectionError,
    SendError, Store, Table,
};
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, SqlitePool};
use thiserror::Error;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::hyperliquid::{CandleIngester, FundingRateIngester, Hyperliquid};
use crate::market_catalog::MarketCatalog;
use crate::market_enablement::MarketEnablement;
use crate::market_metadata::RefreshError;
use crate::timeframe::Timeframe;

const TIMEFRAMES: &[Timeframe] = &[
    Timeframe::FifteenMin,
    Timeframe::OneHour,
    Timeframe::OneDay,
    Timeframe::OneWeek,
];
const ABANDONED_RUN_REASON: &str = "backend restarted before ingestion completed";
const LOST_RACE_REASON: &str = "lost the one-running race to a concurrent ingestion";

/// Identity of a single ingestion attempt, permanent for the life of its event
/// stream. It is the two values that determine it -- the microsecond the run
/// started (so ids sort by start time) and a random nonce (so two runs started
/// in the same microsecond cannot collide onto one stream, which would surface a
/// legitimate concurrent `/ingest` as a spurious 500 rather than a 409). The
/// wire form `ingestion-{micros}-{nonce}` is *derived* from those fields by
/// [`Display`] and parsed back by [`FromStr`]; the fields, not the string, are
/// the source of truth. The start time is held at microsecond precision -- the
/// resolution the wire form preserves -- so an id always equals the value parsed
/// back from its own [`Display`] output.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct IngestionRunId {
    started_at_micros: i64,
    nonce: Uuid,
}

const INGESTION_RUN_ID_PREFIX: &str = "ingestion-";

impl IngestionRunId {
    fn new(started_at: DateTime<Utc>) -> Self {
        Self {
            started_at_micros: started_at.timestamp_micros(),
            nonce: Uuid::new_v4(),
        }
    }
}

impl Display for IngestionRunId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{INGESTION_RUN_ID_PREFIX}{}-{}",
            self.started_at_micros,
            self.nonce.simple()
        )
    }
}

impl FromStr for IngestionRunId {
    type Err = IngestionRunIdParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let body = value
            .strip_prefix(INGESTION_RUN_ID_PREFIX)
            .ok_or(IngestionRunIdParseError::MissingPrefix)?;
        let (micros, nonce) = body
            .split_once('-')
            .ok_or(IngestionRunIdParseError::MissingNonce)?;
        let started_at_micros = micros
            .parse::<i64>()
            .map_err(IngestionRunIdParseError::Timestamp)?;
        let nonce = Uuid::parse_str(nonce).map_err(IngestionRunIdParseError::Nonce)?;
        Ok(Self {
            started_at_micros,
            nonce,
        })
    }
}

/// Why a string is not a valid [`IngestionRunId`].
#[derive(Debug, thiserror::Error)]
pub(crate) enum IngestionRunIdParseError {
    #[error("ingestion run id must start with `{INGESTION_RUN_ID_PREFIX}`")]
    MissingPrefix,
    #[error("ingestion run id is missing its nonce segment")]
    MissingNonce,
    #[error("ingestion run id has a non-numeric start timestamp")]
    Timestamp(#[source] std::num::ParseIntError),
    #[error("ingestion run id has a malformed nonce")]
    Nonce(#[source] uuid::Error),
}

impl Serialize for IngestionRunId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for IngestionRunId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        raw.parse().map_err(serde::de::Error::custom)
    }
}

/// The lifecycle state of an ingestion run. `Running` is the only non-terminal
/// state; every other state is final.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "TEXT")]
pub(crate) enum IngestionRunStatus {
    Running,
    Completed,
    Failed,
    Abandoned,
}

/// An event-sourced ingestion attempt. The stream is an audit record of one
/// run's lifecycle; `Running -> {Completed, Failed, Abandoned}` is a monotone,
/// single-step terminal state machine, so a late or duplicated command can never
/// revive a finished run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct IngestionRun {
    status: IngestionRunStatus,
    started_at: DateTime<Utc>,
}

/// The immutable facts of an ingestion run's lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum IngestionRunEvent {
    Started {
        started_at: DateTime<Utc>,
    },
    Completed {
        last_record_at: DateTime<Utc>,
        completed_at: DateTime<Utc>,
    },
    Failed {
        reason: String,
        failed_at: DateTime<Utc>,
    },
    Abandoned {
        reason: String,
        reconciled_at: DateTime<Utc>,
    },
}

impl DomainEvent for IngestionRunEvent {
    fn event_type(&self) -> String {
        match self {
            Self::Started { .. } => "IngestionRunEvent::Started",
            Self::Completed { .. } => "IngestionRunEvent::Completed",
            Self::Failed { .. } => "IngestionRunEvent::Failed",
            Self::Abandoned { .. } => "IngestionRunEvent::Abandoned",
        }
        .to_string()
    }

    fn event_version(&self) -> String {
        "1.0".to_string()
    }
}

/// Intent expressed against an ingestion run.
#[derive(Debug, Clone)]
pub(crate) enum IngestionRunCommand {
    Start {
        run_id: IngestionRunId,
        started_at: DateTime<Utc>,
    },
    Complete {
        last_record_at: DateTime<Utc>,
        completed_at: DateTime<Utc>,
    },
    Fail {
        reason: String,
        failed_at: DateTime<Utc>,
    },
    Abandon {
        reason: String,
        reconciled_at: DateTime<Utc>,
    },
}

/// Why the run state machine refuses a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
pub(crate) enum IngestionRunError {
    #[error("ingestion run already started")]
    AlreadyStarted,
    #[error("ingestion run has not started")]
    NotStarted,
    #[error("ingestion run has already finished")]
    AlreadyTerminal,
}

impl EventSourced for IngestionRun {
    type Id = IngestionRunId;
    type Event = IngestionRunEvent;
    type Command = IngestionRunCommand;
    type Error = IngestionRunError;
    type Jobs = event_sorcery::jobs![IngestionJob];
    type Materialized = Table;

    const AGGREGATE_TYPE: &'static str = "IngestionRun";
    const PROJECTION: Table = Table("ingestion_run_view");
    const SCHEMA_VERSION: u64 = 1;

    fn originate(event: &IngestionRunEvent) -> Option<Self> {
        match event {
            IngestionRunEvent::Started { started_at } => Some(Self {
                status: IngestionRunStatus::Running,
                started_at: *started_at,
            }),
            IngestionRunEvent::Completed { .. }
            | IngestionRunEvent::Failed { .. }
            | IngestionRunEvent::Abandoned { .. } => None,
        }
    }

    fn evolve(entity: &Self, event: &IngestionRunEvent) -> Result<Option<Self>, IngestionRunError> {
        if entity.status != IngestionRunStatus::Running {
            return Err(IngestionRunError::AlreadyTerminal);
        }

        let terminal = |status| {
            Ok(Some(Self {
                status,
                ..entity.clone()
            }))
        };

        match event {
            IngestionRunEvent::Started { .. } => Ok(None),
            IngestionRunEvent::Completed { .. } => terminal(IngestionRunStatus::Completed),
            IngestionRunEvent::Failed { .. } => terminal(IngestionRunStatus::Failed),
            IngestionRunEvent::Abandoned { .. } => terminal(IngestionRunStatus::Abandoned),
        }
    }

    fn initialize(
        command: IngestionRunCommand,
        jobs: &mut JobQueue<Self::Jobs>,
    ) -> Result<Vec<IngestionRunEvent>, IngestionRunError> {
        match command {
            IngestionRunCommand::Start { run_id, started_at } => {
                // Enqueue the ingestion job on the same handle the framework
                // flushes inside the event-commit transaction, so the job is
                // queued iff the `Started` event commits -- there is no window
                // where a run is Running with no job behind it (issue #404).
                jobs.push(IngestionJob::new(run_id));
                Ok(vec![IngestionRunEvent::Started { started_at }])
            }
            IngestionRunCommand::Complete { .. }
            | IngestionRunCommand::Fail { .. }
            | IngestionRunCommand::Abandon { .. } => Err(IngestionRunError::NotStarted),
        }
    }

    fn transition(
        &self,
        command: IngestionRunCommand,
        _jobs: &mut JobQueue<Self::Jobs>,
    ) -> Result<Vec<IngestionRunEvent>, IngestionRunError> {
        match command {
            IngestionRunCommand::Start { .. } => Err(IngestionRunError::AlreadyStarted),
            IngestionRunCommand::Complete { .. }
            | IngestionRunCommand::Fail { .. }
            | IngestionRunCommand::Abandon { .. }
                if self.status != IngestionRunStatus::Running =>
            {
                Err(IngestionRunError::AlreadyTerminal)
            }
            IngestionRunCommand::Complete {
                last_record_at,
                completed_at,
            } => Ok(vec![IngestionRunEvent::Completed {
                last_record_at,
                completed_at,
            }]),
            IngestionRunCommand::Fail { reason, failed_at } => {
                Ok(vec![IngestionRunEvent::Failed { reason, failed_at }])
            }
            IngestionRunCommand::Abandon {
                reason,
                reconciled_at,
            } => Ok(vec![IngestionRunEvent::Abandoned {
                reason,
                reconciled_at,
            }]),
        }
    }
}

/// The generated `status` column on `ingestion_run_view`, for status-filtered
/// reads (the "is anything running?" check and the recovery sweep).
pub(crate) const RUN_STATUS: Column = Column("status");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IngestionJob {
    run_id: IngestionRunId,
}

impl IngestionJob {
    pub(crate) fn new(run_id: IngestionRunId) -> Self {
        Self { run_id }
    }
}

/// Everything the ingestion worker needs to drive a run to a terminal state:
/// the run's own event store (to load state and record completion or failure)
/// and the fetch/catalog services that do the ingestion work. Built once at
/// startup and shared as the worker's [`Job::Input`].
pub(crate) struct IngestionJobContext {
    pub(crate) run_store: Arc<Store<IngestionRun>>,
    pub(crate) run_projection: Arc<Projection<IngestionRun>>,
    pub(crate) services: IngestionServices,
}

impl Job for IngestionJob {
    type Input = IngestionJobContext;
    type Output = ();
    type Error = SendError<IngestionRun>;

    const WORKER_NAME: &'static str = "ingestion";
    const KIND: &'static str = "ingestion";

    fn label(&self) -> Label {
        Label::new(format!("ingestion:{}", self.run_id))
    }

    async fn perform(&self, context: &IngestionJobContext) -> Result<(), SendError<IngestionRun>> {
        let store = &context.run_store;
        let services = &context.services;

        // A run abandoned by startup recovery must not resurrect: skip the work
        // and leave its terminal state untouched.
        match store.load(&self.run_id).await {
            Ok(Some(run)) if run.status == IngestionRunStatus::Running => {}
            Ok(_) => {
                warn!(run_id = %self.run_id, "skipping ingestion for a finished run");
                return Ok(());
            }
            // A load failure leaves the run's state unknown -- surface it so the
            // worker retries rather than silently marking the job done.
            Err(err) => {
                error!(error = %err, run_id = %self.run_id, "failed to load ingestion run");
                return Err(err);
            }
        }

        // Both concurrent `create_run` losers and winners enqueue a job atomically
        // with `Start`. The aggregate can still read Running for a loser until its
        // `Abandon` commits, so verify this run_id is the projection's sole winner
        // before any ingestion I/O.
        let holds_slot = match holds_one_running_slot(&context.run_projection, &self.run_id).await {
            Ok(holds_slot) => holds_slot,
            Err(err) => {
                error!(
                    error = %err,
                    run_id = %self.run_id,
                    "failed to verify the one-running slot"
                );
                return retry_ingestion_job(store, &self.run_id).await;
            }
        };
        if !holds_slot {
            match store.load(&self.run_id).await {
                Ok(Some(run)) if run.status == IngestionRunStatus::Running => {
                    store
                        .send(
                            &self.run_id,
                            IngestionRunCommand::Abandon {
                                reason: LOST_RACE_REASON.to_string(),
                                reconciled_at: Utc::now(),
                            },
                        )
                        .await?;
                }
                Ok(_) => {}
                Err(err) => {
                    error!(
                        error = %err,
                        run_id = %self.run_id,
                        "failed to load ingestion run before abandoning race loser"
                    );
                    return Err(err);
                }
            }
            warn!(
                run_id = %self.run_id,
                "skipping ingestion for a run that lost the one-running race"
            );
            return Ok(());
        }

        let candle_ingester = CandleIngester::new(
            Arc::clone(&services.hyperliquid),
            services.max_concurrent_requests,
        );
        let funding_ingester = FundingRateIngester::new(
            Arc::clone(&services.hyperliquid),
            services.max_concurrent_requests,
        );

        match ingest_all(
            services.hyperliquid.as_ref(),
            &candle_ingester,
            &funding_ingester,
            &services.data_dir,
            &services.market_catalog,
            &services.market_catalog_projection,
            &services.market_enablement_projection,
        )
        .await
        {
            Ok(last_record) => {
                // The run stays Running until this commits; surface a
                // terminalization failure so the worker retries instead of
                // leaving the slot wedged until the next startup reconcile.
                if let Err(err) = complete_run(store, &self.run_id, last_record).await {
                    error!(error = %err, run_id = %self.run_id, "failed to record ingestion completion");
                    return Err(err);
                }
                info!(run_id = %self.run_id, "ingestion complete");
            }
            Err(err) => {
                error!(error = %err, run_id = %self.run_id, "ingestion failed");
                // If we cannot even record the failure the run stays Running;
                // surface it so the worker retries rather than wedging the slot.
                if let Err(record_err) = fail_run(store, &self.run_id, &err.to_string()).await {
                    error!(
                        error = %record_err,
                        run_id = %self.run_id,
                        "failed to record ingestion failure"
                    );
                    return Err(record_err);
                }
            }
        }

        Ok(())
    }
}

async fn ingest_all(
    client: &dyn Hyperliquid,
    candle_ingester: &CandleIngester<dyn Hyperliquid>,
    funding_ingester: &FundingRateIngester<dyn Hyperliquid>,
    data_dir: &Path,
    market_catalog: &Store<MarketCatalog>,
    market_catalog_projection: &Projection<MarketCatalog>,
    market_enablement_projection: &Projection<MarketEnablement>,
) -> Result<DateTime<Utc>, RefreshError> {
    let markets = crate::market_metadata::refresh_markets(
        client,
        market_catalog,
        market_catalog_projection,
        market_enablement_projection,
    )
    .await?;

    funding_ingester
        .ingest_with_markets(data_dir, &markets)
        .await?;

    for timeframe in TIMEFRAMES {
        candle_ingester
            .ingest_with_markets(*timeframe, data_dir, &markets)
            .await?;
    }

    Ok(Utc::now())
}

/// Why opening or recovering an ingestion run fails.
#[derive(Debug, Error)]
pub(crate) enum IngestionError {
    #[error("ingestion already running")]
    AlreadyRunning,
    #[error(transparent)]
    Send(#[from] SendError<IngestionRun>),
    #[error(transparent)]
    Projection(#[from] ProjectionError<IngestionRun>),
}

pub(crate) struct IngestionServices {
    pub(crate) hyperliquid: Arc<dyn Hyperliquid>,
    pub(crate) data_dir: PathBuf,
    pub(crate) max_concurrent_requests: usize,
    pub(crate) market_catalog: Arc<Store<MarketCatalog>>,
    pub(crate) market_catalog_projection: Arc<Projection<MarketCatalog>>,
    pub(crate) market_enablement_projection: Arc<Projection<MarketEnablement>>,
}

/// Opens a new ingestion run, refusing if one is already active.
///
/// The active check reads the projection, so it is not atomic with the `Start`
/// event (event-sorcery commits projections just after the event, not in the
/// same transaction). For operator-triggered, sequential ingest this is
/// sufficient: the partial unique index on `ingestion_run_view` is a backstop,
/// and the startup reconciler guarantees a crashed run never wedges the slot.
pub(crate) async fn create_run(
    store: &Store<IngestionRun>,
    projection: &Projection<IngestionRun>,
) -> Result<IngestionRunId, IngestionError> {
    if !running_runs(projection).await?.is_empty() {
        return Err(IngestionError::AlreadyRunning);
    }

    let started_at = Utc::now();
    let run_id = IngestionRunId::new(started_at);
    store
        .send(
            &run_id,
            IngestionRunCommand::Start {
                run_id: run_id.clone(),
                started_at,
            },
        )
        .await?;

    // The pre-send projection read is not atomic with the Start, so two callers
    // can both pass it and both persist a Start. event-sorcery commits the
    // projection within `send`, and the partial unique index on
    // `ingestion_run_view(status) WHERE status = 'Running'` admits at most one
    // Start as Running -- the losers' projection writes hit the constraint and
    // are dropped by the reactor. So after `send`, exactly one run holds the
    // Running slot. If it is not this one, we lost the race: abandon the orphan
    // stream and report AlreadyRunning, so only the winner proceeds.
    let running = running_runs(projection).await?;
    let won = if let [(winner, _)] = running.as_slice() {
        *winner == run_id
    } else {
        false
    };
    if !won {
        store
            .send(
                &run_id,
                IngestionRunCommand::Abandon {
                    reason: LOST_RACE_REASON.to_string(),
                    reconciled_at: Utc::now(),
                },
            )
            .await?;
        debug!(run_id = %run_id, "lost the one-running race; abandoned the orphan run");
        return Err(IngestionError::AlreadyRunning);
    }

    debug!(run_id = %run_id, "ingestion run created");
    Ok(run_id)
}

/// Abandons every still-running stream. Run unconditionally at startup, before
/// `/ingest` is served, so a crash mid-run cannot leave the one-running slot
/// permanently claimed (the regression that issue #339 fixed).
pub(crate) async fn recover_abandoned_runs(
    store: &Store<IngestionRun>,
    projection: &Projection<IngestionRun>,
) -> Result<u64, IngestionError> {
    let running = running_runs(projection).await?;
    let reconciled_at = Utc::now();

    // Abandon each run independently: one failed write must not block recovery
    // of the rest, since this completes before /ingest is served.
    let (recovered, first_error) = stream::iter(running.iter())
        .fold(
            (0u64, None::<SendError<IngestionRun>>),
            |(recovered, first_error), (run_id, _)| {
                let run_id = run_id.clone();
                async move {
                    match store
                        .send(
                            &run_id,
                            IngestionRunCommand::Abandon {
                                reason: ABANDONED_RUN_REASON.to_string(),
                                reconciled_at,
                            },
                        )
                        .await
                    {
                        Ok(()) => (recovered + 1, first_error),
                        Err(err) => {
                            error!(
                                error = %err,
                                run_id = %run_id,
                                "failed to abandon a running ingestion run"
                            );
                            (recovered, first_error.or(Some(err)))
                        }
                    }
                }
            },
        )
        .await;

    if let Some(err) = first_error {
        return Err(IngestionError::Send(err));
    }

    if recovered > 0 {
        warn!(runs = recovered, "abandoned ingestion runs on startup");
    } else {
        debug!("no running ingestion runs to recover on startup");
    }

    Ok(recovered)
}

/// Materialized-view payload shape for a live [`IngestionRun`].
#[derive(Deserialize)]
struct LiveIngestionRunView {
    #[serde(rename = "Live")]
    live: IngestionRun,
}

/// The status of the most recently started run, or `None` if none exist.
///
/// Reads a single view row ordered by [`IngestionRunId`] (microsecond start,
/// then nonce), matching the old `ORDER BY started_at DESC LIMIT 1` ledger
/// query without loading every run into memory.
pub(crate) async fn latest_status(
    pool: &SqlitePool,
) -> Result<Option<IngestionRunStatus>, IngestionError> {
    let Table(table) = IngestionRun::PROJECTION;
    let micros_substr_start = INGESTION_RUN_ID_PREFIX.len() + 1;
    let query = format!(
        "SELECT view_id, payload FROM {table}
         ORDER BY
           CAST(substr(view_id, {micros_substr_start},
             instr(substr(view_id, {micros_substr_start}), '-') - 1) AS INTEGER) DESC,
           view_id DESC
         LIMIT 1"
    );

    let row: Option<(String, String)> = sqlx::query_as(AssertSqlSafe(query))
        .fetch_optional(pool)
        .await
        .map_err(|err| IngestionError::Projection(ProjectionError::from(err)))?;

    let Some((view_id, payload)) = row else {
        return Ok(None);
    };

    let view: LiveIngestionRunView = serde_json::from_str(&payload).map_err(|source| {
        IngestionError::Projection(ProjectionError::Serde {
            aggregate_id: view_id.clone(),
            source,
        })
    })?;

    Ok(Some(view.live.status))
}

async fn running_runs(
    projection: &Projection<IngestionRun>,
) -> Result<Vec<(IngestionRunId, IngestionRun)>, ProjectionError<IngestionRun>> {
    projection
        .filter(RUN_STATUS, &IngestionRunStatus::Running)
        .await
}

async fn holds_one_running_slot(
    projection: &Projection<IngestionRun>,
    run_id: &IngestionRunId,
) -> Result<bool, ProjectionError<IngestionRun>> {
    Ok(matches!(
        running_runs(projection).await?.as_slice(),
        [(winner, _)] if winner == run_id
    ))
}

async fn retry_ingestion_job(
    store: &Store<IngestionRun>,
    run_id: &IngestionRunId,
) -> Result<(), SendError<IngestionRun>> {
    let Some(run) = store.load(run_id).await? else {
        return Ok(());
    };
    if run.status != IngestionRunStatus::Running {
        return Ok(());
    }
    store
        .send(
            run_id,
            IngestionRunCommand::Start {
                run_id: run_id.clone(),
                started_at: run.started_at,
            },
        )
        .await
}

async fn complete_run(
    store: &Store<IngestionRun>,
    run_id: &IngestionRunId,
    last_record_at: DateTime<Utc>,
) -> Result<(), SendError<IngestionRun>> {
    store
        .send(
            run_id,
            IngestionRunCommand::Complete {
                last_record_at,
                completed_at: Utc::now(),
            },
        )
        .await?;

    debug!(run_id = %run_id, "ingestion run completed");
    Ok(())
}

pub(crate) async fn fail_run(
    store: &Store<IngestionRun>,
    run_id: &IngestionRunId,
    reason: &str,
) -> Result<(), SendError<IngestionRun>> {
    store
        .send(
            run_id,
            IngestionRunCommand::Fail {
                reason: reason.to_string(),
                failed_at: Utc::now(),
            },
        )
        .await?;

    debug!(run_id = %run_id, "ingestion run failed");
    Ok(())
}

/// Runs one scheduled ingestion attempt. An already-running run is the normal
/// skip-this-tick case, not a failure; genuine failures increment a consecutive
/// counter and warn so an operator can spot a wedged scheduler.
pub(crate) async fn trigger_scheduled_ingestion(
    store: &Store<IngestionRun>,
    projection: &Projection<IngestionRun>,
    consecutive_failures: &AtomicU32,
) {
    match create_run(store, projection).await {
        Ok(run_id) => {
            consecutive_failures.store(0, Ordering::Relaxed);
            debug!(run_id = %run_id, "scheduled ingestion run enqueued");
        }
        Err(IngestionError::AlreadyRunning) => {
            consecutive_failures.store(0, Ordering::Relaxed);
            debug!("scheduled ingestion skipped; a run is already active");
        }
        Err(err) => {
            let consecutive = consecutive_failures.fetch_add(1, Ordering::Relaxed) + 1;
            warn!(error = %err, consecutive, "scheduled ingestion run failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use chrono::{DateTime, TimeZone, Utc};
    use rust_decimal_macros::dec;
    use sqlx::SqlitePool;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tracing::Level;
    use tracing_test::traced_test;

    use event_sorcery::{Job, LifecycleError, StoreBuilder, TestHarness, replay};

    use super::*;
    use crate::candle::Candle;
    use crate::finance::{Market, Symbol, hyperliquid_swap_ccxt_symbol};
    use crate::funding::FundingRate;
    use crate::hyperliquid::HyperliquidError;
    use crate::logs_contain_at;
    use crate::market_metadata::MarketMetadata;
    use crate::timeframe::Timeframe;

    struct MockHyperliquid {
        fetch_market_metadata_calls: Option<Arc<AtomicU32>>,
    }

    impl MockHyperliquid {
        fn without_call_counter() -> Self {
            Self {
                fetch_market_metadata_calls: None,
            }
        }

        fn with_call_counter(fetch_market_metadata_calls: Arc<AtomicU32>) -> Self {
            Self {
                fetch_market_metadata_calls: Some(fetch_market_metadata_calls),
            }
        }
    }

    #[async_trait]
    impl Hyperliquid for MockHyperliquid {
        async fn fetch_market_metadata(&self) -> Result<Vec<MarketMetadata>, HyperliquidError> {
            if let Some(fetch_market_metadata_calls) = &self.fetch_market_metadata_calls {
                fetch_market_metadata_calls.fetch_add(1, Ordering::SeqCst);
            }
            Ok(vec![MarketMetadata {
                symbol: Market::new("BTC".into()),
                max_leverage: 50,
                asset_index: 0,
            }])
        }

        async fn fetch_candles(
            &self,
            market: &Market,
            _timeframe: Timeframe,
            _start: DateTime<Utc>,
        ) -> Result<Vec<Candle>, HyperliquidError> {
            Ok(vec![Candle {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
                open: 100.0,
                high: 105.0,
                low: 95.0,
                close: 102.0,
                volume: 1000.0,
                symbol: hyperliquid_swap_ccxt_symbol(market.as_str()).into_string(),
                ticker: Symbol::from_raw(market.as_str()),
            }])
        }

        async fn fetch_funding_rates(
            &self,
            market: &Market,
            _start: DateTime<Utc>,
        ) -> Result<Vec<FundingRate>, HyperliquidError> {
            Ok(vec![FundingRate {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
                rate: dec!(0.0001),
                symbol: Symbol::from_raw(market.as_str()),
            }])
        }
    }

    async fn test_services() -> IngestionServices {
        test_services_with_hyperliquid(Arc::new(MockHyperliquid::without_call_counter())).await
    }

    async fn test_services_with_hyperliquid(
        hyperliquid: Arc<dyn Hyperliquid>,
    ) -> IngestionServices {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let (market_catalog, market_catalog_projection) =
            StoreBuilder::<MarketCatalog>::new(pool.clone())
                .build()
                .await
                .unwrap();
        let (_enablement, market_enablement_projection) =
            StoreBuilder::<MarketEnablement>::new(pool)
                .build()
                .await
                .unwrap();

        IngestionServices {
            hyperliquid,
            data_dir: std::env::temp_dir(),
            max_concurrent_requests: 10,
            market_catalog,
            market_catalog_projection,
            market_enablement_projection,
        }
    }

    fn job_context(
        store: &Arc<Store<IngestionRun>>,
        projection: &Arc<Projection<IngestionRun>>,
        services: IngestionServices,
    ) -> IngestionJobContext {
        IngestionJobContext {
            run_store: Arc::clone(store),
            run_projection: Arc::clone(projection),
            services,
        }
    }

    async fn ingestion_store() -> (
        Arc<Store<IngestionRun>>,
        Arc<Projection<IngestionRun>>,
        SqlitePool,
    ) {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let (store, projection) = StoreBuilder::<IngestionRun>::new(pool.clone())
            .build()
            .await
            .unwrap();
        (store, projection, pool)
    }

    fn instant() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap()
    }

    #[test]
    fn replay_reconstructs_a_running_run() {
        let run = replay::<IngestionRun>(vec![IngestionRunEvent::Started {
            started_at: instant(),
        }])
        .unwrap()
        .unwrap();

        assert_eq!(run.status, IngestionRunStatus::Running);
    }

    #[test]
    fn replay_rejects_history_starting_with_a_terminal_event() {
        // A terminal event with no preceding Started cannot originate the
        // stream; replay rejects the invalid history loudly rather than
        // fabricating a phantom run.
        let result = replay::<IngestionRun>(vec![IngestionRunEvent::Completed {
            last_record_at: instant(),
            completed_at: instant(),
        }]);

        assert!(
            result.is_err(),
            "a history starting with a terminal event must not originate a run"
        );
    }

    #[tokio::test]
    async fn completing_a_running_run_emits_completed() {
        TestHarness::<IngestionRun>::with()
            .given(vec![IngestionRunEvent::Started {
                started_at: instant(),
            }])
            .when(IngestionRunCommand::Complete {
                last_record_at: instant(),
                completed_at: instant(),
            })
            .await
            .then_expect_events(&[IngestionRunEvent::Completed {
                last_record_at: instant(),
                completed_at: instant(),
            }]);
    }

    #[tokio::test]
    async fn finalizing_a_finished_run_is_refused() {
        let error = TestHarness::<IngestionRun>::with()
            .given(vec![
                IngestionRunEvent::Started {
                    started_at: instant(),
                },
                IngestionRunEvent::Completed {
                    last_record_at: instant(),
                    completed_at: instant(),
                },
            ])
            .when(IngestionRunCommand::Fail {
                reason: "boom".to_string(),
                failed_at: instant(),
            })
            .await
            .then_expect_error();

        assert!(matches!(
            error,
            LifecycleError::Apply(IngestionRunError::AlreadyTerminal)
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn create_run_starts_a_running_run_and_logs() {
        let (store, projection, pool) = ingestion_store().await;

        let run_id = create_run(&store, &projection).await.unwrap();
        let status = latest_status(&pool).await.unwrap();

        assert_eq!(status, Some(IngestionRunStatus::Running));
        let run_id = run_id.to_string();
        assert!(run_id.starts_with("ingestion-"));
        assert!(logs_contain_at(
            Level::DEBUG,
            &["ingestion run created", run_id.as_str()]
        ));
    }

    #[test]
    fn ingestion_run_id_round_trips_through_its_string_form() {
        let started_at = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        let run_id = IngestionRunId::new(started_at);

        let rendered = run_id.to_string();
        let parsed: IngestionRunId = rendered.parse().unwrap();

        assert!(rendered.starts_with("ingestion-"));
        assert_eq!(parsed, run_id);
    }

    #[test]
    fn ingestion_run_id_rejects_malformed_strings() {
        assert!("missing-prefix".parse::<IngestionRunId>().is_err());
        assert!("ingestion-123".parse::<IngestionRunId>().is_err());
        assert!(
            "ingestion-notanumber-7a8b"
                .parse::<IngestionRunId>()
                .is_err()
        );
        assert!(
            "ingestion-123-not-a-uuid"
                .parse::<IngestionRunId>()
                .is_err()
        );
    }

    #[tokio::test]
    async fn latest_status_prefers_the_latest_run_id_when_microseconds_match() {
        let (store, _projection, pool) = ingestion_store().await;
        let shared_start = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        let shared_micros = shared_start.timestamp_micros();
        let first_id: IngestionRunId =
            format!("ingestion-{shared_micros}-00000000000000000000000000000001")
                .parse()
                .unwrap();
        let second_id: IngestionRunId =
            format!("ingestion-{shared_micros}-00000000000000000000000000000002")
                .parse()
                .unwrap();

        store
            .send(
                &first_id,
                IngestionRunCommand::Start {
                    run_id: first_id.clone(),
                    started_at: shared_start,
                },
            )
            .await
            .unwrap();
        store
            .send(
                &first_id,
                IngestionRunCommand::Complete {
                    last_record_at: shared_start,
                    completed_at: shared_start,
                },
            )
            .await
            .unwrap();
        store
            .send(
                &second_id,
                IngestionRunCommand::Start {
                    run_id: second_id.clone(),
                    started_at: shared_start,
                },
            )
            .await
            .unwrap();

        let status = latest_status(&pool).await.unwrap();

        assert_eq!(status, Some(IngestionRunStatus::Running));
    }

    #[traced_test]
    #[tokio::test]
    async fn create_run_rejects_a_second_sequential_run() {
        // The sequential case: the projection already reflects the first run, so
        // the pre-send guard rejects. The concurrent race is covered by
        // `concurrent_create_run_admits_exactly_one`.
        let (store, projection, _pool) = ingestion_store().await;

        create_run(&store, &projection).await.unwrap();
        let duplicate = create_run(&store, &projection).await;

        assert!(matches!(duplicate, Err(IngestionError::AlreadyRunning)));
    }

    #[traced_test]
    #[tokio::test]
    async fn recover_abandons_running_runs_and_logs() {
        let (store, projection, pool) = ingestion_store().await;

        create_run(&store, &projection).await.unwrap();
        let recovered = recover_abandoned_runs(&store, &projection).await.unwrap();
        let status = latest_status(&pool).await.unwrap();

        assert_eq!(recovered, 1);
        assert_eq!(status, Some(IngestionRunStatus::Abandoned));
        assert!(logs_contain_at(
            Level::WARN,
            &["abandoned ingestion runs on startup", "1"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn stale_job_for_recovered_run_does_not_execute() {
        let (store, projection, pool) = ingestion_store().await;
        let run_id = create_run(&store, &projection).await.unwrap();
        recover_abandoned_runs(&store, &projection).await.unwrap();
        let job = IngestionJob::new(run_id.clone());
        let context = job_context(&store, &projection, test_services().await);

        job.perform(&context).await.unwrap();

        let status = latest_status(&pool).await.unwrap();

        assert_eq!(status, Some(IngestionRunStatus::Abandoned));
        let run_id = run_id.to_string();
        assert!(logs_contain_at(
            Level::WARN,
            &["skipping ingestion for a finished run", run_id.as_str()]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn job_completes_a_running_run_and_logs() {
        let (store, projection, pool) = ingestion_store().await;
        let run_id = create_run(&store, &projection).await.unwrap();
        let job = IngestionJob::new(run_id.clone());
        let context = job_context(&store, &projection, test_services().await);

        job.perform(&context).await.unwrap();

        let status = latest_status(&pool).await.unwrap();

        assert_eq!(status, Some(IngestionRunStatus::Completed));
        let run_id = run_id.to_string();
        assert!(logs_contain_at(
            Level::INFO,
            &["ingestion complete", run_id.as_str()]
        ));
    }

    #[tokio::test]
    async fn failing_a_running_run_emits_failed() {
        TestHarness::<IngestionRun>::with()
            .given(vec![IngestionRunEvent::Started {
                started_at: instant(),
            }])
            .when(IngestionRunCommand::Fail {
                reason: "boom".to_string(),
                failed_at: instant(),
            })
            .await
            .then_expect_events(&[IngestionRunEvent::Failed {
                reason: "boom".to_string(),
                failed_at: instant(),
            }]);
    }

    #[tokio::test]
    async fn abandoning_a_running_run_emits_abandoned() {
        TestHarness::<IngestionRun>::with()
            .given(vec![IngestionRunEvent::Started {
                started_at: instant(),
            }])
            .when(IngestionRunCommand::Abandon {
                reason: ABANDONED_RUN_REASON.to_string(),
                reconciled_at: instant(),
            })
            .await
            .then_expect_events(&[IngestionRunEvent::Abandoned {
                reason: ABANDONED_RUN_REASON.to_string(),
                reconciled_at: instant(),
            }]);
    }

    #[test]
    fn replay_reconstructs_a_failed_run() {
        let run = replay::<IngestionRun>(vec![
            IngestionRunEvent::Started {
                started_at: instant(),
            },
            IngestionRunEvent::Failed {
                reason: "boom".to_string(),
                failed_at: instant(),
            },
        ])
        .unwrap()
        .unwrap();

        assert_eq!(run.status, IngestionRunStatus::Failed);
    }

    #[test]
    fn replay_reconstructs_an_abandoned_run() {
        let run = replay::<IngestionRun>(vec![
            IngestionRunEvent::Started {
                started_at: instant(),
            },
            IngestionRunEvent::Abandoned {
                reason: ABANDONED_RUN_REASON.to_string(),
                reconciled_at: instant(),
            },
        ])
        .unwrap()
        .unwrap();

        assert_eq!(run.status, IngestionRunStatus::Abandoned);
    }

    #[traced_test]
    #[tokio::test]
    async fn recover_with_no_running_runs_is_a_noop() {
        let (store, projection, _pool) = ingestion_store().await;

        let recovered = recover_abandoned_runs(&store, &projection).await.unwrap();

        assert_eq!(recovered, 0);
        assert!(logs_contain_at(
            Level::DEBUG,
            &["no running ingestion runs to recover on startup"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn concurrent_create_run_admits_exactly_one() {
        let (store, projection, _pool) = ingestion_store().await;

        // Two callers race create_run on the same store. The one-running
        // invariant must admit exactly one and reject the loser with
        // AlreadyRunning -- never leave two Running runs.
        let (first, second) = tokio::join!(
            create_run(&store, &projection),
            create_run(&store, &projection),
        );

        let winner_then_loser =
            first.is_ok() && matches!(second, Err(IngestionError::AlreadyRunning));
        let loser_then_winner =
            matches!(first, Err(IngestionError::AlreadyRunning)) && second.is_ok();

        assert!(
            winner_then_loser || loser_then_winner,
            "exactly one concurrent run must be admitted and the other rejected \
             with AlreadyRunning; got {first:?} and {second:?}"
        );

        let running = running_runs(&projection).await.unwrap();
        assert_eq!(
            running.len(),
            1,
            "exactly one run remains in the Running slot"
        );
    }

    #[tokio::test]
    async fn scheduled_ingestion_skips_when_a_run_is_already_active() {
        let (store, projection) = ingestion_store().await;
        let consecutive_failures = AtomicU32::new(3);

        create_run(&store, &projection).await.unwrap();
        trigger_scheduled_ingestion(&store, &projection, &consecutive_failures).await;

        assert_eq!(
            consecutive_failures.load(Ordering::Relaxed),
            0,
            "an active run is a normal skip, not a failure"
        );
        assert!(logs_contain_at(
            Level::DEBUG,
            &["scheduled ingestion skipped"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn race_loser_job_skips_ingestion_before_winner_runs() {
        let fetch_market_metadata_calls = Arc::new(AtomicU32::new(0));
        let (store, projection, _pool) = ingestion_store().await;
        let services = test_services_with_hyperliquid(Arc::new(
            MockHyperliquid::with_call_counter(Arc::clone(&fetch_market_metadata_calls)),
        ))
        .await;
        let context = job_context(&store, &projection, services);

        // Simulate the post-Start race window: both streams committed `Start`
        // (and enqueued jobs) but the partial unique index left only one winner
        // in the projection.
        let shared_start = instant();
        let shared_micros = shared_start.timestamp_micros();
        let first_id: IngestionRunId =
            format!("ingestion-{shared_micros}-00000000000000000000000000000001")
                .parse()
                .unwrap();
        let second_id: IngestionRunId =
            format!("ingestion-{shared_micros}-00000000000000000000000000000002")
                .parse()
                .unwrap();

        store
            .send(
                &first_id,
                IngestionRunCommand::Start {
                    run_id: first_id.clone(),
                    started_at: shared_start,
                },
            )
            .await
            .unwrap();
        store
            .send(
                &second_id,
                IngestionRunCommand::Start {
                    run_id: second_id.clone(),
                    started_at: shared_start,
                },
            )
            .await
            .unwrap();

        let running = running_runs(&projection).await.unwrap();
        assert_eq!(running.len(), 1, "projection must admit exactly one winner");
        let winner_id = running[0].0.clone();
        let loser_id = if winner_id == first_id {
            second_id
        } else {
            first_id
        };

        // Run the loser's job first -- the ordering that previously duplicated work.
        IngestionJob::new(loser_id.clone())
            .perform(&context)
            .await
            .unwrap();
        IngestionJob::new(winner_id.clone())
            .perform(&context)
            .await
            .unwrap();

        assert_eq!(
            fetch_market_metadata_calls.load(Ordering::SeqCst),
            1,
            "only the projection winner may execute ingestion"
        );

        let loser = store.load(&loser_id).await.unwrap().unwrap();
        let winner = store.load(&winner_id).await.unwrap().unwrap();
        assert_eq!(loser.status, IngestionRunStatus::Abandoned);
        assert_eq!(winner.status, IngestionRunStatus::Completed);

        let loser_id = loser_id.to_string();
        assert!(logs_contain_at(
            Level::WARN,
            &[
                "skipping ingestion for a run that lost the one-running race",
                loser_id.as_str()
            ]
        ));
        let winner_id = winner_id.to_string();
        assert!(logs_contain_at(
            Level::INFO,
            &["ingestion complete", winner_id.as_str()]
        ));
    }
}
