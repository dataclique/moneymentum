import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import {
  useHyperliquidClient,
  useHyperliquidBalance,
  useHyperliquidPositions,
  useHyperliquidTickers,
  useHyperliquidLeverageLimits,
  useRebalanceHyperliquidPositions,
  useWalletSettings,
  useSwitchNetwork,
} from "./useTrading"
import { WalletProvider } from "@/contexts/WalletProvider"

// Create mock methods
const mockMethods = {
  getBalance: vi.fn(),
  getCurrentPositions: vi.fn(),
  listPerpTickers: vi.fn(),
  getLeverageLimits: vi.fn(),
  rebalancePositions: vi.fn(),
  getNetworkMode: vi.fn(),
  getPublicKey: vi.fn(),
}

// Mock the HyperliquidClient as a class
vi.mock("@/services/hyperliquid-client", () => ({
  HyperliquidClient: class MockHyperliquidClient {
    getBalance = mockMethods.getBalance
    getCurrentPositions = mockMethods.getCurrentPositions
    listPerpTickers = mockMethods.listPerpTickers
    getLeverageLimits = mockMethods.getLeverageLimits
    rebalancePositions = mockMethods.rebalancePositions
    getNetworkMode = mockMethods.getNetworkMode
    getPublicKey = mockMethods.getPublicKey
  },
}))

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>{children}</WalletProvider>
    </QueryClientProvider>
  )
}

