/**
 * Derive account value history and cash-flow events → server performance cache.
 * Session private key stays in the browser; only public wallet + series are sent.
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { privateKeyToAccount } from "viem/accounts"

import { postJson } from "@/lib/http"
import {
  upsertVenuePerformance,
  type AccountPerformanceEvent,
  type EquityPoint,
} from "../account-performance"
import {
  DeriveRpcError,
  DeriveSessionMissing,
  DeriveSessionSignFailed,
  DeriveSubaccountMissing,
  deriveRestBaseUrl,
  parseDeriveNumeric,
  requireDeriveSession,
  type DeriveSessionCredentials,
  type DeriveSessionWithSubaccount,
} from "./session"

interface DeriveRpcEnvelope<Result> {
  readonly result?: Result
  readonly error?: {
    readonly code?: number | string | null
    readonly message?: string
  } | null
}

interface DeriveValueHistoryEntry {
  readonly subaccount_value?: string | number
  readonly timestamp?: number
}

interface DeriveValueHistoryResult {
  readonly subaccount_value_history?: DeriveValueHistoryEntry[] | null
}

interface DeriveCashFlowHistoryEntry {
  readonly amount?: string | number
  readonly asset?: string
  readonly timestamp?: number
  readonly transaction_id?: string
  readonly tx_hash?: string
  readonly tx_status?: string
}

interface DeriveCashFlowHistoryResult {
  readonly events?: DeriveCashFlowHistoryEntry[] | null
}

export class DeriveValueHistoryInvalid extends Data.TaggedError(
  "DeriveValueHistoryInvalid",
)<{
  readonly message: string
}> {}

export class DeriveCashFlowHistoryInvalid extends Data.TaggedError(
  "DeriveCashFlowHistoryInvalid",
)<{
  readonly message: string
}> {}

type SyncDerivePerformanceFailure =
  | DeriveSessionMissing
  | DeriveSubaccountMissing
  | DeriveSessionSignFailed
  | DeriveRpcError
  | DeriveValueHistoryInvalid
  | DeriveCashFlowHistoryInvalid

const USD_LIKE_ASSETS = new Set(["USDC", "USDT", "USD", "USDC.E", "USDT.E"])

const toDeriveRpcError = (cause: unknown): DeriveRpcError =>
  new DeriveRpcError({
    code: null,
    message:
      cause instanceof Error
        ? cause.message
        : "Derive performance sync request failed.",
  })

const signTimestamp = (
  sessionPrivateKey: `0x${string}`,
  timestampMs: string,
): Effect.Effect<string, DeriveSessionSignFailed> =>
  Effect.tryPromise({
    try: () =>
      privateKeyToAccount(sessionPrivateKey).signMessage({
        message: timestampMs,
      }),
    catch: cause => new DeriveSessionSignFailed({ cause }),
  })

const unwrapRpc = <Result>(
  envelope: DeriveRpcEnvelope<Result>,
): Effect.Effect<Result, DeriveRpcError> => {
  if (envelope.error !== undefined && envelope.error !== null) {
    return Effect.fail(
      new DeriveRpcError({
        code: envelope.error.code ?? null,
        message:
          envelope.error.message ??
          "Derive returned an error without a message.",
      }),
    )
  }
  if (envelope.result === undefined) {
    return Effect.fail(
      new DeriveRpcError({
        code: null,
        message: "Derive response missing result.",
      }),
    )
  }
  return Effect.succeed(envelope.result)
}

const signedPrivatePost = <Result>(
  session: DeriveSessionWithSubaccount,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Effect.Effect<Result, DeriveSessionSignFailed | DeriveRpcError> =>
  Effect.gen(function* () {
    const baseUrl = deriveRestBaseUrl(session.networkMode)
    const timestampMs = Date.now().toString()
    const signature = yield* signTimestamp(
      session.sessionPrivateKey,
      timestampMs,
    )
    const envelope = yield* postJson<DeriveRpcEnvelope<Result>>(
      `${baseUrl}${path}`,
      body,
      {
        signal,
        headers: {
          "X-LyraWallet": session.deriveWallet,
          "X-LyraTimestamp": timestampMs,
          "X-LyraSignature": signature,
        },
      },
    ).pipe(Effect.mapError(toDeriveRpcError))
    return yield* unwrapRpc(envelope)
  })

/**
 * Convert Derive value-history samples (unix seconds) into cache equity points.
 */
export const equityPointsFromDeriveValueHistory = (
  entries: readonly DeriveValueHistoryEntry[],
): Effect.Effect<EquityPoint[], DeriveValueHistoryInvalid> => {
  const points: EquityPoint[] = []
  for (const entry of entries) {
    if (
      typeof entry.timestamp !== "number" ||
      !Number.isFinite(entry.timestamp)
    ) {
      return Effect.fail(
        new DeriveValueHistoryInvalid({
          message: "Derive value history entry missing timestamp.",
        }),
      )
    }
    const value = parseDeriveNumeric(entry.subaccount_value, Number.NaN)
    if (!Number.isFinite(value)) {
      return Effect.fail(
        new DeriveValueHistoryInvalid({
          message: "Derive value history entry missing subaccount_value.",
        }),
      )
    }
    // Derive documents seconds for this endpoint; store ms for the shared cache.
    const timestampMs =
      entry.timestamp < 1_000_000_000_000
        ? Math.trunc(entry.timestamp * 1000)
        : Math.trunc(entry.timestamp)
    points.push({
      timestamp_ms: timestampMs,
      value_usd: value.toString(),
    })
  }
  points.sort((left, right) => left.timestamp_ms - right.timestamp_ms)
  return Effect.succeed(points)
}

