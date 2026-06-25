import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ParentProps } from "solid-js"
import { onMount } from "solid-js"
import {
  useHyperliquidClient,
  useHyperliquidBalance,
  useHyperliquidPositions,
  useHyperliquidTickers,
  useHyperliquidLeverageLimits,
  useRebalanceHyperliquidPositions,
  useWalletSettings,
  useSwitchNetwork,
  marketsRemainingStaleTimeMs,
} from "./useTrading"
import { MARKETS_MAX_AGE_MS } from "@/services/hyperliquid-client"
import { WalletProvider } from "@/contexts/WalletProvider"
import { useWallet } from "@/hooks/useWallet"

// Create mock methods
const mockMethods = {
  getBalance: vi.fn(),
  getAccountSummary: vi.fn(),
  getFundingRates: vi.fn(),
  getCurrentPositions: vi.fn(),
  rebalancePositions: vi.fn(),
  getNetworkMode: vi.fn(),
  getWalletAddress: vi.fn(),
}

const mockMarketsResponse = {
  tickers: ["BTC/USDC:USDC", "ETH/USDC:USDC", "SOL/USDC:USDC"],
  leverageLimits: [
    { symbol: "BTC/USDC:USDC", maxLeverage: 50, assetIndex: 0 },
    { symbol: "ETH/USDC:USDC", maxLeverage: 25, assetIndex: 1 },
  ],
  refreshedAt: new Date().toISOString(),
  marketsMaxAgeMs: MARKETS_MAX_AGE_MS,
}

// Mock the HyperliquidClient as a class; keep real fetchHyperliquidMarkets.
vi.mock("@/services/hyperliquid-client", async importOriginal => {
  const actual =
    await importOriginal<typeof import("@/services/hyperliquid-client")>()
  return {
    ...actual,
    HyperliquidClient: class MockHyperliquidClient {
      getBalance = mockMethods.getBalance
      getAccountSummary = mockMethods.getAccountSummary
      getFundingRates = mockMethods.getFundingRates
      getCurrentPositions = mockMethods.getCurrentPositions
      rebalancePositions = mockMethods.rebalancePositions
      getNetworkMode = mockMethods.getNetworkMode
      getWalletAddress = mockMethods.getWalletAddress
    },
  }
})

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return (props: ParentProps) => (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>{props.children}</WalletProvider>
    </QueryClientProvider>
  )
}

const createConnectedWrapper = (walletCredentials: {
  accountAddress: string
  apiWalletAddress: string
  privateKey: string
  vaultAddress?: string
}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const ConnectOnMount = (props: ParentProps) => {
    const { connect } = useWallet()
    onMount(() => {
      connect(walletCredentials)
    })
    return <>{props.children}</>
  }
  return (props: ParentProps) => (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <ConnectOnMount>{props.children}</ConnectOnMount>
      </WalletProvider>
    </QueryClientProvider>
  )
}

