import { createMemo } from "solid-js"
import { useQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
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
  const { client, credentials, networkMode, isConnected } = useWallet()
  return { client, credentials, isConnected, networkMode }
}

export const useHyperliquidBalance = () => {
  const { client, credentials, networkMode, isConnected } =
    useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [
      ...QUERY_KEYS.balance,
      credentials()?.accountAddress,
      networkMode(),
    ],
    queryFn: async () => {
      const c = client()
      if (!c) throw new Error("Wallet not connected")
      return c.getBalance()
    },
    enabled: isConnected() && client() !== null,
    staleTime: Infinity,
  }))
}

export interface AccountSummary {
  accountValue: number
  totalNotionalPosition: number
  withdrawable: number
  crossAccountLeverage: number
}

export const useHyperliquidAccountSummary = () => {
  const { client, credentials, networkMode, isConnected } =
    useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [
      ...QUERY_KEYS.accountSummary,
      credentials()?.accountAddress,
      networkMode(),
    ],
    queryFn: async (): Promise<AccountSummary> => {
      const startTime = performance.now()
      console.log("[useHyperliquidAccountSummary] queryFn started")

      const c = client()
      if (!c) throw new Error("Wallet not connected")
      const summary = await c.getAccountSummary()
      console.log(
        `[useHyperliquidAccountSummary] getAccountSummary took ${(performance.now() - startTime).toFixed(2)}ms`,
      )

      const crossAccountLeverage =
        summary.accountValue > 0
          ? summary.totalNotionalPosition / summary.accountValue
          : 0
      console.log(
        `[useHyperliquidAccountSummary] completed in ${(performance.now() - startTime).toFixed(2)}ms`,
      )
      return { ...summary, crossAccountLeverage }
    },
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
}

export const useHyperliquidPositions = () => {
  const { client, credentials, networkMode, isConnected } =
    useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [
      ...QUERY_KEYS.positions,
      credentials()?.accountAddress,
      networkMode(),
    ],
    queryFn: async () => {
      const startTime = performance.now()
      console.log("[useHyperliquidPositions] queryFn started")

      const c = client()
      if (!c) throw new Error("Wallet not connected")

      const fetchStartTime = performance.now()
      const positions = await c.getCurrentPositions()
      const fetchEndTime = performance.now()
      console.log(
        `[useHyperliquidPositions] client.getCurrentPositions() took ${(fetchEndTime - fetchStartTime).toFixed(2)}ms`,
      )

      const reduceStartTime = performance.now()
      const totalNotional = positions.reduce(
        (sum, pos) => sum + pos.notional,
        0,
      )
      const reduceEndTime = performance.now()
      console.log(
        `[useHyperliquidPositions] reduce totalNotional took ${(reduceEndTime - reduceStartTime).toFixed(2)}ms`,
      )

      const mapStartTime = performance.now()
      const result = {
        positions: positions.map(pos => ({
          ...pos,
          percentage:
            totalNotional > 0 ? (pos.notional / totalNotional) * 100 : 0,
        })),
        totalNotional,
      }
      const mapEndTime = performance.now()
      console.log(
        `[useHyperliquidPositions] map positions took ${(mapEndTime - mapStartTime).toFixed(2)}ms`,
      )

      const endTime = performance.now()
      console.log(
        `[useHyperliquidPositions] queryFn completed in ${(endTime - startTime).toFixed(2)}ms`,
      )

      return result
    },
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
}

export const useHyperliquidTickers = () => {
  const { client, networkMode, isConnected } = useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [...QUERY_KEYS.tickers, networkMode()],
    queryFn: async () => {
      const c = client()
      if (!c) throw new Error("Wallet not connected")
      return c.listPerpTickers()
    },
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
}

export const useHyperliquidLeverageLimits = () => {
  const { client, networkMode, isConnected } = useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [...QUERY_KEYS.leverageLimits, networkMode()],
    queryFn: async () => {
      const startTime = performance.now()
      console.log("[useHyperliquidLeverageLimits] queryFn started")

      const c = client()
      if (!c) throw new Error("Wallet not connected")
      const result = await c.getLeverageLimits()

      console.log(
        `[useHyperliquidLeverageLimits] completed in ${(performance.now() - startTime).toFixed(2)}ms`,
      )
      return result
    },
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
}

export const useHyperliquidFundingRates = () => {
  const { client, networkMode, isConnected } = useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [...QUERY_KEYS.fundingRates, networkMode()],
    queryFn: async () => {
      const c = client()
      if (!c) throw new Error("Wallet not connected")
      return c.getFundingRates()
    },
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
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
  const { client, credentials, networkMode } = useHyperliquidClient()
  const queryClient = useQueryClient()

  return useMutation(() => ({
    mutationFn: async (params: RebalanceParams) => {
      const mutationStartTime = performance.now()
      console.log("[Rebalance] mutationFn started", {
        timestamp: new Date().toISOString(),
      })

      const c = client()
      if (!c) throw new Error("Wallet not connected")

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

      console.log(
        "%c[Rebalance] Positions data:",
        "background: purple; color: white; padding: 2px 6px; border-radius: 3px",
      )
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

      console.log("[Rebalance] Calling client.rebalancePositions()", {
        positionCount: positions.length,
      })
      const clientCallTime = performance.now()

      const results = await c.rebalancePositions(
        positions,
        params.accountValue,
        params.crossAccountLeverage,
        params.precise,
      )

      const endTime = performance.now()
      console.log("[Rebalance] mutationFn completed", {
        totalTime: `${(endTime - mutationStartTime).toFixed(2)}ms`,
        clientTime: `${(endTime - clientCallTime).toFixed(2)}ms`,
        resultsCount: results.length,
      })

      return { orders: results }
    },
    onSuccess: () => {
      const account = credentials()?.accountAddress
      const network = networkMode()
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.positions, account, network],
      })
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.balance, account, network],
      })
    },
  }))
}

export const useWalletSettings = () => {
  const { credentials, networkMode, isConnected } = useWallet()

  const data = createMemo(() => {
    if (!isConnected()) return null
    return {
      accountAddress: credentials()?.accountAddress ?? "",
      isTestnet: networkMode() === "testnet",
    }
  })

  return { data, isConnected }
}

export const useSwitchNetwork = () => {
  const { setNetworkMode } = useWallet()
  const queryClient = useQueryClient()

  return useMutation(() => ({
    mutationFn: (network: "testnet" | "mainnet") => {
      setNetworkMode(network)
      return Promise.resolve(network)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hyperliquid"] })
    },
  }))
}
