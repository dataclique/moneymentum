//! Cached account equity series and external cash-flow events per public wallet.
//!
//! Equity snapshots come from venue mark-to-market history. Deposit and withdraw
//! events support cash-flow-aware percent returns on the frontend.

use std::collections::BTreeMap;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use reqwest::Url;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use thiserror::Error;
use tracing::{debug, info, instrument};

const DEFAULT_HYPERLIQUID_INFO_BASE_URL: &str = "https://api.hyperliquid.xyz";

/// One SQLite row from `account_performance_cache`.
type CachedVenueRow = (String, String, String, String, Option<i64>, Option<i64>);
/// Trading venue whose equity series we cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PerformanceVenue {
    Hyperliquid,
    Derive,
}

impl PerformanceVenue {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Hyperliquid => "hyperliquid",
            Self::Derive => "derive",
        }
    }
}

impl FromStr for PerformanceVenue {
    type Err = AccountPerformanceError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "hyperliquid" => Ok(Self::Hyperliquid),
            "derive" => Ok(Self::Derive),
            other => Err(AccountPerformanceError::UnknownVenue(other.to_string())),
        }
    }
}

/// One mark-to-market account value sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct EquityPoint {
    /// Unix milliseconds.
    pub(crate) timestamp_ms: i64,
    /// Account value in USD as a decimal string on the wire.
    #[serde(with = "rust_decimal::serde::str")]
    pub(crate) value_usd: Decimal,
}

/// External cash-flow event used for time-weighted return segments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum AccountPerformanceEvent {
    Deposit {
        timestamp_ms: i64,
        #[serde(with = "rust_decimal::serde::str")]
        amount_usd: Decimal,
        source_id: String,
    },
    Withdraw {
        timestamp_ms: i64,
        #[serde(with = "rust_decimal::serde::str")]
        amount_usd: Decimal,
        source_id: String,
    },
}

/// One venue's cached series for a wallet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct VenuePerformanceSeries {
    pub(crate) venue: PerformanceVenue,
    pub(crate) equity_points: Vec<EquityPoint>,
    pub(crate) events: Vec<AccountPerformanceEvent>,
    pub(crate) fetched_at: DateTime<Utc>,
    pub(crate) coverage_start_ms: Option<i64>,
    pub(crate) coverage_end_ms: Option<i64>,
}

/// All cached venues for one public wallet address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WalletPerformanceCache {
    pub(crate) wallet_address: String,
    pub(crate) venues: Vec<VenuePerformanceSeries>,
}

/// Body for upserting a single venue series (browser Derive POST, or HL refresh).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct UpsertVenuePerformanceRequest {
    pub(crate) equity_points: Vec<EquityPoint>,
    #[serde(default)]
    pub(crate) events: Vec<AccountPerformanceEvent>,
    pub(crate) fetched_at: DateTime<Utc>,
    pub(crate) coverage_start_ms: Option<i64>,
    pub(crate) coverage_end_ms: Option<i64>,
}

