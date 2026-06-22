import { useQuery } from "@tanstack/solid-query"

export interface FactorScore {
  ticker: string
  beta: number | null
  annualized_volatility: number | null
  sharpe: number | null
  sortino: number | null
  cum_return: number | null
  carry: number | null
}

const FACTORS_TIMEFRAME = "1d"

export const useFactorScores = () => {
  return useQuery<FactorScore[]>(() => ({
    queryKey: ["factorScores", FACTORS_TIMEFRAME],
    queryFn: async () => {
      const response = await fetch(
        `${import.meta.env.BASE_URL}api/factors/${FACTORS_TIMEFRAME}`,
      )
      if (!response.ok) {
        throw new Error(
          `factor scores request failed: ${String(response.status)}`,
        )
      }
      return response.json() as Promise<FactorScore[]>
    },
    staleTime: 60_000,
  }))
}
