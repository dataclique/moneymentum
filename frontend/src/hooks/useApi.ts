import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { Timeframe } from "@/components/ui/timeframe-select"

/**
 * Refresh all data in the application.
 * Invalidates and refetches all queries to ensure UI is up-to-date.
 */
export async function refreshAllData(queryClient: QueryClient) {
  console.log("Refreshing all data...")

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
  queryClient.invalidateQueries({ queryKey: ["analysisData"] })
  queryClient.invalidateQueries({ queryKey: ["tokenData"] })
  queryClient.invalidateQueries({ queryKey: ["dateRange"] })
  queryClient.invalidateQueries({ queryKey: ["hyperliquid"] })

  console.log("All data refreshed")
}

export type OrderSide = "buy" | "sell"

export interface TradingData {
  timestamp: string
  token: string
  close: number
  volume: number
  autocorr: number
  sma: number
  z_score: number
  predicted_return: number
  volatility: number
  sharpe: number
  sortino: number
  beta: number
  [key: string]: string | number
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

export interface OrderStatus {
  symbol: string
  side: OrderSide
  percentage: number
  status: "working" | "filled" | "failed"
  message?: string | null
}

export function useDateRange(timeframe: Timeframe) {
  return useQuery<DateRange>({
    queryKey: ["dateRange", timeframe],
    queryFn: async () => {
      const response = await fetch(`/api/date-range?timeframe=${timeframe}`)
      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(
          errorData.detail || `HTTP error! status: ${response.status}`,
        )
      }
      return response.json()
    },
  })
}

export function useAnalysisData({
  startDate,
  endDate,
  timeframe,
}: AnalysisDataParams) {
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
        const errorData = await response.json()
        throw new Error(
          errorData.detail || `HTTP error! status: ${response.status}`,
        )
      }

      return response.json()
    },
    enabled: !!startDate && !!endDate,
  })
}

export function useTokenData(ticker: string | undefined, timeframe: Timeframe) {
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
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const result = await response.json()

      if (result.message) {
        throw new Error(result.message)
      }

      return result
    },
    enabled: !!ticker,
  })
}

export function useReloadData() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, { mode: string }>({
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
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      if (!response.body) {
        throw new Error("No response body received")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder("utf-8")

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          console.log(decoder.decode(value, { stream: true }))
        }
      } finally {
        reader.releaseLock()
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["analysisData"] })
      queryClient.invalidateQueries({ queryKey: ["tokenData"] })
      queryClient.invalidateQueries({ queryKey: ["dateRange"] })
    },
  })
}

export function useStopReload() {
  return useMutation<void, Error>({
    mutationFn: async () => {
      const response = await fetch("/api/stop_reload", {
        method: "POST",
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
    },
  })
}

export function useHyperliquidTickers() {
  return useQuery<{ data: string[] }>({
    queryKey: ["hyperliquid", "tickers"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/tickers")
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to fetch tickers")
      }
      return response.json()
    },
  })
}

export function useHyperliquidBalance() {
  return useQuery<{ perp_usdc_balance: number }>({
    queryKey: ["hyperliquid", "balance"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/balance")
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to fetch balance")
      }
      return response.json()
    },
  })
}

export interface OpenPositionsParams {
  budget: number
  positions: Array<{
    symbol: string
    percentage: number
    side: OrderSide
    leverage: number
  }>
}

export function useOpenHyperliquidPositions() {
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
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to open positions")
      }

      return response.json()
    },
  })
}

export function useRebalanceHyperliquidPositions() {
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
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to rebalance positions")
      }

      return response.json()
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

export function useHyperliquidPositions() {
  return useQuery<{ positions: CurrentPosition[]; total_notional: number }>({
    queryKey: ["hyperliquid", "positions"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/positions")
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to fetch positions")
      }
      return response.json()
    },
  })
}

export function useHyperliquidLeverageLimits() {
  return useQuery<{ data: LeverageLimit[] }>({
    queryKey: ["hyperliquid", "leverage-limits"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/leverage-limits")
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to fetch leverage limits")
      }
      return response.json()
    },
  })
}

export function useBudgetPreference() {
  return useQuery<{ budget: number }>({
    queryKey: ["hyperliquid", "budget-preference"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/budget-preference")
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to fetch budget preference")
      }
      return response.json()
    },
  })
}

export function useSaveBudgetPreference() {
  return useMutation<void, Error, { budget: number }>({
    mutationFn: async payload => {
      const response = await fetch("/api/hyperliquid/budget-preference", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to save budget preference")
      }
    },
  })
}

export interface WalletSettings {
  public_key: string
  is_testnet: boolean
}

export function useWalletSettings() {
  return useQuery<WalletSettings>({
    queryKey: ["hyperliquid", "wallet-settings"],
    queryFn: async () => {
      const response = await fetch("/api/hyperliquid/wallet-settings")
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to fetch wallet settings")
      }
      return response.json()
    },
  })
}

export interface SaveWalletSettingsParams {
  public_key?: string
  secret_key?: string
  is_testnet: boolean
}

export function useSaveWalletSettings() {
  return useMutation<void, Error, SaveWalletSettingsParams>({
    mutationFn: async payload => {
      const response = await fetch("/api/hyperliquid/wallet-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || "Unable to save wallet settings")
      }
    },
  })
}
