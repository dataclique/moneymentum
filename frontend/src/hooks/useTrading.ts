import * as Effect from "effect/Effect"
import { createMemo } from "solid-js"
import { useQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import { useWallet } from "./useWallet"
import {
  fetchHyperliquidMarkets,
  millisecondsUntilNextUtcMidnight,
  type OrderResult,
  type CurrentPosition,
  type LeverageLimit,
  type OrderSide,
  type HyperliquidMarketsResponse,
} from "@/services/hyperliquid-client"
import * as Hyperliquid from "@/services/hyperliquid"
import type { RebalanceAction } from "@/pages/Portfolio/hooks/portfolioRebalancer"
import type { NetworkMode } from "@/contexts/wallet-context"

export type {
  OrderSide,
  OrderResult,
  CurrentPosition,
  LeverageLimit,
  HyperliquidMarketsResponse,
}

const QUERY_KEYS = {
  balance: ["hyperliquid", "balance"],
  accountSummary: ["hyperliquid", "account-summary"],
  positions: ["hyperliquid", "positions"],
  markets: ["hyperliquid", "markets"],
  fundingRates: ["hyperliquid", "funding-rates"],
} as const

const DATA_STALE_TIME_MS = 30_000

export const useHyperliquidClient = () => {
  const { client, credentials, mainAddress, networkMode, isConnected } =
    useWallet()
  const accountAddress = createMemo(
    () => credentials()?.accountAddress ?? mainAddress(),
  )

  return {
    client,
    credentials,
    accountAddress,
    isConnected,
    networkMode,
  }
}

export const useHyperliquidMarkets = () => {
  const { networkMode } = useHyperliquidClient()
  const network = createMemo(() => networkMode())

  return useQuery(() => {
    const marketsCacheDurationMs = millisecondsUntilNextUtcMidnight()

    return {
      queryKey: [...QUERY_KEYS.markets, network()],
      queryFn: () => fetchHyperliquidMarkets(network()),
      staleTime: marketsCacheDurationMs,
      gcTime: marketsCacheDurationMs,
    }
  })
}

export const useHyperliquidBalance = () => {
  const { client, accountAddress, networkMode, isConnected } =
    useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [...QUERY_KEYS.balance, accountAddress(), networkMode()],
    queryFn: () => Effect.runPromise(Hyperliquid.getBalance(client())),
    enabled: isConnected() && client() !== null,
    staleTime: Infinity,
  }))
}

export interface AccountSummary {
  accountAddress: string | null
  networkMode: NetworkMode
  accountValue: number
  totalNotionalPosition: number | null
  withdrawable: number | null
  crossAccountLeverage: number | null
}

export const useHyperliquidAccountSummary = () => {
  const { client, accountAddress, networkMode, isConnected } =
    useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [...QUERY_KEYS.accountSummary, accountAddress(), networkMode()],
    queryFn: (): Promise<AccountSummary> => {
      const queriedAccountAddress = accountAddress()
      const queriedNetworkMode = networkMode()

      return Effect.runPromise(
        Hyperliquid.getAccountSummary(client()).pipe(
          Effect.map(summary => {
            const crossAccountLeverage =
              summary.accountValue > 0 &&
              summary.totalNotionalPosition !== null
                ? summary.totalNotionalPosition / summary.accountValue
                : null
            return {
              ...summary,
              accountAddress: queriedAccountAddress,
              networkMode: queriedNetworkMode,
              crossAccountLeverage,
            }
          }),
        ),
      )
    },
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
}

export const useHyperliquidPositions = () => {
  const { client, accountAddress, networkMode, isConnected } =
    useHyperliquidClient()

  return useQuery(() => ({
    queryKey: [...QUERY_KEYS.positions, accountAddress(), networkMode()],
    queryFn: () => {
      const queriedAccountAddress = accountAddress()
      const queriedNetworkMode = networkMode()

      return Effect.runPromise(
        Hyperliquid.getCurrentPositions(client()).pipe(
          Effect.map(positions => {
            const totalNotional = positions.reduce(
              (sum, pos) => sum + pos.notional,
              0,
            )
            return {
              accountAddress: queriedAccountAddress,
              networkMode: queriedNetworkMode,
              positions: positions.map(pos => ({
                ...pos,
                percentage:
                  totalNotional > 0 ? (pos.notional / totalNotional) * 100 : 0,
              })),
              totalNotional,
            }
          }),
        ),
      )
    },
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
}

export const useHyperliquidTickers = () => {
  const marketsQuery = useHyperliquidMarkets()
  const tickers = createMemo(() => marketsQuery.data?.tickers)

  return {
    get data() {
      return tickers()
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
  const leverageLimits = createMemo(() => marketsQuery.data?.leverageLimits)

  return {
    get data() {
      return leverageLimits()
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
    queryFn: () => Effect.runPromise(Hyperliquid.getFundingRates(client())),
    enabled: isConnected() && client() !== null,
    staleTime: DATA_STALE_TIME_MS,
  }))
}

export interface RebalanceParams {
  actions: RebalanceAction[]
}

export const useRebalanceHyperliquidPositions = () => {
  const { client, accountAddress, networkMode } = useHyperliquidClient()
  const queryClient = useQueryClient()

  return useMutation(() => ({
    mutationFn: (params: RebalanceParams) =>
      Effect.runPromise(
        Hyperliquid.rebalancePositions(client(), params.actions),
      ),
    onMutate: () => ({
      account: accountAddress(),
      network: networkMode(),
    }),
    onSuccess: (_orders, _params, submittedAccount) => {
      const { account, network } = submittedAccount
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.positions, account, network],
      })
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.balance, account, network],
      })
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.accountSummary, account, network],
      })
    },
  }))
}

export const useWalletSettings = () => {
  const { credentials, mainAddress, networkMode, isConnected } = useWallet()

  const data = createMemo(() => {
    if (!isConnected()) return null
    return {
      accountAddress: credentials()?.accountAddress ?? mainAddress() ?? "",
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
      setNetworkMode(network)
      await queryClient.invalidateQueries({ queryKey: ["hyperliquid"] })
      return network
    },
  }))
}
