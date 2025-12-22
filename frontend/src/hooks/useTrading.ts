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
  positions: ["hyperliquid", "positions"],
  tickers: ["hyperliquid", "tickers"],
  leverageLimits: ["hyperliquid", "leverage-limits"],
} as const

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
    staleTime: 30000,
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

      return {
        positions: positions.map(pos => ({
          ...pos,
          percentage:
            totalNotional > 0 ? (pos.notional / totalNotional) * 100 : 0,
        })),
        totalNotional,
      }
    },
    enabled: isConnected && client !== null,
    staleTime: 30000,
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
    staleTime: 60000,
  })
}

export const useHyperliquidLeverageLimits = () => {
  const { client, isConnected } = useHyperliquidClient()

  return useQuery({
    queryKey: QUERY_KEYS.leverageLimits,
    queryFn: async () => {
      if (!client) throw new Error("Wallet not connected")
      return client.getLeverageLimits()
    },
    enabled: isConnected && client !== null,
    staleTime: 60000,
  })
}

export interface RebalanceParams {
  budget: number
  positions: Array<{
    symbol: string
    percentage: number
    side: "buy" | "sell"
    leverage: number
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
        status: pos.status === "working" ? "idle" : pos.status,
      }))

      const results = await client.rebalancePositions(positions, params.budget)
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

export const useSwitchNetwork = () => {
  const { setNetworkMode } = useWallet()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (network: "testnet" | "mainnet") => {
      setNetworkMode(network)
      return Promise.resolve(network)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.balance })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.positions })
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tickers })
      void queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.leverageLimits,
      })
    },
  })
}
