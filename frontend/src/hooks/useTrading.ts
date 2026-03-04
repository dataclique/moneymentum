import { useCallback } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useWallet } from "./useWallet"
import type {
  Position,
  OrderResult,
  CurrentPosition,
  LeverageLimit,
  OrderSide,
} from "@/services/hyperliquid-client"

export type { OrderSide, OrderResult, CurrentPosition, LeverageLimit }

const QUERY_KEYS = {
  balance: ["hyperliquid", "balance"],
  accountSummary: ["hyperliquid", "account-summary"],
  positions: ["hyperliquid", "positions"],
  tickers: ["hyperliquid", "tickers"],
  leverageLimits: ["hyperliquid", "leverage-limits"],
  fundingRates: ["hyperliquid", "funding-rates"],
} as const

const DATA_STALE_TIME_MS = 30_000

export const useHyperliquidClient = () => {
  const { client, networkMode, isConnected } = useWallet()
  return { client, isConnected, networkMode }
}

export const useHyperliquidBalance = () => {
  const { client, isConnected } = useHyperliquidClient()

  return useQuery({
    queryKey: QUERY_KEYS.balance,
    queryFn: async () => {
      if (!client) throw new Error("Wallet not connected")
      return client.getBalance()
    },
    enabled: isConnected && client !== null,
    staleTime: Infinity,
  })
}

export interface AccountSummary {
  accountValue: number
  totalNotionalPosition: number
  withdrawable: number
  crossAccountLeverage: number
}

export const useHyperliquidAccountSummary = () => {
  const { client, isConnected } = useHyperliquidClient()

  return useQuery({
    queryKey: QUERY_KEYS.accountSummary,
    queryFn: async (): Promise<AccountSummary> => {
      if (!client) throw new Error("Wallet not connected")
      const summary = await client.getAccountSummary()

      const crossAccountLeverage =
        summary.accountValue > 0
          ? summary.totalNotionalPosition / summary.accountValue
          : 0

      return { ...summary, crossAccountLeverage }
    },
    enabled: isConnected && client !== null,
    staleTime: DATA_STALE_TIME_MS,
  })
}

export const useHyperliquidPositions = () => {
  const { client, isConnected } = useHyperliquidClient()

  return useQuery({
    queryKey: QUERY_KEYS.positions,
    queryFn: async () => {
      if (!client) throw new Error("Wallet not connected")

      const positions = await client.getCurrentPositions()
      const totalNotional = positions.reduce(
        (sum, pos) => sum + pos.notional,
        0,
      )
      const result = {
        positions: positions.map(pos => ({
          ...pos,
          percentage:
            totalNotional > 0 ? (pos.notional / totalNotional) * 100 : 0,
        })),
        totalNotional,
      }

      return result
    },
    enabled: isConnected && client !== null,
    staleTime: DATA_STALE_TIME_MS,
  })
}

export const useHyperliquidTickers = () => {
  const { client, isConnected } = useHyperliquidClient()

  return useQuery({
    queryKey: QUERY_KEYS.tickers,
    queryFn: async () => {
      if (!client) throw new Error("Wallet not connected")
      return client.listPerpTickers()
    },
    enabled: isConnected && client !== null,
    staleTime: DATA_STALE_TIME_MS,
  })
}

export const useHyperliquidLeverageLimits = () => {
  const { client, isConnected } = useHyperliquidClient()

  return useQuery({
    queryKey: QUERY_KEYS.leverageLimits,
    queryFn: async () => {
      if (!client) throw new Error("Wallet not connected")
      const result = await client.getLeverageLimits()

      return result
    },
    enabled: isConnected && client !== null,
    staleTime: DATA_STALE_TIME_MS,
  })
}

export const useHyperliquidFundingRates = () => {
  const { client, isConnected } = useHyperliquidClient()

  return useQuery({
    queryKey: QUERY_KEYS.fundingRates,
    queryFn: async () => {
      if (!client) throw new Error("Wallet not connected")
      return client.getFundingRates()
    },
    enabled: isConnected && client !== null,
    staleTime: DATA_STALE_TIME_MS,
  })
}

export interface RebalanceParams {
  accountValue: number
  crossAccountLeverage: number
  precise: boolean
  positions: Array<{
    symbol: string
    percentage: number
    side: "buy" | "sell"
    leverage: number
    leverageChanged: boolean
    currentNotional?: number
    currentSide?: "buy" | "sell"
    status: "untouched" | "modified" | "idle" | "deleted" | "working"
  }>
}

export const useRebalanceHyperliquidPositions = () => {
  const { client } = useHyperliquidClient()
  const queryClient = useQueryClient()

  return useMutation<{ orders: OrderResult[] }, Error, RebalanceParams>({
    mutationFn: async (params: RebalanceParams) => {
      if (!client) throw new Error("Wallet not connected")

      const positions: Position[] = params.positions.map(pos => ({
        symbol: pos.symbol,
        percentage: pos.percentage,
        side: pos.side,
        leverage: pos.leverage,
        leverageChanged: pos.leverageChanged,
        currentNotional: pos.currentNotional,
        currentSide: pos.currentSide,
        status: pos.status === "working" ? "idle" : pos.status,
      }))

      console.table(
        positions.map(position => ({
          symbol: position.symbol,
          percentage: position.percentage,
          side: position.side,
          leverage: position.leverage,
          leverageChanged: position.leverageChanged,
          currentNotional: position.currentNotional ?? "—",
          status: position.status,
        })),
      )

      const results = await client.rebalancePositions(
        positions,
        params.accountValue,
        params.crossAccountLeverage,
        params.precise,
      )

      return { orders: results }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.balance })
    },
  })
}

export const useWalletSettings = () => {
  const { credentials, networkMode, isConnected } = useWallet()

  return {
    data: isConnected
      ? {
          accountAddress: credentials?.accountAddress ?? "",
          isTestnet: networkMode === "testnet",
        }
      : null,
    isConnected,
  }
}

export const useFullHyperliquidRefresh = () => {
  const queryClient = useQueryClient()

  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.balance })
    void queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.accountSummary,
    })
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions })
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tickers })
    void queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.leverageLimits,
    })
    void queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.fundingRates,
    })
  }, [queryClient])
}

export const useSwitchNetwork = () => {
  const { setNetworkMode } = useWallet()
  const fullRefresh = useFullHyperliquidRefresh()

  return useMutation({
    mutationFn: (network: "testnet" | "mainnet") => {
      setNetworkMode(network)
      return Promise.resolve(network)
    },
    onSuccess: () => {
      fullRefresh()
      // Force a full UI reload so all React state and local storage–backed
      // portfolio snapshots are re-initialized for the new network.
      if (typeof window !== "undefined") {
        window.location.reload()
      }
    },
  })
}
