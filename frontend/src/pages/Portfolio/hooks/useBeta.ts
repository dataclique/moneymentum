import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
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

const fetchBeta = async (
  weights: Record<string, number>,
  benchmark: string,
): Promise<BetaResponse> => {
  const res = await fetch("/beta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights, benchmark }),
  })
  if (!res.ok) throw new Error(`beta request failed: ${res.status}`)
  return res.json() as Promise<BetaResponse>
}

export const useBeta = (tokens: TokenAllocation[]) => {
  const weights = weightsFromTokens(tokens)
  const hasTokens = tokens.length > 0 && Object.keys(weights).length > 0

  const query = useQuery({
    queryKey: ["beta", weightsQueryKey(weights), BETA_BENCHMARK] as const,
    queryFn: () => fetchBeta(weights, BETA_BENCHMARK),
    enabled: hasTokens,
  })

  // Log failures to aid debugging in dev without changing UI behavior.
  useEffect(() => {
    if (query.error) {
      // eslint-disable-next-line no-console
      console.error("Failed to fetch portfolio beta", {
        error: query.error,
        weights,
        benchmark: BETA_BENCHMARK,
      })
    }
  }, [query.error, weights])

  return {
    beta: query.data?.beta ?? null,
    isLoading: query.isLoading,
    error: query.error,
  }
}