describe("useTrading hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe("useHyperliquidClient", () => {
    it("returns null client when wallet not connected", () => {
      const { result } = renderHook(() => useHyperliquidClient(), {
        wrapper: createWrapper(),
      })

      expect(result.current.client).toBeNull()
      expect(result.current.isConnected).toBe(false)
    })

    it("returns client when wallet is connected", () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      )

      const { result } = renderHook(() => useHyperliquidClient(), {
        wrapper: createWrapper(),
      })

      expect(result.current.client).not.toBeNull()
      expect(result.current.isConnected).toBe(true)
    })

    it("returns correct network mode", () => {
      localStorage.setItem("hyperliquid-network", "mainnet")
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      )

      const { result } = renderHook(() => useHyperliquidClient(), {
        wrapper: createWrapper(),
      })

      expect(result.current.networkMode).toBe("mainnet")
    })
  })

  describe("useHyperliquidBalance", () => {
    it("does not fetch when wallet not connected", () => {
      const { result } = renderHook(() => useHyperliquidBalance(), {
        wrapper: createWrapper(),
      })

      expect(result.current.isFetching).toBe(false)
      expect(mockMethods.getBalance).not.toHaveBeenCalled()
    })

    it("fetches balance when wallet is connected", async () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      )
      mockMethods.getBalance.mockResolvedValue(1500.5)

      const { result } = renderHook(() => useHyperliquidBalance(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data).toBe(1500.5)
    })
  })

  describe("useHyperliquidPositions", () => {
    it("does not fetch when wallet not connected", () => {
      const { result } = renderHook(() => useHyperliquidPositions(), {
        wrapper: createWrapper(),
      })

      expect(result.current.isFetching).toBe(false)
      expect(mockMethods.getCurrentPositions).not.toHaveBeenCalled()
    })

    it("fetches positions and calculates percentages", async () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      )
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
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data?.positions).toHaveLength(2)
      expect(result.current.data?.totalNotional).toBe(1000)
      expect(result.current.data?.positions[0].percentage).toBe(50)
      expect(result.current.data?.positions[1].percentage).toBe(50)
    })
  })

  describe("useHyperliquidTickers", () => {
    it("fetches tickers when connected", async () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      )
      mockMethods.listPerpTickers.mockResolvedValue([
        "BTC/USDC:USDC",
        "ETH/USDC:USDC",
        "SOL/USDC:USDC",
      ])

      const { result } = renderHook(() => useHyperliquidTickers(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data).toEqual([
        "BTC/USDC:USDC",
        "ETH/USDC:USDC",
        "SOL/USDC:USDC",
      ])
    })
  })

  describe("useHyperliquidLeverageLimits", () => {
    it("fetches leverage limits when connected", async () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      )
      mockMethods.getLeverageLimits.mockResolvedValue([
        { symbol: "BTC/USDC:USDC", maxLeverage: 50 },
        { symbol: "ETH/USDC:USDC", maxLeverage: 25 },
      ])

      const { result } = renderHook(() => useHyperliquidLeverageLimits(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data).toEqual([
        { symbol: "BTC/USDC:USDC", maxLeverage: 50 },
        { symbol: "ETH/USDC:USDC", maxLeverage: 25 },
      ])
    })
  })

  describe("useRebalanceHyperliquidPositions", () => {
    it("throws error when wallet not connected", async () => {
      const { result } = renderHook(() => useRebalanceHyperliquidPositions(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate({
          budget: 1000,
          positions: [],
        })
      })

      await waitFor(() => {
        expect(result.current.isError).toBe(true)
      })

      expect(result.current.error?.message).toBe("Wallet not connected")
    })

    it("calls rebalancePositions with correct parameters", async () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      )
      mockMethods.rebalancePositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "buy",
          percentage: 0.5,
          status: "filled",
        },
      ])

      const { result } = renderHook(() => useRebalanceHyperliquidPositions(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate({
          budget: 1000,
          precise: false,
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 0.5,
              side: "buy",
              leverage: 2,
              status: "modified",
            },
          ],
        })
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(mockMethods.rebalancePositions).toHaveBeenCalledWith(
        [
          {
            symbol: "BTC/USDC:USDC",
            percentage: 0.5,
            side: "buy",
            leverage: 2,
            status: "modified",
          },
        ],
        1000,
        false, // precise parameter defaults to false
      )

      expect(result.current.data?.orders).toHaveLength(1)
      expect(result.current.data?.orders[0].status).toBe("filled")
    })

    it("converts working status to idle before sending", async () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xTestAccountAddress",
          apiWalletAddress: "0xTestApiWallet",
          privateKey: "0xTestSecret",
        }),
      )
      mockMethods.rebalancePositions.mockResolvedValue([])

      const { result } = renderHook(() => useRebalanceHyperliquidPositions(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate({
          budget: 1000,
          precise: false,
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 0.5,
              side: "buy",
              leverage: 2,
              status: "working",
            },
          ],
        })
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(mockMethods.rebalancePositions).toHaveBeenCalledWith(
        [
          {
            symbol: "BTC/USDC:USDC",
            percentage: 0.5,
            side: "buy",
            leverage: 2,
            status: "idle",
          },
        ],
        1000,
        false, // precise parameter defaults to false
      )
    })
  })

  describe("useWalletSettings", () => {
    it("returns null data when not connected", () => {
      const { result } = renderHook(() => useWalletSettings(), {
        wrapper: createWrapper(),
      })

      expect(result.current.data).toBeNull()
      expect(result.current.isConnected).toBe(false)
    })

    it("returns wallet settings when connected", () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xMyAccountAddress",
          apiWalletAddress: "0xMyApiWallet",
          privateKey: "0xMySecret",
        }),
      )
      localStorage.setItem("hyperliquid-network", "testnet")

      const { result } = renderHook(() => useWalletSettings(), {
        wrapper: createWrapper(),
      })

      expect(result.current.data?.accountAddress).toBe("0xMyAccountAddress")
      expect(result.current.data?.isTestnet).toBe(true)
      expect(result.current.isConnected).toBe(true)
    })

    it("returns mainnet when network is mainnet", () => {
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xMyAccountAddress",
          apiWalletAddress: "0xMyApiWallet",
          privateKey: "0xMySecret",
        }),
      )
      localStorage.setItem("hyperliquid-network", "mainnet")

      const { result } = renderHook(() => useWalletSettings(), {
        wrapper: createWrapper(),
      })

      expect(result.current.data?.isTestnet).toBe(false)
    })
  })

  describe("useSwitchNetwork", () => {
    it("switches to testnet", async () => {
      const { result } = renderHook(() => useSwitchNetwork(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate("testnet")
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data).toBe("testnet")
    })

    it("switches to mainnet", async () => {
      const { result } = renderHook(() => useSwitchNetwork(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate("mainnet")
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data).toBe("mainnet")
    })
  })
})
