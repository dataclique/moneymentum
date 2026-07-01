use std::sync::atomic::{AtomicU32, Ordering};

use chrono::Utc;
use event_sorcery::{EventSourced, Projection, ProjectionError, SendError, Store};
use futures::stream::{self, StreamExt};
use serde::Deserialize;
use sqlx::{AssertSqlSafe, SqlitePool};
use thiserror::Error;
use tracing::{debug, error, warn};

use super::run::{IngestionRun, IngestionRunCommand, IngestionRunStatus, running_runs};
use super::run_id::{INGESTION_RUN_ID_PREFIX, IngestionRunId};

pub(crate) const ABANDONED_RUN_REASON: &str = "backend restarted before ingestion completed";
pub(super) const LOST_RACE_REASON: &str = "lost the one-running race to a concurrent ingestion";

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

/// Opens a new ingestion run and enqueues its job atomically with the
/// `Started` event through the aggregate's `Jobs` handle, refusing if one is
/// already active.
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
    let event_sorcery::Table(table) = IngestionRun::PROJECTION;
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use tracing::Level;
    use tracing_test::traced_test;

    use super::{
        IngestionError, create_run, latest_status, recover_abandoned_runs,
        trigger_scheduled_ingestion,
    };
    use crate::ingestion::fixtures::{ingestion_store, instant};
    use crate::ingestion::run::{IngestionRunCommand, IngestionRunStatus, running_runs};
    use crate::logs_contain_at;

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

    #[tokio::test]
    async fn latest_status_prefers_the_latest_run_id_when_microseconds_match() {
        let (store, _projection, pool) = ingestion_store().await;
        let shared_start = instant();
        let shared_micros = shared_start.timestamp_micros();
        let first_id = format!("ingestion-{shared_micros}-00000000000000000000000000000001")
            .parse()
            .unwrap();
        let second_id = format!("ingestion-{shared_micros}-00000000000000000000000000000002")
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

    #[traced_test]
    #[tokio::test]
    async fn scheduled_ingestion_skips_when_a_run_is_already_active() {
        let (store, projection, _pool) = ingestion_store().await;
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
    async fn scheduled_ingestion_warns_and_counts_consecutive_failures() {
        let (store, projection, pool) = ingestion_store().await;
        pool.close().await;
        let consecutive_failures = AtomicU32::new(0);

        trigger_scheduled_ingestion(&store, &projection, &consecutive_failures).await;
        trigger_scheduled_ingestion(&store, &projection, &consecutive_failures).await;

        assert_eq!(consecutive_failures.load(Ordering::Relaxed), 2);
        assert!(logs_contain_at(
            Level::WARN,
            &["scheduled ingestion run failed", "consecutive=2"]
        ));
    }
}
