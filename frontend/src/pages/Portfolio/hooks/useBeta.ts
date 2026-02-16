import { useQuery } from "@tanstack/react-query"
import type { TokenAllocation } from "./usePortfolioState"

const BETA_BENCHMARK = "BTC"

/** Base ticker for beta API: "BTC/USDC:USDC" -> "BTC". Backend ohlcv_1d uses base tickers. */
const symbolToTicker = (symbol: string): string =>
  symbol.includes("/") ? (symbol.split("/")[0] ?? symbol) : symbol

const weightsFromTokens = (
  tokens: TokenAllocation[],
): Record<string, number> => {
  const signed: Record<string, number> = {}
  for (const token of tokens) {
    const ticker = symbolToTicker(token.symbol)
    const raw = (token.percentage / 100) * (token.side === "buy" ? 1 : -1)
    signed[ticker] = (signed[ticker] ?? 0) + raw
  }
  const sumAbs = Object.values(signed).reduce((a, w) => a + Math.abs(w), 0)
  if (sumAbs <= 0) return signed
  const out: Record<string, number> = {}
  for (const [ticker, w] of Object.entries(signed)) {
    out[ticker] = w / sumAbs
  }
  return out
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
  const res = await fetch("/api/beta", {
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

  return {
    beta: query.data?.beta ?? null,
    isLoading: query.isLoading,
    error: query.error,
  }
}
