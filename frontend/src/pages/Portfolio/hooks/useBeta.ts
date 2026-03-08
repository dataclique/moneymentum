import * as Effect from "effect/Effect"
import { useQuery } from "@tanstack/solid-query"
import { createEffect, on } from "solid-js"
import { postJson } from "@/lib/http"
import type { TokenAllocation } from "./usePortfolioState"

const BETA_BENCHMARK = "BTC"

/** Base ticker for beta API: "BTC/USDC:USDC" -> "BTC". Backend ohlcv_1d uses base tickers. */
const symbolToTicker = (symbol: string): string =>
  symbol.includes("/") ? (symbol.split("/")[0] ?? symbol) : symbol

const weightsFromTokens = (
  tokens: TokenAllocation[],
): Record<string, number> => {
  const signedWeights = tokens.reduce<Record<string, number>>(
    (accumulatedWeights, token) => {
      const ticker = symbolToTicker(token.symbol)
      const signedWeight =
        (token.percentage / 100) * (token.side === "buy" ? 1 : -1)
      accumulatedWeights[ticker] =
        (accumulatedWeights[ticker] ?? 0) + signedWeight
      return accumulatedWeights
    },
    {},
  )

  const absoluteWeightSum = Object.values(signedWeights).reduce(
    (totalAbsoluteWeight, weight) => totalAbsoluteWeight + Math.abs(weight),
    0,
  )

  if (absoluteWeightSum <= 0) return signedWeights

  return Object.entries(signedWeights).reduce<Record<string, number>>(
    (normalizedWeights, [ticker, weight]) => {
      normalizedWeights[ticker] = weight / absoluteWeightSum
      return normalizedWeights
    },
    {},
  )
}

const weightsQueryKey = (weights: Record<string, number>): string => {
  const entries = Object.entries(weights).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries)
}

interface BetaResponse {
  beta: number | null
}

const fetchBeta = (
  weights: Record<string, number>,
  benchmark: string,
  signal?: AbortSignal,
) =>
  postJson<BetaResponse>(
    `${import.meta.env.BASE_URL}api/beta`,
    { weights, benchmark },
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    },
  )

export const useBeta = (tokens: () => TokenAllocation[]) => {
  const weights = () => weightsFromTokens(tokens())
  const weightsKey = () => weightsQueryKey(weights())
  const hasTokens = () =>
    tokens().length > 0 && Object.keys(weights()).length > 0

  const query = useQuery(() => ({
    queryKey: ["beta", weightsKey(), BETA_BENCHMARK] as const,
    queryFn: ({ signal }) =>
      Effect.runPromise(fetchBeta(weights(), BETA_BENCHMARK, signal)),
    enabled: hasTokens(),
    // Retry a couple of times on transient failures.
    retry: 2,
  }))

  // Log failures to aid debugging in dev without changing UI behavior.
  createEffect(
    on(
      () => query.error,
      error => {
        if (error && import.meta.env.DEV) {
          console.error("Failed to fetch portfolio beta", error)
        }
      },
    ),
  )

  return {
    get beta() {
      return query.data?.beta ?? null
    },
    get isLoading() {
      return query.isLoading
    },
    get error() {
      return query.error
    },
  }
}
