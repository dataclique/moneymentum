import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { Timeframe } from "@/components/ui/timeframe-select"

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

interface ApiError {
  detail?: string
}

/**
 * Refresh all data in the application.
 * Invalidates and refetches all queries to ensure UI is up-to-date.
 */
export const refreshAllData = async (queryClient: QueryClient) => {
  // First, invalidate and refetch wallet settings
  await queryClient.invalidateQueries({
    queryKey: ["hyperliquid", "wallet-settings"],
  })
  await queryClient.refetchQueries({
    queryKey: ["hyperliquid", "wallet-settings"],
  })

  // Force refetch critical queries
  await Promise.all([
    queryClient.refetchQueries({
      queryKey: ["hyperliquid", "positions"],
      exact: false,
    }),
    queryClient.refetchQueries({
      queryKey: ["hyperliquid", "balance"],
      exact: false,
    }),
    queryClient.refetchQueries({
      queryKey: ["hyperliquid", "tickers"],
      exact: false,
    }),
    queryClient.refetchQueries({
      queryKey: ["hyperliquid", "budget-preference"],
      exact: false,
    }),
  ])

  // Invalidate other queries (they'll refetch when components need them)
  await queryClient.invalidateQueries({ queryKey: ["analysisData"] })
  await queryClient.invalidateQueries({ queryKey: ["tokenData"] })
  await queryClient.invalidateQueries({ queryKey: ["dateRange"] })
  await queryClient.invalidateQueries({ queryKey: ["hyperliquid"] })
}

export type OrderSide = "buy" | "sell"

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

export interface OpenPositionsParams {
  budget: number
  positions: Array<{
    symbol: string
    percentage: number
    side: OrderSide
    leverage: number
    status: "untouched" | "modified" | "idle" | "deleted" | "working"
  }>
}

export interface OrderStatus {
  symbol: string
  side: OrderSide
  percentage: number
  status: "working" | "filled" | "failed"
  message?: string | null
}

export const useDateRange = (timeframe: Timeframe) => {
  return useQuery<DateRange>({
    queryKey: ["dateRange", timeframe],
    queryFn: async () => {
      const response = await fetch(`/api/date-range?timeframe=${timeframe}`)
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(
          errorData.detail ?? `HTTP error! status: ${String(response.status)}`,
        )
      }
      return response.json() as Promise<DateRange>
    },
  })
}

export const useAnalysisData = ({
  startDate,
  endDate,
  timeframe,
}: AnalysisDataParams) => {
  return useQuery<{ data: TradingData[]; message: string | null }>({
    queryKey: ["analysisData", timeframe, startDate, endDate],
    queryFn: async () => {
      const startDateTime = `${startDate}T00:00:00Z`
      const endDateTime = `${endDate}T23:59:59Z`

      const response = await fetch(`/api/data?timeframe=${timeframe}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          start_date: startDateTime,
          end_date: endDateTime,
        }),
      })

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(
          errorData.detail ?? `HTTP error! status: ${String(response.status)}`,
        )
      }

      return response.json() as Promise<{
        data: TradingData[]
        message: string | null
      }>
    },
    enabled: !!startDate && !!endDate,
  })
}

export const useTokenData = (
  ticker: string | undefined,
  timeframe: Timeframe,
) => {
  return useQuery<{ data: TradingData[]; message?: string }>({
    queryKey: ["tokenData", ticker, timeframe],
    queryFn: async () => {
      if (!ticker) {
        throw new Error("Ticker is required")
      }

      const response = await fetch(
        `/api/token/${ticker}?timeframe=${timeframe}`,
      )

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${String(response.status)}`)
      }

      const result = (await response.json()) as {
        data: TradingData[]
        message?: string
      }

      if (result.message) {
        throw new Error(result.message)
      }

      return result
    },
    enabled: !!ticker,
  })
}

