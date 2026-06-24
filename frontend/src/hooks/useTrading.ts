import { createMemo } from "solid-js"
import { useQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { useWallet } from "./useWallet"
import type {
  OrderResult,
  CurrentPosition,
  LeverageLimit,
  OrderSide,
} from "@/services/hyperliquid-client"
import type { RebalanceAction } from "@/pages/Portfolio/hooks/portfolioRebalancer"

export type { OrderSide, OrderResult, CurrentPosition, LeverageLimit }

const QUERY_KEYS = {
  balance: ["hyperliquid", "balance"],
  accountSummary: ["hyperliquid", "account-summary"],
  positions: ["hyperliquid", "positions"],
  markets: ["hyperliquid", "markets"],
  fundingRates: ["hyperliquid", "funding-rates"],
} as const

const DATA_STALE_TIME_MS = 30_000
const MARKETS_STALE_TIME_MS = 24 * 60 * 60 * 1000

export interface HyperliquidMarketsResponse {
  tickers: string[]
  leverageLimits: LeverageLimit[]
  refreshedAt: string | null
}

const fetchHyperliquidMarkets =
  async (): Promise<HyperliquidMarketsResponse> => {
    const response = await fetch(
      `${import.meta.env.BASE_URL}api/hyperliquid/markets`,
    )
    if (!response.ok) {
      throw new Error(
        `hyperliquid markets request failed: ${String(response.status)}`,
      )
    }
    return response.json() as Promise<HyperliquidMarketsResponse>
  }

export const useHyperliquidClient = () => {
  const { client, credentials, networkMode, isConnected } = useWallet()
  return { client, credentials, isConnected, networkMode }
}

export const useHyperliquidMarkets = () => {
  const { networkMode } = useWallet()

  return useQuery(() => ({
    queryKey: [...QUERY_KEYS.markets, networkMode()],
    queryFn: fetchHyperliquidMarkets,
    staleTime: MARKETS_STALE_TIME_MS,
  }))
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
      const c = client()
      if (!c) throw new Error("Wallet not connected")
      const summary = await c.getAccountSummary()

      const crossAccountLeverage =
        summary.accountValue > 0
          ? summary.totalNotionalPosition / summary.accountValue
          : 0

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
      const c = client()
      if (!c) throw new Error("Wallet not connected")

      const positions = await c.getCurrentPositions()
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
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
}

export const useHyperliquidTickers = () => {
  const marketsQuery = useHyperliquidMarkets()

  return {
    get data() {
      return marketsQuery.data?.tickers
    },
    get isLoading() {
      return marketsQuery.isLoading
    },
    get isSuccess() {
      return marketsQuery.isSuccess
    },
    get isError() {
      return marketsQuery.isError
    },
    get error() {
      return marketsQuery.error
    },
  }
}

export const useHyperliquidLeverageLimits = () => {
  const marketsQuery = useHyperliquidMarkets()

  return {
    get data() {
      return marketsQuery.data?.leverageLimits
    },
    get isLoading() {
      return marketsQuery.isLoading
    },
    get isSuccess() {
      return marketsQuery.isSuccess
    },
    get isError() {
      return marketsQuery.isError
    },
    get error() {
      return marketsQuery.error
    },
  }
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
  actions: RebalanceAction[]
}

export const useRebalanceHyperliquidPositions = () => {
  const { client, credentials, networkMode } = useHyperliquidClient()
  const queryClient = useQueryClient()

  return useMutation(() => ({
    mutationFn: async (params: RebalanceParams) => {
      const c = client()
      if (!c) throw new Error("Wallet not connected")

      const results = await c.rebalancePositions(params.actions)

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

export const useFullHyperliquidRefresh = () => {
  const queryClient = useQueryClient()

  return () => {
    void queryClient.invalidateQueries({ queryKey: ["hyperliquid"] })
  }
}

export const useSwitchNetwork = () => {
  const { setNetworkMode } = useWallet()
  const queryClient = useQueryClient()

  return useMutation(() => ({
    mutationFn: async (network: "testnet" | "mainnet") => {
      await queryClient.cancelQueries({ queryKey: ["hyperliquid"] })
      queryClient.removeQueries({ queryKey: ["hyperliquid"] })
      setNetworkMode(network)
      return network
    },
  }))
}