#[derive(Debug, Error)]
pub(crate) enum AccountPerformanceError {
    #[error("invalid wallet address: {0}")]
    InvalidWalletAddress(String),
    #[error("unknown performance venue: {0}")]
    UnknownVenue(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    SerdeJson(#[from] serde_json::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error("hyperliquid portfolio response missing account value history")]
    MissingAccountValueHistory,
    #[error("hyperliquid ledger response was not an array")]
    InvalidLedgerResponse,
    #[error("invalid equity value at timestamp {timestamp_ms}: {value}")]
    InvalidEquityValue { timestamp_ms: i64, value: String },
    #[error("invalid cash-flow amount at timestamp {timestamp_ms}: {value}")]
    InvalidCashFlowAmount { timestamp_ms: i64, value: String },
    #[error("invalid fetched_at in cache: {0}")]
    InvalidFetchedAt(String),
}

/// Normalize and validate a 0x-prefixed 20-byte address; store lowercase.
pub(crate) fn parse_wallet_address(raw: &str) -> Result<String, AccountPerformanceError> {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .ok_or_else(|| AccountPerformanceError::InvalidWalletAddress(raw.to_string()))?;
    if without_prefix.len() != 40 || !without_prefix.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(AccountPerformanceError::InvalidWalletAddress(
            raw.to_string(),
        ));
    }
    Ok(format!("0x{}", without_prefix.to_ascii_lowercase()))
}

fn coverage_from_points(points: &[EquityPoint]) -> (Option<i64>, Option<i64>) {
    let start = points.iter().map(|point| point.timestamp_ms).min();
    let end = points.iter().map(|point| point.timestamp_ms).max();
    (start, end)
}

#[instrument(skip(pool, request), fields(wallet = %wallet_address, venue = venue.as_str()))]
pub(crate) async fn upsert_venue_series(
    pool: &SqlitePool,
    wallet_address: &str,
    venue: PerformanceVenue,
    request: UpsertVenuePerformanceRequest,
) -> Result<VenuePerformanceSeries, AccountPerformanceError> {
    let wallet = parse_wallet_address(wallet_address)?;
    let (coverage_start_ms, coverage_end_ms) =
        match (request.coverage_start_ms, request.coverage_end_ms) {
            (Some(start), Some(end)) => (Some(start), Some(end)),
            _ => coverage_from_points(&request.equity_points),
        };

    let equity_points_json = serde_json::to_string(&request.equity_points)?;
    let events_json = serde_json::to_string(&request.events)?;
    let fetched_at = request.fetched_at.to_rfc3339();

    sqlx::query(
        "INSERT INTO account_performance_cache (
            wallet_address, venue, equity_points_json, events_json,
            fetched_at, coverage_start_ms, coverage_end_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(wallet_address, venue) DO UPDATE SET
            equity_points_json = excluded.equity_points_json,
            events_json = excluded.events_json,
            fetched_at = excluded.fetched_at,
            coverage_start_ms = excluded.coverage_start_ms,
            coverage_end_ms = excluded.coverage_end_ms",
    )
    .bind(&wallet)
    .bind(venue.as_str())
    .bind(&equity_points_json)
    .bind(&events_json)
    .bind(&fetched_at)
    .bind(coverage_start_ms)
    .bind(coverage_end_ms)
    .execute(pool)
    .await?;

    info!(
        points = request.equity_points.len(),
        events = request.events.len(),
        "upserted account performance cache row"
    );

    Ok(VenuePerformanceSeries {
        venue,
        equity_points: request.equity_points,
        events: request.events,
        fetched_at: request.fetched_at,
        coverage_start_ms,
        coverage_end_ms,
    })
}

#[instrument(skip(pool), fields(wallet = %wallet_address))]
pub(crate) async fn load_wallet_performance(
    pool: &SqlitePool,
    wallet_address: &str,
) -> Result<WalletPerformanceCache, AccountPerformanceError> {
    let wallet = parse_wallet_address(wallet_address)?;
    let rows: Vec<CachedVenueRow> = sqlx::query_as(
        "SELECT venue, equity_points_json, events_json, fetched_at,
                coverage_start_ms, coverage_end_ms
         FROM account_performance_cache
         WHERE wallet_address = ?1
         ORDER BY venue ASC",
    )
    .bind(&wallet)
    .fetch_all(pool)
    .await?;

    let mut venues = Vec::with_capacity(rows.len());
    for (venue_raw, equity_json, events_json, fetched_at_raw, coverage_start_ms, coverage_end_ms) in
        rows
    {
        let venue = PerformanceVenue::from_str(&venue_raw)?;
        let equity_points: Vec<EquityPoint> = serde_json::from_str(&equity_json)?;
        let events: Vec<AccountPerformanceEvent> = serde_json::from_str(&events_json)?;
        let fetched_at = DateTime::parse_from_rfc3339(&fetched_at_raw)
            .map(|parsed| parsed.with_timezone(&Utc))
            .map_err(|_| AccountPerformanceError::InvalidFetchedAt(fetched_at_raw))?;
        venues.push(VenuePerformanceSeries {
            venue,
            equity_points,
            events,
            fetched_at,
            coverage_start_ms,
            coverage_end_ms,
        });
    }

    debug!(venues = venues.len(), "loaded account performance cache");
    Ok(WalletPerformanceCache {
        wallet_address: wallet,
        venues,
    })
}

/// Parse Hyperliquid `portfolio` info payload into equity points.
///
/// Unions every window (`day`, `week`, `month`, `allTime`, perp variants) so
/// dense short-horizon samples are kept instead of discarding them for
/// `allTime` alone.
pub(crate) fn equity_points_from_hyperliquid_portfolio(
    payload: &serde_json::Value,
) -> Result<Vec<EquityPoint>, AccountPerformanceError> {
    let windows = payload
        .as_array()
        .ok_or(AccountPerformanceError::MissingAccountValueHistory)?;

    let mut by_timestamp: BTreeMap<i64, Decimal> = BTreeMap::new();

    for entry in windows {
        let pair = entry
            .as_array()
            .ok_or(AccountPerformanceError::MissingAccountValueHistory)?;
        let [_, history_value] = pair.as_slice() else {
            return Err(AccountPerformanceError::MissingAccountValueHistory);
        };
        let Some(history) = history_value
            .get("accountValueHistory")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };

        for sample in history {
            let pair = sample
                .as_array()
                .ok_or(AccountPerformanceError::MissingAccountValueHistory)?;
            let [timestamp_value, equity_value] = pair.as_slice() else {
                return Err(AccountPerformanceError::MissingAccountValueHistory);
            };
            let timestamp_ms = timestamp_value
                .as_i64()
                .ok_or(AccountPerformanceError::MissingAccountValueHistory)?;
            let value_raw = match equity_value {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Number(number) => number.to_string(),
                _ => {
                    return Err(AccountPerformanceError::MissingAccountValueHistory);
                }
            };
            let value_usd = Decimal::from_str(&value_raw).map_err(|_| {
                AccountPerformanceError::InvalidEquityValue {
                    timestamp_ms,
                    value: value_raw,
                }
            })?;
            by_timestamp.insert(timestamp_ms, value_usd);
        }
    }

