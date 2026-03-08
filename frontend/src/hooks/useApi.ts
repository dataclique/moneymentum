import * as Effect from "effect/Effect"
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { Timeframe } from "@/components/ui/timeframe-select"
import { fetchJson, postJson, postEmpty, fetchStreamChecked } from "@/lib/http"

export type TradingData = {
  timestamp: string
  close: number
  volume: number
  ticker: string
  log_return: number | null
  cum_return: number | null
  autocorrelation: number | null
  stddev: number | null
  annualized_volatility: number | null
  sma: number | null
  mean_return: number | null
  price_stddev: number | null
  return_stddev: number | null
  price_zscore: number | null
  covariance: number | null
  beta: number | null
  information_discreteness: number | null
  sharpe: number | null
  log_return_above_mar: number | null
  downside_deviation: number | null
  sortino: number | null
}

export interface DateRange {
  min_date: string
  max_date: string
  last_timestamp: string | null
}

export interface AnalysisDataParams {
  startDate: string
  endDate: string
  timeframe: Timeframe
}

export const useDateRange = (timeframe: () => Timeframe) => {
  return useQuery<DateRange>(() => ({
    queryKey: ["dateRange", timeframe()],
    queryFn: ({ signal }) =>
      Effect.runPromise(
        fetchJson<DateRange>(`/api/date-range?timeframe=${timeframe()}`, {
          signal,
        }),
      ),
  }))
}

export const useAnalysisData = (params: () => AnalysisDataParams) => {
  return useQuery<{ data: TradingData[]; message: string | null }>(() => {
    const { startDate, endDate, timeframe } = params()
    return {
      queryKey: ["analysisData", timeframe, startDate, endDate],
      queryFn: ({ signal }) =>
        Effect.runPromise(
          postJson<{ data: TradingData[]; message: string | null }>(
            `/api/data?timeframe=${timeframe}`,
            {
              start_date: `${startDate}T00:00:00Z`,
              end_date: `${endDate}T23:59:59Z`,
            },
            { signal },
          ),
        ),
      enabled: !!startDate && !!endDate,
    }
  })
}

export const useTokenData = (
  ticker: () => string | undefined,
  timeframe: () => Timeframe,
) => {
  return useQuery<{ data: TradingData[]; message?: string }>(() => ({
    queryKey: ["tokenData", ticker(), timeframe()],
    queryFn: ({ signal }) => {
      const tickerValue = ticker()
      if (!tickerValue) {
        return Promise.reject(new Error("Ticker is required"))
      }

      return Effect.runPromise(
        fetchJson<{ data: TradingData[]; message?: string }>(
          `/api/token/${encodeURIComponent(tickerValue)}?timeframe=${timeframe()}`,
          { signal },
        ).pipe(
          Effect.flatMap(result =>
            result.message
              ? Effect.fail(new Error(result.message))
              : Effect.succeed(result),
          ),
        ),
      )
    },
    enabled: !!ticker(),
  }))
}

export const useReloadData = () => {
  const queryClient = useQueryClient()

  return useMutation(() => ({
    mutationFn: async ({ mode }: { mode: string }) => {
      const response = await Effect.runPromise(
        fetchStreamChecked("/api/reload_data/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        }),
      )

      if (!response.body) {
        throw new Error("No response body received")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder("utf-8")

      try {
        let done = false
        while (!done) {
          const readResult = await reader.read()
          done = readResult.done
          if (readResult.value) {
            console.log(decoder.decode(readResult.value, { stream: true }))
          }
        }
      } finally {
        reader.releaseLock()
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["analysisData"] })
      void queryClient.invalidateQueries({ queryKey: ["tokenData"] })
      void queryClient.invalidateQueries({ queryKey: ["dateRange"] })
    },
  }))
}

export const useStopReload = () => {
  return useMutation(() => ({
    mutationFn: () => Effect.runPromise(postEmpty("/api/stop_reload")),
  }))
}

export const useBudgetPreference = () => {
  return useQuery<{ budget: number }>(() => ({
    queryKey: ["hyperliquid", "budget-preference"],
    queryFn: ({ signal }) =>
      Effect.runPromise(
        fetchJson<{ budget: number }>("/api/hyperliquid/budget-preference", {
          signal,
        }),
      ),
  }))
}

export const useSaveBudgetPreference = () => {
  return useMutation(() => ({
    mutationFn: (payload: { budget: number }) =>
      Effect.runPromise(
        postJson("/api/hyperliquid/budget-preference", payload).pipe(
          Effect.asVoid,
        ),
      ),
  }))
}
