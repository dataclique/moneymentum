import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import { MIN_USD, usePortfolioState } from "./usePortfolioState"
import {
  useHyperliquidAccountSummary,
  useHyperliquidPositions,
} from "@/hooks/useTrading"

vi.mock("@/hooks/useTrading", () => ({
  useHyperliquidAccountSummary: vi.fn(() => ({
    data: {
      accountValue: 1000,
      totalNotionalPosition: 0,
      withdrawable: 1000,
      crossAccountLeverage: 0,
    },
    isLoading: false,
  })),
  useHyperliquidPositions: vi.fn(() => ({
    data: { positions: [], totalNotional: 0 },
    isLoading: false,
  })),
  useHyperliquidLeverageLimits: vi.fn(() => ({
    data: [{ symbol: "BTC/USDC:USDC", maxLeverage: 50 }],
  })),
  useRebalanceHyperliquidPositions: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}))

// Mock useNetwork hook
vi.mock("@/hooks/useNetwork", () => ({
  useNetwork: vi.fn(() => ({
    setIsNetworkSwitching: vi.fn(),
  })),
}))

// Mock useWallet hook
vi.mock("@/hooks/useWallet", () => ({
  useWallet: vi.fn(() => ({
    networkMode: "testnet",
    credentials: null,
    isConnected: false,
  })),
}))

