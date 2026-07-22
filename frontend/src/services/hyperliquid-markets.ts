import type { NetworkMode } from "@/contexts/wallet-context"

export interface LeverageLimit {
  symbol: string
  maxLeverage: number
  assetIndex: number
  /** `true` when Hyperliquid forbids cross margin; always a boolean from the backend. */
  onlyIsolated: boolean
}

export interface HyperliquidMarketsResponse {
  tickers: string[]
  leverageLimits: LeverageLimit[]
  refreshedAt: string | null
  marketsMaxAgeMs?: number
}

const HYPERLIQUID_REQUEST_TIMEOUT_MS = 10_000
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

export const millisecondsUntilNextUtcMidnight = (
  now: Date = new Date(),
): number => {
  const millisecondsIntoDay = now.getTime() % MILLISECONDS_PER_DAY
  return Math.max(MILLISECONDS_PER_DAY - millisecondsIntoDay, 1)
}

const parseCacheMaxAgeMs = (cacheControl: string | null): number | null => {
  if (!cacheControl) return null
  const match = cacheControl.match(/max-age=(\d+)/)
  if (!match) return null
  const maxAgeSeconds = Number(match[1])
  return Number.isFinite(maxAgeSeconds) ? maxAgeSeconds * 1000 : null
}

/**
 * Fetches the Hyperliquid markets catalog from the app API (no ccxt).
 */
export const fetchHyperliquidMarkets = async (
  network: NetworkMode,
): Promise<HyperliquidMarketsResponse> => {
  const url = `${import.meta.env.BASE_URL}api/hyperliquid/markets?network=${network}`
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(HYPERLIQUID_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `hyperliquid markets request failed: ${String(response.status)}`,
    )
  }
  const markets = (await response.json()) as HyperliquidMarketsResponse
  const marketsMaxAgeMs =
    parseCacheMaxAgeMs(response.headers.get("cache-control")) ??
    millisecondsUntilNextUtcMidnight()
  return { ...markets, marketsMaxAgeMs }
}
