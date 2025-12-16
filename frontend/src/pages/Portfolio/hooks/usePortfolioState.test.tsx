import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import { STORAGE_KEY, MIN_USD, usePortfolioState } from "./usePortfolioState"

// Mock the API hooks
vi.mock("@/hooks/useApi", () => ({
  useHyperliquidBalance: vi.fn(() => ({
    data: { perp_usdc_balance: 1000 },
  })),
  useHyperliquidPositions: vi.fn(() => ({
    data: { positions: [], total_notional: 0 },
    isLoading: false,
  })),
  useHyperliquidLeverageLimits: vi.fn(() => ({
    data: { data: [{ symbol: "BTC/USDC:USDC", max_leverage: 50 }] },
  })),
  useBudgetPreference: vi.fn(() => ({
    data: { budget: 0 },
    isLoading: false,
  })),
  useSaveBudgetPreference: vi.fn(() => ({
    mutate: vi.fn(),
  })),
  useRebalanceHyperliquidPositions: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  refreshAllData: vi.fn(),
}))

// Mock NetworkContext
vi.mock("@/contexts/NetworkContext", () => ({
  useNetwork: vi.fn(() => ({
    setIsNetworkSwitching: vi.fn(),
  })),
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
    it("exports correct STORAGE_KEY", () => {
      expect(STORAGE_KEY).toBe("portfolio-allocation-state")
    })

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

  describe("handleBudgetInputChange", () => {
    it("updates budget input value", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("500")
      })

      expect(result.current.budgetInput).toBe("500")
    })

    it("sets error for negative values", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("-100")
      })

      expect(result.current.budgetError).toBe(
        "Budget must be a positive number",
      )
    })

    it("clears error for valid values", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("-100")
      })

      expect(result.current.budgetError).not.toBeNull()

      await act(async () => {
        result.current.handleBudgetInputChange("100")
      })

      expect(result.current.budgetError).toBeNull()
    })
  })

  describe("netExposure calculation", () => {
    it("calculates positive exposure for long positions", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("100")
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
        result.current.handleBudgetInputChange("100")
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
        result.current.handleBudgetInputChange("100")
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // Wait for localStorage to be updated
      await waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).not.toBeNull()
      })

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
      expect(stored.tokens).toHaveLength(1)
      expect(stored.tokens[0].symbol).toBe("BTC/USDC:USDC")
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
})