    if by_timestamp.is_empty() {
        return Err(AccountPerformanceError::MissingAccountValueHistory);
    }

    Ok(by_timestamp
        .into_iter()
        .map(|(timestamp_ms, value_usd)| EquityPoint {
            timestamp_ms,
            value_usd,
        })
        .collect())
}

fn decimal_from_json_value(
    value: &serde_json::Value,
    timestamp_ms: i64,
) -> Result<Decimal, AccountPerformanceError> {
    let value_raw = match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Number(number) => number.to_string(),
        _ => {
            return Err(AccountPerformanceError::InvalidCashFlowAmount {
                timestamp_ms,
                value: value.to_string(),
            });
        }
    };
    Decimal::from_str(&value_raw).map_err(|_| AccountPerformanceError::InvalidCashFlowAmount {
        timestamp_ms,
        value: value_raw,
    })
}

/// Parse Hyperliquid `userNonFundingLedgerUpdates` into deposit/withdraw events.
///
/// v1 keeps only `deposit` and `withdraw` deltas; vault and internal transfer
/// types are ignored so cross-venue moves can be classified later.
pub(crate) fn cash_flow_events_from_hyperliquid_ledger(
    payload: &serde_json::Value,
) -> Result<Vec<AccountPerformanceEvent>, AccountPerformanceError> {
    let entries = payload
        .as_array()
        .ok_or(AccountPerformanceError::InvalidLedgerResponse)?;

    let mut events = Vec::new();
    for entry in entries {
        let timestamp_ms = entry
            .get("time")
            .and_then(serde_json::Value::as_i64)
            .ok_or(AccountPerformanceError::InvalidLedgerResponse)?;
        let hash = entry
            .get("hash")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let delta = entry
            .get("delta")
            .ok_or(AccountPerformanceError::InvalidLedgerResponse)?;
        let delta_type = delta
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or(AccountPerformanceError::InvalidLedgerResponse)?;

        let amount_field = delta.get("usdc").or_else(|| delta.get("usdcValue"));
        let Some(amount_value) = amount_field else {
            continue;
        };
        let amount_usd = decimal_from_json_value(amount_value, timestamp_ms)?.abs();
        if amount_usd.is_zero() {
            continue;
        }

        let source_id = if hash.is_empty() {
            format!("{delta_type}:{timestamp_ms}")
        } else {
            hash.to_string()
        };

        match delta_type {
            "deposit" => {
                events.push(AccountPerformanceEvent::Deposit {
                    timestamp_ms,
                    amount_usd,
                    source_id,
                });
            }
            "withdraw" => {
                events.push(AccountPerformanceEvent::Withdraw {
                    timestamp_ms,
                    amount_usd,
                    source_id,
                });
            }
            _ => {}
        }
    }

    events.sort_by_key(|event| match event {
        AccountPerformanceEvent::Deposit { timestamp_ms, .. }
        | AccountPerformanceEvent::Withdraw { timestamp_ms, .. } => *timestamp_ms,
    });
    Ok(events)
}

