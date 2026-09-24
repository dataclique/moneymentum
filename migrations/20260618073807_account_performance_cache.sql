-- Cached venue equity series (and later account events) keyed by public wallet.
-- Private keys never touch this table; Derive series are upserted by the browser.
CREATE TABLE account_performance_cache
(
    wallet_address TEXT NOT NULL COLLATE NOCASE,
    venue TEXT NOT NULL CHECK (venue IN ('hyperliquid', 'derive')),
    equity_points_json TEXT NOT NULL,
    events_json TEXT NOT NULL DEFAULT '[]',
    fetched_at TEXT NOT NULL,
    coverage_start_ms INTEGER,
    coverage_end_ms INTEGER,
    PRIMARY KEY (wallet_address, venue)
);

CREATE INDEX account_performance_cache_fetched_at
    ON account_performance_cache (fetched_at);