const isSettledCashFlow = (status: string | undefined): boolean =>
  status === undefined || status === "settled"

const isUsdLikeAsset = (asset: string | undefined): boolean => {
  if (asset === undefined || asset.trim() === "") return true
  return USD_LIKE_ASSETS.has(asset.trim().toUpperCase())
}

/**
 * Map Derive deposit/withdrawal history rows into cache cash-flow events.
 * Non-USD assets and non-settled rows are skipped in v1.
 */
export const cashFlowEventsFromDeriveHistory = (
  kind: "deposit" | "withdraw",
  entries: readonly DeriveCashFlowHistoryEntry[],
): Effect.Effect<AccountPerformanceEvent[], DeriveCashFlowHistoryInvalid> => {
  const events: AccountPerformanceEvent[] = []
  for (const entry of entries) {
    if (!isSettledCashFlow(entry.tx_status)) continue
    if (!isUsdLikeAsset(entry.asset)) continue
    if (
      typeof entry.timestamp !== "number" ||
      !Number.isFinite(entry.timestamp)
    ) {
      return Effect.fail(
        new DeriveCashFlowHistoryInvalid({
          message: "Derive cash-flow entry missing timestamp.",
        }),
      )
    }
    const amount = parseDeriveNumeric(entry.amount, Number.NaN)
    if (!Number.isFinite(amount) || amount <= 0) {
      return Effect.fail(
        new DeriveCashFlowHistoryInvalid({
          message: "Derive cash-flow entry missing positive amount.",
        }),
      )
    }
    const timestampMs =
      entry.timestamp < 1_000_000_000_000
        ? Math.trunc(entry.timestamp * 1000)
        : Math.trunc(entry.timestamp)
    const sourceId =
      entry.tx_hash ?? entry.transaction_id ?? `${kind}:${String(timestampMs)}`
    events.push({
      kind,
      timestamp_ms: timestampMs,
      amount_usd: Math.abs(amount).toString(),
      source_id: sourceId,
    })
  }
  return Effect.succeed(events)
}

/**
 * Fetch hourly value history plus deposit/withdrawal events for the selected
 * subaccount and upsert into the server cache under the Derive public wallet.
 */
export const syncDerivePerformanceToCache = (
  credentials: DeriveSessionCredentials | null,
  signal?: AbortSignal,
): Effect.Effect<EquityPoint[], SyncDerivePerformanceFailure> =>
  Effect.gen(function* () {
    const session = yield* requireDeriveSession(credentials)
    const subaccountId = session.subaccountId
    if (subaccountId === null) {
      return yield* Effect.fail(new DeriveSubaccountMissing())
    }

    const endSeconds = Math.floor(Date.now() / 1000)
    const startSeconds = endSeconds - 365 * 24 * 3600
    const sessionWithSubaccount: DeriveSessionWithSubaccount = {
      ...session,
      subaccountId,
    }

    const historyResult = yield* signedPrivatePost<DeriveValueHistoryResult>(
      sessionWithSubaccount,
      "/private/get_subaccount_value_history",
      {
        subaccount_id: subaccountId,
        start_timestamp: startSeconds,
        end_timestamp: endSeconds,
        period: 3600,
      },
      signal,
    )

    const history = Array.isArray(historyResult.subaccount_value_history)
      ? historyResult.subaccount_value_history
      : []
    const equityPoints = yield* equityPointsFromDeriveValueHistory(history)

    const depositResult = yield* signedPrivatePost<DeriveCashFlowHistoryResult>(
      sessionWithSubaccount,
      "/private/get_deposit_history",
      {
        subaccount_id: subaccountId,
        start_timestamp: 0,
      },
      signal,
    )
    const withdrawResult =
      yield* signedPrivatePost<DeriveCashFlowHistoryResult>(
        sessionWithSubaccount,
        "/private/get_withdrawal_history",
        {
          subaccount_id: subaccountId,
          start_timestamp: 0,
        },
        signal,
      )

    const depositEvents = yield* cashFlowEventsFromDeriveHistory(
      "deposit",
      Array.isArray(depositResult.events) ? depositResult.events : [],
    )
    const withdrawEvents = yield* cashFlowEventsFromDeriveHistory(
      "withdraw",
      Array.isArray(withdrawResult.events) ? withdrawResult.events : [],
    )
    const events = [...depositEvents, ...withdrawEvents].sort(
      (left, right) => left.timestamp_ms - right.timestamp_ms,
    )

    const coverageStartMs =
      equityPoints.length === 0 ? null : (equityPoints[0]?.timestamp_ms ?? null)
    const coverageEndMs =
      equityPoints.length === 0
        ? null
        : (equityPoints[equityPoints.length - 1]?.timestamp_ms ?? null)

    yield* upsertVenuePerformance(
      session.deriveWallet,
      "derive",
      {
        equity_points: equityPoints,
        events,
        fetched_at: new Date().toISOString(),
        coverage_start_ms: coverageStartMs,
        coverage_end_ms: coverageEndMs,
      },
      signal,
    ).pipe(Effect.mapError(toDeriveRpcError))

    return equityPoints
  })