fn resolve_hyperliquid_info_endpoint(
    hyperliquid_base_url: Option<&Url>,
) -> Result<Url, AccountPerformanceError> {
    let base = match hyperliquid_base_url {
        Some(url) => url.clone(),
        None => Url::parse(DEFAULT_HYPERLIQUID_INFO_BASE_URL)?,
    };
    if base.path().trim_end_matches('/').ends_with("/info") {
        return Ok(base);
    }
    Ok(base.join("info")?)
}

/// Fetch Hyperliquid `portfolio` equity and non-funding ledger cash flows, then upsert.
#[instrument(skip(pool, http_client, hyperliquid_base_url), fields(wallet = %wallet_address))]
pub(crate) async fn refresh_hyperliquid_performance(
    pool: &SqlitePool,
    http_client: &reqwest::Client,
    hyperliquid_base_url: Option<&Url>,
    wallet_address: &str,
) -> Result<VenuePerformanceSeries, AccountPerformanceError> {
    let wallet = parse_wallet_address(wallet_address)?;
    let endpoint = resolve_hyperliquid_info_endpoint(hyperliquid_base_url)?;

    let portfolio_response = http_client
        .post(endpoint.clone())
        .json(&serde_json::json!({
            "type": "portfolio",
            "user": wallet,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    let equity_points = equity_points_from_hyperliquid_portfolio(&portfolio_response)?;

    let ledger_response = http_client
        .post(endpoint)
        .json(&serde_json::json!({
            "type": "userNonFundingLedgerUpdates",
            "user": wallet,
            "startTime": 0,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    let events = cash_flow_events_from_hyperliquid_ledger(&ledger_response)?;
    let fetched_at = Utc::now();
    let (coverage_start_ms, coverage_end_ms) = coverage_from_points(&equity_points);

    info!(
        points = equity_points.len(),
        events = events.len(),
        "fetched hyperliquid portfolio equity and cash-flow events"
    );

    upsert_venue_series(
        pool,
        &wallet,
        PerformanceVenue::Hyperliquid,
        UpsertVenuePerformanceRequest {
            equity_points,
            events,
            fetched_at,
            coverage_start_ms,
            coverage_end_ms,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::Level;
    use tracing_test::traced_test;

    use crate::logs_contain_at;

    fn sample_points() -> Vec<EquityPoint> {
        vec![
            EquityPoint {
                timestamp_ms: 1_000,
                value_usd: Decimal::from_str("100.5").unwrap(),
            },
            EquityPoint {
                timestamp_ms: 2_000,
                value_usd: Decimal::from_str("110").unwrap(),
            },
        ]
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[test]
    fn parse_wallet_address_normalizes_case() {
        let parsed = parse_wallet_address("0xAbCdEf0123456789AbCdEf0123456789AbCdEf01").unwrap();
        assert_eq!(parsed, "0xabcdef0123456789abcdef0123456789abcdef01");
    }

    #[test]
    fn parse_wallet_address_rejects_short() {
        assert!(matches!(
            parse_wallet_address("0xabc"),
            Err(AccountPerformanceError::InvalidWalletAddress(_))
        ));
    }

    #[test]
    fn equity_points_union_all_portfolio_windows() {
        let payload = serde_json::json!([
            ["day", {"accountValueHistory": [[10, "1.0"]]}],
            ["allTime", {"accountValueHistory": [[1, "2.5"], [2, "3.0"]]}],
            ["week", {"accountValueHistory": [[5, "9.0"]]}]
        ]);
        let points = equity_points_from_hyperliquid_portfolio(&payload).unwrap();
        assert_eq!(points.len(), 4);
        assert_eq!(points[0].timestamp_ms, 1);
        assert_eq!(points[0].value_usd, Decimal::from_str("2.5").unwrap());
        assert_eq!(points[1].timestamp_ms, 2);
        assert_eq!(points[2].timestamp_ms, 5);
        assert_eq!(points[2].value_usd, Decimal::from_str("9.0").unwrap());
        assert_eq!(points[3].timestamp_ms, 10);
        assert_eq!(points[3].value_usd, Decimal::from_str("1.0").unwrap());
    }

    #[test]
    fn ledger_keeps_deposit_and_withdraw_only() {
        let payload = serde_json::json!([
            {
                "time": 1_000,
                "hash": "0xaaa",
                "delta": { "type": "deposit", "usdc": "50.5" }
            },
            {
                "time": 2_000,
                "hash": "0xbbb",
                "delta": { "type": "vaultDeposit", "usdc": "99" }
            },
            {
                "time": 3_000,
                "hash": "0xccc",
                "delta": { "type": "withdraw", "usdc": "10", "fee": "1" }
            }
        ]);
        let events = cash_flow_events_from_hyperliquid_ledger(&payload).unwrap();
        assert_eq!(
            events,
            vec![
                AccountPerformanceEvent::Deposit {
                    timestamp_ms: 1_000,
                    amount_usd: Decimal::from_str("50.5").unwrap(),
                    source_id: "0xaaa".to_string(),
                },
                AccountPerformanceEvent::Withdraw {
                    timestamp_ms: 3_000,
                    amount_usd: Decimal::from_str("10").unwrap(),
                    source_id: "0xccc".to_string(),
                },
            ]
        );
    }

    #[traced_test]
    #[tokio::test]
    async fn upsert_and_load_round_trip_logs() {
        let pool = test_pool().await;
        let wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let events = vec![AccountPerformanceEvent::Deposit {
            timestamp_ms: 1_500,
            amount_usd: Decimal::from_str("25").unwrap(),
            source_id: "tx-1".to_string(),
        }];
        let series = upsert_venue_series(
            &pool,
            wallet,
            PerformanceVenue::Derive,
            UpsertVenuePerformanceRequest {
                equity_points: sample_points(),
                events: events.clone(),
                fetched_at: Utc::now(),
                coverage_start_ms: None,
                coverage_end_ms: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(series.equity_points.len(), 2);
        assert_eq!(series.events, events);
        assert_eq!(series.coverage_start_ms, Some(1_000));
        assert_eq!(series.coverage_end_ms, Some(2_000));
        assert!(logs_contain_at(
            Level::INFO,
            &["upserted account performance cache row"]
        ));

        let loaded = load_wallet_performance(&pool, wallet).await.unwrap();
        assert_eq!(loaded.venues.len(), 1);
        assert_eq!(loaded.venues[0].venue, PerformanceVenue::Derive);
        assert_eq!(loaded.venues[0].equity_points, sample_points());
        assert_eq!(loaded.venues[0].events, events);
        assert!(logs_contain_at(
            Level::DEBUG,
            &["loaded account performance cache"]
        ));
    }
}