describe("useTrading hooks", () => {
  const ensureLocalStorage = () => {
    const globalAny = globalThis as { localStorage?: Storage }
    if (
      !globalAny.localStorage ||
      typeof globalAny.localStorage.clear !== "function"
    ) {
      const store = new Map<string, string>()
      globalAny.localStorage = {
        getItem: key => (store.has(key) ? store.get(key)! : null),
        setItem: (key, value) => {
          store.set(key, value)
        },
        removeItem: key => {
          store.delete(key)
        },
        clear: () => {
          store.clear()
        },
        key: index => Array.from(store.keys())[index] ?? null,
        get length() {
          return store.size
        },
      } as unknown as Storage
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ensureLocalStorage()
    localStorage.clear()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async input => {
        const url = String(input)
        if (!url.includes("network=testnet")) {
          throw new Error(`expected testnet markets fetch, got ${url}`)
        }
        return {
          ok: true,
          headers: new Headers({ "cache-control": "public, max-age=86400" }),
          json: async () => mockMarketsResponse,
        }
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    ensureLocalStorage()
    localStorage.clear()
  })

  describe("useHyperliquidClient", () => {
    it("returns null client when wallet not connected", () => {
      const { result } = renderHook(() => useHyperliquidClient(), {
        wrapper: createWrapper(),
      })

      expect(result.client()).toBeNull()
      expect(result.isConnected()).toBe(false)
    })

    it("returns client when wallet is connected", () => {
      const { result } = renderHook(() => useHyperliquidClient(), {
        wrapper: createConnectedWrapper({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      })

      expect(result.client()).not.toBeNull()
      expect(result.isConnected()).toBe(true)
    })

    it("returns correct network mode", () => {
      localStorage.setItem("hyperliquid-network", "mainnet")

      const { result } = renderHook(() => useHyperliquidClient(), {
        wrapper: createConnectedWrapper({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      })

      expect(result.networkMode()).toBe("mainnet")
    })
  })

  describe("useHyperliquidBalance", () => {
    it("does not fetch when wallet not connected", () => {
      const { result } = renderHook(() => useHyperliquidBalance(), {
        wrapper: createWrapper(),
      })

      expect(result.isFetching).toBe(false)
      expect(mockMethods.getBalance).not.toHaveBeenCalled()
    })

    it("fetches balance when wallet is connected", async () => {
      mockMethods.getBalance.mockResolvedValue(1500.5)

      const { result } = renderHook(() => useHyperliquidBalance(), {
        wrapper: createConnectedWrapper({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      })

      await waitFor(() => {
        expect(result.isSuccess).toBe(true)
      })

      expect(result.data).toBe(1500.5)
    })
  })

  describe("useHyperliquidPositions", () => {
    it("does not fetch when wallet not connected", () => {
      const { result } = renderHook(() => useHyperliquidPositions(), {
        wrapper: createWrapper(),
      })

      expect(result.isFetching).toBe(false)
      expect(mockMethods.getCurrentPositions).not.toHaveBeenCalled()
    })

    it("fetches positions and calculates percentages", async () => {
      mockMethods.getCurrentPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "buy",
          notional: 500,
          entryPrice: 45000,
          unrealizedPnl: 50,
          leverage: 2,
        },
        {
          symbol: "ETH/USDC:USDC",
          side: "sell",
          notional: 500,
          entryPrice: 3000,
          unrealizedPnl: -25,
          leverage: 1,
        },
      ])

      const { result } = renderHook(() => useHyperliquidPositions(), {
        wrapper: createConnectedWrapper({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      })

      await waitFor(() => {
        expect(result.isSuccess).toBe(true)
      })

      expect(result.data?.positions).toHaveLength(2)
      expect(result.data?.totalNotional).toBe(1000)
      expect(result.data?.positions[0].percentage).toBe(50)
      expect(result.data?.positions[1].percentage).toBe(50)
    })
  })

  describe("marketsRemainingStaleTimeMs", () => {
    it("returns remaining time until markets max age expires", () => {
      const refreshedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      const remaining = marketsRemainingStaleTimeMs(
        { tickers: [], leverageLimits: [], refreshedAt },
        MARKETS_MAX_AGE_MS,
      )

      expect(remaining).toBeGreaterThan(MARKETS_MAX_AGE_MS - 2 * 60 * 60 * 1000)
      expect(remaining).toBeLessThanOrEqual(MARKETS_MAX_AGE_MS - 60 * 60 * 1000)
    })

    it("returns zero when markets data is already past max age", () => {
      const refreshedAt = new Date(
        Date.now() - MARKETS_MAX_AGE_MS - 1000,
      ).toISOString()

      expect(
        marketsRemainingStaleTimeMs(
          { tickers: [], leverageLimits: [], refreshedAt },
          MARKETS_MAX_AGE_MS,
        ),
      ).toBe(0)
    })
  })

  describe("useHyperliquidTickers", () => {
    it("fetches tickers from backend markets endpoint", async () => {
      const { result } = renderHook(() => useHyperliquidTickers(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.isSuccess).toBe(true)
      })

      expect(result.data).toEqual([
        "BTC/USDC:USDC",
        "ETH/USDC:USDC",
        "SOL/USDC:USDC",
      ])
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/hyperliquid/markets?network=testnet",
      )
    })
  })

  describe("useHyperliquidLeverageLimits", () => {
    it("fetches leverage limits from backend markets endpoint", async () => {
      const { result } = renderHook(() => useHyperliquidLeverageLimits(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.isSuccess).toBe(true)
      })

      expect(result.data).toEqual([
        { symbol: "BTC/USDC:USDC", maxLeverage: 50, assetIndex: 0 },
        { symbol: "ETH/USDC:USDC", maxLeverage: 25, assetIndex: 1 },
      ])
    })
  })

  describe("useRebalanceHyperliquidPositions", () => {
    it("throws error when wallet not connected", async () => {
      const { result } = renderHook(() => useRebalanceHyperliquidPositions(), {
        wrapper: createWrapper(),
      })

      result.mutate({
        actions: [],
      })

      await waitFor(() => {
        expect(result.isError).toBe(true)
      })

      expect(result.error?.message).toBe("Wallet not connected")
    })

    it("calls rebalancePositions with correct parameters", async () => {
      mockMethods.rebalancePositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "buy",
          status: "filled",
        },
      ])

      const { result } = renderHook(() => useRebalanceHyperliquidPositions(), {
        wrapper: createConnectedWrapper({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      })

      result.mutate({
        actions: [
          {
            kind: "rebalance",
            symbol: "BTC/USDC:USDC",
            signedNotionalDelta: 120,
            leverage: 2,
            leverageChanged: false,
          },
        ],
      })

      await waitFor(() => {
        expect(result.isSuccess).toBe(true)
      })

      expect(mockMethods.rebalancePositions).toHaveBeenCalledWith([
        {
          kind: "rebalance",
          symbol: "BTC/USDC:USDC",
          signedNotionalDelta: 120,
          leverage: 2,
          leverageChanged: false,
        },
      ])

      expect(result.data?.orders).toHaveLength(1)
      expect(result.data?.orders[0].status).toBe("filled")
    })

    it("calls rebalancePositions with only the actions array (no separate precise arg)", async () => {
      mockMethods.rebalancePositions.mockResolvedValue([
        { symbol: "ETH/USDC:USDC", side: "sell", status: "working" },
      ])

      const { result } = renderHook(() => useRebalanceHyperliquidPositions(), {
        wrapper: createConnectedWrapper({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      })

      result.mutate({
        actions: [
          {
            kind: "close",
            symbol: "BTC/USDC:USDC",
            side: "buy",
          },
        ],
      })

      await waitFor(() => {
        expect(result.isSuccess).toBe(true)
      })

      expect(mockMethods.rebalancePositions).toHaveBeenCalledWith([
        {
          kind: "close",
          symbol: "BTC/USDC:USDC",
          side: "buy",
        },
      ])
      expect(mockMethods.rebalancePositions).toHaveBeenCalledTimes(1)
    })
  })

  describe("useWalletSettings", () => {
    it("returns null data when not connected", () => {
      const { result } = renderHook(() => useWalletSettings(), {
        wrapper: createWrapper(),
      })

      expect(result.data()).toBeNull()
      expect(result.isConnected()).toBe(false)
    })

    it("returns wallet settings when connected", () => {
      localStorage.setItem("hyperliquid-network", "testnet")

      const { result } = renderHook(() => useWalletSettings(), {
        wrapper: createConnectedWrapper({
          accountAddress: "0xMyAccountAddress",
          apiWalletAddress: "0xMyApiWallet",
          privateKey: "0xMySecret",
        }),
      })

      expect(result.data()?.accountAddress).toBe("0xMyAccountAddress")
      expect(result.data()?.isTestnet).toBe(true)
      expect(result.isConnected()).toBe(true)
    })

    it("returns mainnet when network is mainnet", () => {
      localStorage.setItem("hyperliquid-network", "mainnet")

      const { result } = renderHook(() => useWalletSettings(), {
        wrapper: createConnectedWrapper({
          accountAddress: "0xMyAccountAddress",
          apiWalletAddress: "0xMyApiWallet",
          privateKey: "0xMySecret",
        }),
      })

      expect(result.data()?.isTestnet).toBe(false)
    })
  })

  describe("useSwitchNetwork", () => {
    it("switches to testnet", async () => {
      const { result } = renderHook(() => useSwitchNetwork(), {
        wrapper: createWrapper(),
      })

      result.mutate("testnet")

      await waitFor(() => {
        expect(result.isSuccess).toBe(true)
      })

      expect(result.data).toBe("testnet")
    })

    it("switches to mainnet", async () => {
      const { result } = renderHook(() => useSwitchNetwork(), {
        wrapper: createWrapper(),
      })

      result.mutate("mainnet")

      await waitFor(() => {
        expect(result.isSuccess).toBe(true)
      })

      expect(result.data).toBe("mainnet")
    })
  })
})
