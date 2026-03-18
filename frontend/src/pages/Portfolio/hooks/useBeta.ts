import { useQuery } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import type { PortfolioInterface } from "./usePortfolioState"

const BETA_BENCHMARK = "BTC"

const symbolToTicker = (symbol: string): string =>
  symbol.includes("/") ? (symbol.split("/")[0] ?? symbol) : symbol

const weightsFromPortfolio = (
  portfolio: Record<string, PortfolioInterface>,
): Record<string, number> => {
  const totalNotional = Object.values(portfolio).reduce(
    (sum, position) => sum + position.notional,
    0,
  )

  if (totalNotional <= 0) return {}

  const signedWeights: Record<string, number> = {}

  for (const position of Object.values(portfolio)) {
    const ticker = symbolToTicker(position.symbol)
    const signedWeight =
      (position.notional / totalNotional) * (position.side === "buy" ? 1 : -1)
    signedWeights[ticker] = (signedWeights[ticker] ?? 0) + signedWeight
  }

  return signedWeights
}

interface BetaResponse {
  beta: number | null
}

const fetchBeta = async (
  weights: Record<string, number>,
  benchmark: string,
  signal?: AbortSignal,
): Promise<BetaResponse> => {
  const res = await fetch(`${import.meta.env.BASE_URL}api/beta`, {
    method: "POST",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights, benchmark }),
  })
  if (!res.ok) throw new Error(`beta request failed: ${res.status}`)
  return res.json() as Promise<BetaResponse>
}

export const useBeta = (
  portfolio: () => Record<string, PortfolioInterface>,
) => {
  const weights = createMemo(() => weightsFromPortfolio(portfolio()))

  const query = useQuery(() => {
    const currentWeights = weights()
    const hasData = Object.keys(currentWeights).length > 0

    return {
      queryKey: ["beta", currentWeights, BETA_BENCHMARK] as const,
      queryFn: (ctx: { signal: AbortSignal }) =>
        fetchBeta(currentWeights, BETA_BENCHMARK, ctx.signal),
      enabled: hasData,
      retry: 2,
    }
  })

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
