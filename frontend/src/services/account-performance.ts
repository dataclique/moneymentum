/**
 * Account performance cache API (equity series per public wallet + venue).
 * Private keys never leave the browser; Derive series are upserted from the FE.
 */

import * as Effect from "effect/Effect"
import { fetchJson, postJson, putJson } from "@/lib/http"
import type { NetworkMode } from "@/contexts/wallet-context"

export type PerformanceVenueId = "hyperliquid" | "derive"

export interface EquityPoint {
  readonly timestamp_ms: number
  readonly value_usd: string
}

export interface VenuePerformanceSeries {
  readonly venue: PerformanceVenueId
  readonly equity_points: readonly EquityPoint[]
  readonly events: readonly unknown[]
  readonly fetched_at: string
  readonly coverage_start_ms: number | null
  readonly coverage_end_ms: number | null
}

export interface WalletPerformanceCache {
  readonly wallet_address: string
  readonly venues: readonly VenuePerformanceSeries[]
}

export interface UpsertVenuePerformanceRequest {
  readonly equity_points: readonly EquityPoint[]
  readonly events?: readonly unknown[]
  readonly fetched_at: string
  readonly coverage_start_ms: number | null
  readonly coverage_end_ms: number | null
}

export const fetchWalletPerformance = (
  walletAddress: string,
  signal?: AbortSignal,
): Effect.Effect<WalletPerformanceCache, unknown> =>
  fetchJson<WalletPerformanceCache>(
    `/api/performance/${encodeURIComponent(walletAddress)}`,
    { signal },
  )

export const upsertVenuePerformance = (
  walletAddress: string,
  venue: PerformanceVenueId,
  body: UpsertVenuePerformanceRequest,
  signal?: AbortSignal,
): Effect.Effect<VenuePerformanceSeries, unknown> =>
  putJson<VenuePerformanceSeries>(
    `/api/performance/${encodeURIComponent(walletAddress)}/${venue}`,
    body,
    { signal },
  )

export const refreshHyperliquidPerformance = (
  walletAddress: string,
  networkMode: NetworkMode,
  signal?: AbortSignal,
): Effect.Effect<VenuePerformanceSeries, unknown> =>
  postJson<VenuePerformanceSeries>(
    `/api/performance/${encodeURIComponent(walletAddress)}/hyperliquid/refresh?network=${networkMode}`,
    {},
    { signal },
  )