export const useReloadData = () => {
  const queryClient = useQueryClient()

  return useMutation<undefined, Error, { mode: string }>({
    mutationFn: async ({ mode }) => {
      const controller = new AbortController()

      const response = await fetch("/api/reload_data/stream", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode }),
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${String(response.status)}`)
      }

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
            // Log streaming output for debugging
            // eslint-disable-next-line no-console
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
  })
}

export const useStopReload = () => {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/stop_reload", {
        method: "POST",
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${String(response.status)}`)
      }
    },
  })
}

export const useHyperliquidTickers = () => {
  return useQuery<{ data: string[] }>({
    queryKey: ["hyperliquid", "tickers"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/tickers")
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to fetch tickers")
      }
      return response.json() as Promise<{ data: string[] }>
    },
  })
}

export const useHyperliquidBalance = () => {
  return useQuery<{ perp_usdc_balance: number }>({
    queryKey: ["hyperliquid", "balance"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/balance")
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to fetch balance")
      }
      return response.json() as Promise<{ perp_usdc_balance: number }>
    },
  })
}

export const useOpenHyperliquidPositions = () => {
  return useMutation<{ orders: OrderStatus[] }, Error, OpenPositionsParams>({
    mutationFn: async payload => {
      const response = await fetch("/api/hyperliquid/open_positions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to open positions")
      }

      return response.json() as Promise<{ orders: OrderStatus[] }>
    },
  })
}

export const useRebalanceHyperliquidPositions = () => {
  return useMutation<{ orders: OrderStatus[] }, Error, OpenPositionsParams>({
    mutationFn: async payload => {
      const response = await fetch("/api/hyperliquid/rebalance_positions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to rebalance positions")
      }

      return response.json() as Promise<{ orders: OrderStatus[] }>
    },
  })
}

export interface CurrentPosition {
  symbol: string
  side: OrderSide
  notional: number
  entryPrice: number
  unrealizedPnl: number
  percentage: number
  leverage: number
}

export interface LeverageLimit {
  symbol: string
  max_leverage: number
}

export const useHyperliquidPositions = () => {
  return useQuery<{ positions: CurrentPosition[]; total_notional: number }>({
    queryKey: ["hyperliquid", "positions"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/positions")
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to fetch positions")
      }
      return response.json() as Promise<{
        positions: CurrentPosition[]
        total_notional: number
      }>
    },
  })
}

export const useHyperliquidLeverageLimits = () => {
  return useQuery<{ data: LeverageLimit[] }>({
    queryKey: ["hyperliquid", "leverage-limits"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/leverage-limits")
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to fetch leverage limits")
      }
      return response.json() as Promise<{ data: LeverageLimit[] }>
    },
  })
}

export const useBudgetPreference = () => {
  return useQuery<{ budget: number }>({
    queryKey: ["hyperliquid", "budget-preference"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/budget-preference")
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to fetch budget preference")
      }
      return response.json() as Promise<{ budget: number }>
    },
  })
}

export const useSaveBudgetPreference = () => {
  return useMutation({
    mutationFn: async (payload: { budget: number }) => {
      const response = await fetch("/api/hyperliquid/budget-preference", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to save budget preference")
      }
    },
  })
}

export interface WalletSettings {
  public_key: string
  is_testnet: boolean
}

export const useWalletSettings = () => {
  return useQuery<WalletSettings>({
    queryKey: ["hyperliquid", "wallet-settings"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/wallet-settings")
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to fetch wallet settings")
      }
      return response.json() as Promise<WalletSettings>
    },
  })
}

export const useSwitchNetwork = () => {
  return useMutation<{ is_testnet: boolean }, Error, { is_testnet: boolean }>({
    mutationFn: async payload => {
      const response = await fetch("/api/hyperliquid/network", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError
        throw new Error(errorData.detail ?? "Unable to switch network")
      }
      return response.json() as Promise<{ is_testnet: boolean }>
    },
  })
}
