-- Reconcile the event store with event-sorcery's canonical schema.
--
-- The `events`, `snapshots`, and `ingestion_view` tables were created by
-- earlier migrations for a cqrs-es Ingestion aggregate that issue #339 removed,
-- so they are empty. event-sorcery now owns the event store:
--
--   * `events` already matches event-sorcery's canonical layout -- left as is.
--   * `snapshots` lacked the `snapshot_version` column event-sorcery's schema
--     reconciler reads; add it in place so existing snapshot rows survive upgrade.
--   * `ingestion_view` is dead: ingestion uses the `ingestion_runs` ledger, and
--     event-sorcery creates per-aggregate view tables itself, so the orphan is
--     dropped to avoid confusion with future projection tables.

DROP TABLE IF EXISTS ingestion_view;

ALTER TABLE snapshots ADD COLUMN snapshot_version BIGINT NOT NULL DEFAULT 0;
