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
  type HyperliquidClient,
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
  const {
    client,
    credentials,
    mainAddress,
    networkMode,
    connectionGeneration,
    isConnected,
  } = useWallet()
  const accountAddress = createMemo(
    () => credentials()?.accountAddress ?? mainAddress(),
  )

  return {
    client,
    credentials,
    accountAddress,
    isConnected,
    networkMode,
    connectionGeneration,
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
  const {
    client,
    accountAddress,
    networkMode,
    connectionGeneration,
    isConnected,
  } = useHyperliquidClient()

  return useQuery(() => {
    const queriedClient = client()
    const queriedAccountAddress = accountAddress()
    const queriedNetworkMode = networkMode()
    const queriedConnectionGeneration = connectionGeneration()

    return {
      queryKey: [
        ...QUERY_KEYS.balance,
        queriedAccountAddress,
        queriedNetworkMode,
        queriedConnectionGeneration,
      ],
      queryFn: () =>
        Effect.runPromise(Hyperliquid.getBalance(queriedClient)),
      enabled: isConnected() && queriedClient !== null,
      staleTime: Infinity,
    }
  })
}

export interface AccountSummary {
  accountAddress: string | null
  networkMode: NetworkMode
  connectionGeneration: number
  accountValue: number
  totalNotionalPosition: number | null
  withdrawable: number | null
  crossAccountLeverage: number | null
}

export const useHyperliquidAccountSummary = () => {
  const {
    client,
    accountAddress,
    networkMode,
    connectionGeneration,
    isConnected,
  } = useHyperliquidClient()

  return useQuery(() => {
    const queriedClient = client()
    const queriedAccountAddress = accountAddress()
    const queriedNetworkMode = networkMode()
    const queriedConnectionGeneration = connectionGeneration()

    return {
      queryKey: [
        ...QUERY_KEYS.accountSummary,
        queriedAccountAddress,
        queriedNetworkMode,
        queriedConnectionGeneration,
      ],
      queryFn: (): Promise<AccountSummary> =>
        Effect.runPromise(
          Hyperliquid.getAccountSummary(queriedClient).pipe(
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
                connectionGeneration: queriedConnectionGeneration,
                crossAccountLeverage,
              }
            }),
          ),
        ),
      enabled: isConnected() && queriedClient !== null,
      staleTime: DATA_STALE_TIME_MS,
    }
  })
}

export const useHyperliquidPositions = () => {
  const {
    client,
    accountAddress,
    networkMode,
    connectionGeneration,
    isConnected,
  } = useHyperliquidClient()

  return useQuery(() => {
    const queriedClient = client()
    const queriedAccountAddress = accountAddress()
    const queriedNetworkMode = networkMode()
    const queriedConnectionGeneration = connectionGeneration()

    return {
      queryKey: [
        ...QUERY_KEYS.positions,
        queriedAccountAddress,
        queriedNetworkMode,
        queriedConnectionGeneration,
      ],
      queryFn: () =>
        Effect.runPromise(
          Hyperliquid.getCurrentPositions(queriedClient).pipe(
            Effect.map(positions => {
              const totalNotional = positions.reduce(
                (sum, pos) => sum + pos.notional,
                0,
              )
              return {
                accountAddress: queriedAccountAddress,
                networkMode: queriedNetworkMode,
                connectionGeneration: queriedConnectionGeneration,
                positions: positions.map(pos => ({
                  ...pos,
                  percentage:
                    totalNotional > 0
                      ? (pos.notional / totalNotional) * 100
                      : 0,
                })),
                totalNotional,
              }
            }),
          ),
        ),
      enabled: isConnected() && queriedClient !== null,
      staleTime: DATA_STALE_TIME_MS,
    }
  })
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

interface SubmittedRebalance extends RebalanceParams {
  client: HyperliquidClient | null
  account: string | null
  network: NetworkMode
  connectionGeneration: number
}

export const useRebalanceHyperliquidPositions = () => {
  const {
    client,
    accountAddress,
    networkMode,
    connectionGeneration,
  } = useHyperliquidClient()
  const queryClient = useQueryClient()
  const mutation = useMutation(() => ({
    mutationFn: (submission: SubmittedRebalance) =>
      Effect.runPromise(
        Hyperliquid.rebalancePositions(
          submission.client,
          submission.actions,
        ),
      ),
    onSuccess: (_orders, submission) => {
      const { account, network, connectionGeneration: generation } = submission
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.positions, account, network, generation],
      })
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.balance, account, network, generation],
      })
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEYS.accountSummary, account, network, generation],
      })
    },
  }))

  const mutate = (
    params: RebalanceParams,
    options?: Parameters<typeof mutation.mutate>[1],
  ) => {
    mutation.mutate(
      {
        actions: params.actions,
        client: client(),
        account: accountAddress(),
        network: networkMode(),
        connectionGeneration: connectionGeneration(),
      },
      options,
    )
  }

  return {
    mutate,
    get data() {
      return mutation.data
    },
    get error() {
      return mutation.error
    },
    get isError() {
      return mutation.isError
    },
    get isPending() {
      return mutation.isPending
    },
    get isSuccess() {
      return mutation.isSuccess
    },
    get status() {
      return mutation.status
    },
  }
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