// Storage key is network-aware, so use the testnet key for tests
const STORAGE_KEY = "portfolio-allocation-state-testnet"

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe("usePortfolioState", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  describe("constants", () => {
    it("exports correct MIN_USD", () => {
      expect(MIN_USD).toBe(11)
    })
  })

  describe("initial state", () => {
    it("returns empty selectedTokens when no stored data", () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      expect(result.current.selectedTokens).toEqual([])
      expect(result.current.activeTokens).toEqual([])
    })

    it("returns disableSubmit true when no tokens selected", () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      expect(result.current.disableSubmit).toBe(true)
    })

    it("returns zero netExposure when no tokens", () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      expect(result.current.netExposure).toBe(0)
    })
  })

  describe("handleAddToken", () => {
    it("adds a new token with default values", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens).toHaveLength(1)
      expect(result.current.selectedTokens[0].symbol).toBe("BTC/USDC:USDC")
      expect(result.current.selectedTokens[0].side).toBe("buy")
      expect(result.current.selectedTokens[0].leverage).toBe(1)
      expect(result.current.selectedTokens[0].status).toBe("idle")
    })

    it("does not add duplicate tokens", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens).toHaveLength(1)
    })
  })

  describe("handleRemoveToken", () => {
    it("removes token that was not in initial portfolio", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens).toHaveLength(1)

      await act(async () => {
        result.current.handleRemoveToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens).toHaveLength(0)
    })
  })

  describe("handleSideChange", () => {
    it("changes token side from buy to sell", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens[0].side).toBe("buy")

      await act(async () => {
        result.current.handleSideChange("BTC/USDC:USDC", "sell")
      })

      expect(result.current.selectedTokens[0].side).toBe("sell")
    })
  })

  describe("handleLeverageChange", () => {
    it("changes token leverage within limits", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens[0].leverage).toBe(1)

      await act(async () => {
        result.current.handleLeverageChange("BTC/USDC:USDC", 5)
      })

      expect(result.current.selectedTokens[0].leverage).toBe(5)
    })

    it("clamps leverage to minimum of 1", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await act(async () => {
        result.current.handleLeverageChange("BTC/USDC:USDC", 0)
      })

      expect(result.current.selectedTokens[0].leverage).toBe(1)
    })
  })

  describe("netExposure calculation", () => {
    it("calculates positive exposure for long positions", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // Token should be added with buy side
      expect(result.current.selectedTokens[0].side).toBe("buy")
      expect(result.current.netExposure).toBeGreaterThan(0)
    })

    it("calculates negative exposure for short positions", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await act(async () => {
        result.current.handleSideChange("BTC/USDC:USDC", "sell")
      })

      expect(result.current.netExposure).toBeLessThan(0)
    })
  })

  describe("remainingPercent", () => {
    it("returns 100 when no tokens are allocated", () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      expect(result.current.remainingPercent).toBe(100)
    })
  })

  describe("localStorage persistence", () => {
    it("persists tokens to localStorage", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // Wait for localStorage to be updated
      await waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).not.toBeNull()
      })

      const storedRaw = localStorage.getItem(STORAGE_KEY)
      const stored = JSON.parse(storedRaw ?? "{}")
      expect(stored.tokens).toHaveLength(1)
      expect(stored.tokens[0].symbol).toBe("BTC/USDC:USDC")
    })

    it("persists crossAccountLeverage to localStorage when leverage changes", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleCrossAccountLeverageChange(2.5)
      })

      await waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).not.toBeNull()
        const parsed = JSON.parse(stored ?? "{}")
        expect(parsed.crossAccountLeverage).toBe(2.5)
      })
    })

    it("persists token modifications to localStorage", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await act(async () => {
        result.current.handleSideChange("BTC/USDC:USDC", "sell")
      })

      await act(async () => {
        result.current.handleLeverageChange("BTC/USDC:USDC", 5)
      })

      await waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        const parsed = JSON.parse(stored ?? "{}")
        expect(parsed.tokens[0].side).toBe("sell")
        expect(parsed.tokens[0].leverage).toBe(5)
      })
    })
  })

  describe("activeTokens filtering", () => {
    it("excludes deleted tokens from activeTokens", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      expect(result.current.activeTokens).toHaveLength(1)

      await act(async () => {
        result.current.handleRemoveToken("BTC/USDC:USDC")
      })

      // Token was not in initial portfolio so it gets removed completely
      expect(result.current.activeTokens).toHaveLength(0)
      expect(result.current.selectedTokens).toHaveLength(0)
    })
  })

  describe("blockingReasons", () => {
    it("returns empty array when no blocking issues", () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      expect(result.current.blockingReasons).toEqual([])
    })
  })

  describe("budgetForUi behavior", () => {
    it("uses effectiveBudget when accountValue and leverage are set", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // accountValue = 1000, crossAccountLeverage = 1, effectiveBudget = 1000
      expect(result.current.budgetForUi).toBe(1000)

      await act(async () => {
        result.current.handleCrossAccountLeverageChange(2)
      })

      // effectiveBudget = 1000 * 2 = 2000
      expect(result.current.budgetForUi).toBe(2000)
    })

    it("returns 0 when no account value and no tokens", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 0,
          totalNotionalPosition: 0,
          withdrawable: 0,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // No accountValue and no tokens
      expect(result.current.budgetForUi).toBe(0)
    })

    it("uses minimum required budget when effectiveBudget is zero but tokens exist", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 0,
          totalNotionalPosition: 0,
          withdrawable: 0,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // budgetForUi should fall back to MIN_USD when effectiveBudget is 0
      await waitFor(() => {
        expect(result.current.budgetForUi).toBeGreaterThanOrEqual(MIN_USD)
      })
    })
  })

  describe("localStorage initialization useEffect", () => {
    it("initializes crossAccountLeverage from exchange, ignoring localStorage value", async () => {
      // localStorage has leverage 2.5, but exchange has leverage 1.5
      // The exchange value should be used
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          crossAccountLeverage: 2.5,
          tokens: [],
        }),
      )

      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 1500,
          withdrawable: 1000,
          crossAccountLeverage: 1.5,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Should use exchange leverage (1.5), not localStorage (2.5)
      await waitFor(() => {
        expect(result.current.crossAccountLeverage).toBe(1.5)
      })
    })

    it("initializes tokens from localStorage with idle status (can be submitted)", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          crossAccountLeverage: 1,
          tokens: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              lockedUsd: 250,
              status: "idle",
            },
          ],
        }),
      )

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })
      expect(result.current.selectedTokens[0].symbol).toBe("BTC/USDC:USDC")
      // Tokens from localStorage (no exchange data to compare) should be "idle" so they can be rebalanced
      expect(result.current.selectedTokens[0].status).toBe("idle")
      expect(result.current.selectedTokens[0].leverage).toBe(2)
    })

    it("sets default leverage of 1 when not specified in stored data", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          crossAccountLeverage: 1,
          tokens: [
            {
              symbol: "ETH/USDC:USDC",
              percentage: 30,
              side: "sell",
              lockedUsd: 150,
              status: "idle",
            },
          ],
        }),
      )

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })
      expect(result.current.selectedTokens[0].leverage).toBe(1)
    })
  })

  describe("accountValue from account summary", () => {
    it("derives accountValue from account summary", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 2000,
          totalNotionalPosition: 0,
          withdrawable: 2000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.accountValue).toBe(2000)
      })
    })
  })

  describe("exchange positions loading useEffect", () => {
    it("loads positions from exchange when no localStorage data exists", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "SOL/USDC:USDC",
              percentage: 40,
              side: "buy",
              leverage: 3,
              notional: 400,
            },
          ],
          totalNotional: 400,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })
      expect(result.current.selectedTokens[0].symbol).toBe("SOL/USDC:USDC")
      expect(result.current.selectedTokens[0].notional).toBe(400)
    })

    it("sets initialPortfolio when loading from exchange", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "SOL/USDC:USDC",
              percentage: 40,
              side: "buy",
              leverage: 3,
              notional: 400,
            },
          ],
          totalNotional: 400,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })
      // The token should have status untouched since initialPortfolio is set
      expect(result.current.selectedTokens[0].status).toBe("untouched")
    })
  })

  describe("token status update useEffect", () => {
    it("sets initial tokens to untouched status when loaded from exchange", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Initially should be untouched when loaded from exchange
      expect(result.current.selectedTokens[0].status).toBe("untouched")
    })

    it("preserves token side when changed", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      expect(result.current.selectedTokens[0].side).toBe("buy")

      await act(async () => {
        result.current.handleSideChange("BTC/USDC:USDC", "sell")
      })

      expect(result.current.selectedTokens[0].side).toBe("sell")
    })

    it("preserves token leverage when changed", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      expect(result.current.selectedTokens[0].leverage).toBe(2)

      await act(async () => {
        result.current.handleLeverageChange("BTC/USDC:USDC", 5)
      })

      expect(result.current.selectedTokens[0].leverage).toBe(5)
    })

    it("adds new token with idle status", async () => {
      // Ensure no positions load from exchange that would set untouched status
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("NEW/USDC:USDC")
      })

      expect(result.current.selectedTokens[0].status).toBe("idle")
    })
  })

  describe("percentage recalculation when leverage changes", () => {
    it("recalculates percentages when crossAccountLeverage changes", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // With accountValue = 1000 and leverage = 1, effectiveBudget = 1000
      // Token gets MIN_USD = 11, percentage = (11/1000)*100 = 1.1%
      const initialPercentage = result.current.selectedTokens[0].percentage

      await act(async () => {
        result.current.handleCrossAccountLeverageChange(2)
      })

      await waitFor(() => {
        // With leverage = 2, effectiveBudget = 2000
        // lockedUsd stays at 11, percentage = (11/2000)*100 = 0.55%
        expect(result.current.selectedTokens[0].percentage).toBeLessThan(
          initialPercentage,
        )
      })
    })

    it("enforces minimum percentage based on MIN_USD", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // MIN_USD is 11, so min percentage = (11/1000)*100 = 1.1%
      await waitFor(() => {
        expect(
          result.current.selectedTokens[0].percentage,
        ).toBeGreaterThanOrEqual(1.1)
      })
    })
  })

  describe("handleRemoveToken with initialPortfolio", () => {
    it("marks token as deleted when it was in initialPortfolio", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      await act(async () => {
        result.current.handleRemoveToken("BTC/USDC:USDC")
      })

      // Should be marked as deleted, not removed
      expect(result.current.selectedTokens).toHaveLength(1)
      expect(result.current.selectedTokens[0].status).toBe("deleted")
      expect(result.current.selectedTokens[0].percentage).toBe(0)
    })

    it("removes token completely when it was not in initialPortfolio", async () => {
      // Ensure no positions load from exchange
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("NEW/USDC:USDC")
      })

      expect(result.current.selectedTokens).toHaveLength(1)

      await act(async () => {
        result.current.handleRemoveToken("NEW/USDC:USDC")
      })

      // Should be completely removed
      expect(result.current.selectedTokens).toHaveLength(0)
    })

    it("marks token as deleted when loaded from localStorage with notional (exchange position)", async () => {
      // Simulate token loaded from localStorage that has a notional value
      // This means it exists on the exchange and should be closed, not just removed from UI
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          budget: 500,
          tokens: [
            {
              symbol: "ASTER/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 3,
              lockedUsd: 50,
              notional: 50, // Has exchange position
              status: "idle",
            },
          ],
        }),
      )

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      await act(async () => {
        result.current.handleRemoveToken("ASTER/USDC:USDC")
      })

      // Should be marked as deleted (not removed) so the exchange position gets closed
      expect(result.current.selectedTokens).toHaveLength(1)
      expect(result.current.selectedTokens[0].status).toBe("deleted")
      expect(result.current.selectedTokens[0].percentage).toBe(0)
    })

    it("completely removes token from localStorage without notional (no exchange position)", async () => {
      // Simulate a new token added locally but never synced to exchange
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          budget: 500,
          tokens: [
            {
              symbol: "NEW/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 1,
              lockedUsd: 50,
              // No notional - doesn't exist on exchange
              status: "idle",
            },
          ],
        }),
      )

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      await act(async () => {
        result.current.handleRemoveToken("NEW/USDC:USDC")
      })

      // Should be completely removed since it doesn't exist on exchange
      expect(result.current.selectedTokens).toHaveLength(0)
    })
  })

  describe("handleUndoRemoveToken", () => {
    it("restores deleted token with previous percentage", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      const originalPercentage = result.current.selectedTokens[0].percentage

      await act(async () => {
        result.current.handleRemoveToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens[0].status).toBe("deleted")

      await act(async () => {
        result.current.handleUndoRemoveToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens[0].status).toBe("untouched")
      expect(result.current.selectedTokens[0].percentage).toBe(
        originalPercentage,
      )
    })
  })

  describe("hasPendingDeletions", () => {
    it("returns true when there are deleted tokens", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      expect(result.current.hasPendingDeletions).toBe(false)

      await act(async () => {
        result.current.handleRemoveToken("BTC/USDC:USDC")
      })

      expect(result.current.hasPendingDeletions).toBe(true)
    })
  })

  describe("token status derivation", () => {
    it("sets status to modified when lockedUsd changes from initial", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      expect(result.current.selectedTokens[0].status).toBe("untouched")

      // Change the slider value (changes lockedUsd)
      await act(async () => {
        result.current.handleSliderChange("BTC/USDC:USDC", 300)
      })

      await waitFor(() => {
        expect(result.current.selectedTokens[0].status).toBe("modified")
      })
    })

    it("sets status to modified when side changes from initial", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      expect(result.current.selectedTokens[0].status).toBe("untouched")
      expect(result.current.selectedTokens[0].side).toBe("buy")

      await act(async () => {
        result.current.handleSideChange("BTC/USDC:USDC", "sell")
      })

      await waitFor(() => {
        expect(result.current.selectedTokens[0].status).toBe("modified")
      })
    })

    it("sets status to modified when leverage changes from initial", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      expect(result.current.selectedTokens[0].status).toBe("untouched")
      expect(result.current.selectedTokens[0].leverage).toBe(2)

      await act(async () => {
        result.current.handleLeverageChange("BTC/USDC:USDC", 5)
      })

      await waitFor(() => {
        expect(result.current.selectedTokens[0].status).toBe("modified")
      })
    })

    it("preserves deleted status when token is deleted", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      await act(async () => {
        result.current.handleRemoveToken("BTC/USDC:USDC")
      })

      expect(result.current.selectedTokens[0].status).toBe("deleted")

      // Status should remain deleted even though values differ from initial
      await waitFor(() => {
        expect(result.current.selectedTokens[0].status).toBe("deleted")
      })
    })
  })

  describe("initialization priority", () => {
    it("merges localStorage with exchange positions, adding missing exchange positions", async () => {
      // Set up localStorage with one token
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          budget: 800,
          tokens: [
            {
              symbol: "ETH/USDC:USDC",
              percentage: 60,
              side: "sell",
              leverage: 3,
              lockedUsd: 480,
              notional: 480,
              status: "idle",
            },
          ],
        }),
      )

      // Mock exchange positions with a DIFFERENT token (simulating position that was removed from localStorage)
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Should have BOTH localStorage token AND exchange position
      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(2)
      })
      const symbols = result.current.selectedTokens.map(t => t.symbol)
      expect(symbols).toContain("ETH/USDC:USDC")
      expect(symbols).toContain("BTC/USDC:USDC")
    })

    it("uses localStorage values for tokens that exist in both localStorage and exchange", async () => {
      // Set up localStorage with customized values
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          budget: 800,
          tokens: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 30,
              side: "sell", // Different from exchange
              leverage: 5, // Different from exchange
              lockedUsd: 240,
              notional: 500,
              status: "idle",
            },
          ],
        }),
      )

      // Mock exchange with same token but different values
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 500,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })
      // Should use localStorage values (user's customizations)
      const btcToken = result.current.selectedTokens[0]
      expect(btcToken.side).toBe("sell")
      expect(btcToken.leverage).toBe(5)
    })

    it("calculates crossAccountLeverage from account summary", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 500,
          totalNotionalPosition: 750,
          withdrawable: 500,
          crossAccountLeverage: 1.5,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "SOL/USDC:USDC",
              percentage: 100,
              side: "buy",
              leverage: 1,
              notional: 750,
            },
          ],
          totalNotional: 750,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // crossAccountLeverage = totalNotional / accountValue = 750 / 500 = 1.5
      await waitFor(() => {
        expect(result.current.crossAccountLeverage).toBe(1.5)
      })
    })
  })

  describe("minimum USD enforcement", () => {
    it("sets lockedUsd to MIN_USD when adding new token", async () => {
      // Reset mocks to ensure clean state
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await waitFor(() => {
        expect(result.current.selectedTokens[0].lockedUsd).toBe(MIN_USD)
      })
    })

    it("does not modify tokens with exchange notional", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 1,
              notional: 5, // Below MIN_USD but from exchange
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Should preserve the exchange notional, not bump to MIN_USD
      expect(result.current.selectedTokens[0].notional).toBe(5)
    })

    it("does not modify tokens already at or above MIN_USD", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // Move slider to 50 USD (above MIN_USD)
      await act(async () => {
        result.current.handleSliderChange("BTC/USDC:USDC", 50)
      })

      await waitFor(() => {
        expect(result.current.selectedTokens[0].lockedUsd).toBe(50)
      })

      // Should stay at 50, not be modified
      expect(result.current.selectedTokens[0].lockedUsd).toBe(50)
    })

    it("does not enforce minimum on deleted tokens", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 1,
              notional: 250,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      await act(async () => {
        result.current.handleRemoveToken("BTC/USDC:USDC")
      })

      // Deleted token should have percentage 0 and remain deleted
      expect(result.current.selectedTokens[0].status).toBe("deleted")
      expect(result.current.selectedTokens[0].percentage).toBe(0)
    })
  })

  describe("crossAccountLeverage", () => {
    it("initializes with default crossAccountLeverage of 1 when no positions", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.crossAccountLeverage).toBe(1)
      })
    })

    it("calculates crossAccountLeverage from existing positions on load", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 2000,
          withdrawable: 1000,
          crossAccountLeverage: 2,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 100,
              side: "buy",
              leverage: 1,
              notional: 2000,
            },
          ],
          totalNotional: 2000,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // crossAccountLeverage = totalNotional / accountValue = 2000 / 1000 = 2
      await waitFor(() => {
        expect(result.current.crossAccountLeverage).toBe(2)
      })
    })

    it("updates crossAccountLeverage value", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleCrossAccountLeverageChange(2.5)
      })

      expect(result.current.crossAccountLeverage).toBe(2.5)
    })

    it("clamps crossAccountLeverage to minimum of 0.1", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleCrossAccountLeverageChange(0)
      })

      expect(result.current.crossAccountLeverage).toBe(0.1)
    })

    it("clamps crossAccountLeverage to maximum of 5", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleCrossAccountLeverageChange(10)
      })

      expect(result.current.crossAccountLeverage).toBe(5)
    })

    it("calculates effectiveBudget as accountValue * crossAccountLeverage", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.accountValue).toBe(1000)
      })

      // With crossAccountLeverage = 1, effectiveBudget = 1000
      expect(result.current.effectiveBudget).toBe(1000)

      await act(async () => {
        result.current.handleCrossAccountLeverageChange(2.5)
      })

      // With crossAccountLeverage = 2.5, effectiveBudget = 2500
      expect(result.current.effectiveBudget).toBe(2500)
    })

    it("persists crossAccountLeverage to localStorage", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleCrossAccountLeverageChange(3)
      })

      await waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        const parsed = JSON.parse(stored ?? "{}")
        expect(parsed.crossAccountLeverage).toBe(3)
      })
    })

    it("uses exchange crossAccountLeverage even when localStorage has tokens", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 2500,
          withdrawable: 1000,
          crossAccountLeverage: 2.5,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 100,
              side: "buy",
              leverage: 1,
              notional: 2500,
            },
          ],
          totalNotional: 2500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      // localStorage has different leverage, but exchange value should be used
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          crossAccountLeverage: 1.0,
          tokens: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 1,
            },
          ],
        }),
      )

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Should use exchange leverage (2.5), not localStorage (1.0)
      await waitFor(() => {
        expect(result.current.crossAccountLeverage).toBe(2.5)
      })
    })

    it("calculates token USD values based on effectiveBudget", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.accountValue).toBe(1000)
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // Set token to 50% allocation
      await act(async () => {
        result.current.handleSliderChange("BTC/USDC:USDC", 500)
      })

      // With crossAccountLeverage = 1, 50% of 1000 = 500 USD
      await waitFor(() => {
        expect(result.current.selectedTokens[0].lockedUsd).toBe(500)
      })

      // Now increase leverage to 2
      await act(async () => {
        result.current.handleCrossAccountLeverageChange(2)
      })

      // The percentage should stay the same, but effectiveBudget changes
      // With crossAccountLeverage = 2, effectiveBudget = 2000
      // 50% of 2000 = 1000 USD, but lockedUsd stays at 500
      // The percentage will be recalculated: 500 / 2000 * 100 = 25%
      await waitFor(() => {
        expect(result.current.effectiveBudget).toBe(2000)
        expect(result.current.selectedTokens[0].percentage).toBeCloseTo(25, 1)
      })
    })
  })

  describe("percentage derivation from lockedUsd", () => {
    it("derives percentage from lockedUsd and effectiveBudget", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 200,
          totalNotionalPosition: 0,
          withdrawable: 200,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Add a token (should get MIN_USD = 11 as lockedUsd)
      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // With effectiveBudget 200 (accountValue 200 * leverage 1) and lockedUsd 11, percentage should be (11/200)*100 = 5.5%
      expect(result.current.selectedTokens[0].lockedUsd).toBe(MIN_USD)
      expect(result.current.selectedTokens[0].percentage).toBeCloseTo(5.5, 1)
    })

    it("recalculates percentage when crossAccountLeverage changes", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 100,
          totalNotionalPosition: 0,
          withdrawable: 100,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      const percentAtLeverage1 = result.current.selectedTokens[0].percentage

      // Double the leverage (doubles effectiveBudget)
      await act(async () => {
        result.current.handleCrossAccountLeverageChange(2)
      })

      await waitFor(() => {
        // Percentage should roughly halve when effectiveBudget doubles (same lockedUsd)
        expect(result.current.selectedTokens[0].percentage).toBeLessThan(
          percentAtLeverage1,
        )
      })
    })

    it("derives percentage from notional when available", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 500,
          totalNotionalPosition: 250,
          withdrawable: 500,
          crossAccountLeverage: 0.5,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 1,
              notional: 250,
            },
          ],
          totalNotional: 250,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // crossAccountLeverage is initialized from exchange (0.5), but clamped to 0.1 (minimum)
      // effectiveBudget = 500 * 0.5 = 250
      // percentage = (notional 250 / effectiveBudget 250) * 100 = 100%
      // But we clamp the initial leverage, so it stays at the minimum 0.1
      // Actually, let's recalculate based on what the hook does

      // Wait for crossAccountLeverage to initialize from exchange
      await waitFor(() => {
        // With accountValue = 500 and crossAccountLeverage from exchange = 0.5
        // effectiveBudget = 500 * 0.5 = 250
        // percentage = (250 / 250) * 100 = 100%
        // But clamping rules: 0.1 min, 5 max, so 0.5 is valid
        expect(result.current.selectedTokens[0].percentage).toBe(100)
      })
    })
  })

  describe("delta tracking for insufficient adjustments", () => {
    it("marks deltaInsufficient true when adjustment is below minimum order size", async () => {
      // Account value 1000, crossAccountLeverage 1.0 => effectiveBudget 1000
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 100,
          withdrawable: 900,
          crossAccountLeverage: 1.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      // Existing position with notional 100
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 1,
              notional: 100, // Current notional
            },
          ],
          totalNotional: 100,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Adjust to 10.5% (target 105) - delta of 5 is below MIN_ORDER_SIZE (10)
      await act(async () => {
        result.current.handleSliderChange("BTC/USDC:USDC", 105)
      })

      await waitFor(() => {
        const token = result.current.selectedTokens[0]
        expect(token.currentNotional).toBe(100)
        expect(token.targetNotional).toBeCloseTo(105, 0)
        expect(token.deltaInsufficient).toBe(true)
      })
    })

    it("marks deltaInsufficient false when adjustment meets minimum order size", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 100,
          withdrawable: 900,
          crossAccountLeverage: 1.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 1,
              notional: 100,
            },
          ],
          totalNotional: 100,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Adjust to 12% (target 120) - delta of 20 meets MIN_ORDER_SIZE (10)
      await act(async () => {
        result.current.handleSliderChange("BTC/USDC:USDC", 120)
      })

      await waitFor(() => {
        const token = result.current.selectedTokens[0]
        expect(token.currentNotional).toBe(100)
        expect(token.targetNotional).toBeCloseTo(120, 0)
        expect(token.deltaInsufficient).toBe(false)
      })
    })

    it("does not mark deltaInsufficient for new positions without notional", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 1.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Add a new token (no existing position)
      await act(async () => {
        result.current.handleAddToken("NEW/USDC:USDC")
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
        const token = result.current.selectedTokens[0]
        // New token has no currentNotional, so deltaInsufficient should be false
        expect(token.currentNotional).toBe(0)
        expect(token.deltaInsufficient).toBe(false)
      })
    })

    it("does not mark deltaInsufficient for deleted tokens", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 100,
          withdrawable: 900,
          crossAccountLeverage: 1.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 1,
              notional: 100,
            },
          ],
          totalNotional: 100,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Delete the token
      await act(async () => {
        result.current.handleRemoveToken("BTC/USDC:USDC")
      })

      await waitFor(() => {
        const token = result.current.selectedTokens[0]
        expect(token.status).toBe("deleted")
        // Deleted tokens should not have deltaInsufficient set
        expect(token.deltaInsufficient).toBeUndefined()
      })
    })

    it("keeps targetNotional matching currentNotional when leverage changes but position unchanged", async () => {
      // When leverage changes but user doesn't adjust the position slider,
      // the percentage is re-derived from notional/budget, so targetNotional stays the same
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 100,
          withdrawable: 900,
          crossAccountLeverage: 1.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 1,
              notional: 100,
            },
          ],
          totalNotional: 100,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Initial: notional 100, budget 1000, percentage 10% => target 100
      expect(result.current.selectedTokens[0].targetNotional).toBe(100)
      expect(result.current.selectedTokens[0].deltaInsufficient).toBe(false)

      // Change leverage to 2x => budget becomes 2000
      // But percentage is re-derived from notional: 100/2000 = 5%
      // So target = 5% * 2000 = 100 (unchanged)
      await act(async () => {
        result.current.handleCrossAccountLeverageChange(2)
      })

      await waitFor(() => {
        const token = result.current.selectedTokens[0]
        // Target stays at 100 (percentage re-derived to 5% * 2000 = 100)
        expect(token.targetNotional).toBe(100)
        expect(token.currentNotional).toBe(100)
        // No delta, so deltaInsufficient is false
        expect(token.deltaInsufficient).toBe(false)
      })
    })

    it("computes correct targetNotional and currentNotional values", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 500,
          totalNotionalPosition: 250,
          withdrawable: 250,
          crossAccountLeverage: 1.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "ETH/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 2,
              notional: 250,
            },
          ],
          totalNotional: 250,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
        const token = result.current.selectedTokens[0]
        // currentNotional should come from the exchange position
        expect(token.currentNotional).toBe(250)
        // targetNotional = (percentage / 100) * budgetForUi
        // budgetForUi = accountValue * crossAccountLeverage = 500 * 1 = 500
        // With percentage 50%, targetNotional = 0.5 * 500 = 250
        expect(token.targetNotional).toBe(250)
        // No difference, so deltaInsufficient should be false
        expect(token.deltaInsufficient).toBe(false)
      })
    })
  })

  describe("position sizing and leverage constraints", () => {
    it("allows increasing position when current leverage is above 1x", async () => {
      // Account value $100, existing position $287 (2.87x leverage)
      // User should be able to increase the position further (up to 5x = $500)
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 100,
          totalNotionalPosition: 287,
          withdrawable: 100,
          crossAccountLeverage: 2.87,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 100,
              side: "buy",
              leverage: 1,
              notional: 287,
            },
          ],
          totalNotional: 287,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Try to increase position to $350 (3.5x leverage, still under 5x max)
      await act(async () => {
        result.current.handleSliderChange("BTC/USDC:USDC", 350)
      })

      await waitFor(() => {
        // Position should be increased to $350, not clamped to $287
        expect(result.current.selectedTokens[0].lockedUsd).toBe(350)
      })
    })

    it("allows increasing position up to 5x leverage limit", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 100,
          totalNotionalPosition: 200,
          withdrawable: 100,
          crossAccountLeverage: 2.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "ETH/USDC:USDC",
              percentage: 100,
              side: "buy",
              leverage: 1,
              notional: 200,
            },
          ],
          totalNotional: 200,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Try to increase to $500 (exactly 5x leverage)
      await act(async () => {
        result.current.handleSliderChange("ETH/USDC:USDC", 500)
      })

      await waitFor(() => {
        expect(result.current.selectedTokens[0].lockedUsd).toBe(500)
      })
    })

    it("clamps position at 5x leverage limit when trying to exceed it", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 100,
          totalNotionalPosition: 200,
          withdrawable: 100,
          crossAccountLeverage: 2.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "ETH/USDC:USDC",
              percentage: 100,
              side: "buy",
              leverage: 1,
              notional: 200,
            },
          ],
          totalNotional: 200,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // Try to increase to $600 (6x leverage, exceeds 5x max)
      await act(async () => {
        result.current.handleSliderChange("ETH/USDC:USDC", 600)
      })

      await waitFor(() => {
        // Should be clamped to $500 (5x leverage max)
        expect(result.current.selectedTokens[0].lockedUsd).toBe(500)
      })
    })

    it("allows increasing one position when multiple positions exist", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 100,
          totalNotionalPosition: 200,
          withdrawable: 100,
          crossAccountLeverage: 2.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 1,
              notional: 100,
            },
            {
              symbol: "ETH/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 1,
              notional: 100,
            },
          ],
          totalNotional: 200,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(2)
      })

      // Try to increase BTC to $300 (total would be $400 = 4x leverage)
      await act(async () => {
        result.current.handleSliderChange("BTC/USDC:USDC", 300)
      })

      await waitFor(() => {
        const btcToken = result.current.selectedTokens.find(
          t => t.symbol === "BTC/USDC:USDC",
        )
        expect(btcToken?.lockedUsd).toBe(300)
      })
    })

    it("respects 5x limit across multiple positions", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 100,
          totalNotionalPosition: 400,
          withdrawable: 100,
          crossAccountLeverage: 4.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 1,
              notional: 200,
            },
            {
              symbol: "ETH/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 1,
              notional: 200,
            },
          ],
          totalNotional: 400,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(2)
      })

      // Try to increase BTC to $400 (total would be $600 = 6x, exceeds 5x)
      // Should be clamped so total is $500 (5x), meaning BTC can only be $300
      await act(async () => {
        result.current.handleSliderChange("BTC/USDC:USDC", 400)
      })

      await waitFor(() => {
        const btcToken = result.current.selectedTokens.find(
          t => t.symbol === "BTC/USDC:USDC",
        )
        // Max for BTC = 500 (5x limit) - 200 (ETH) = 300
        expect(btcToken?.lockedUsd).toBe(300)
      })
    })
  })
})
