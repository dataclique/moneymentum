-- One Running row per schedule key (1h, 15m, funding, ...) instead of one
-- globally, so coincident cron ticks for different work units can each enqueue.

DROP INDEX IF EXISTS one_running_ingestion_run;

ALTER TABLE ingestion_run_view ADD COLUMN schedule_key TEXT GENERATED ALWAYS AS (
    json_extract(payload, '$.Live.schedule_key')
) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS one_running_ingestion_run_per_schedule_key
    ON ingestion_run_view(schedule_key)
    WHERE status = 'Running';
