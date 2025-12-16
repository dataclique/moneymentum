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

// Mock useNetwork hook
vi.mock("@/hooks/useNetwork", () => ({
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

      const storedRaw = localStorage.getItem(STORAGE_KEY)
      const stored = JSON.parse(storedRaw ?? "{}")
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

  describe("localStorage initialization useEffect", () => {
    it("initializes budget from localStorage when stored data exists", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          budget: 500,
          tokens: [],
        }),
      )

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.budget).toBe(500)
      })
      expect(result.current.budgetInput).toBe("500")
    })

    it("initializes tokens from localStorage with untouched status", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          budget: 500,
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
      expect(result.current.selectedTokens[0].status).toBe("untouched")
      expect(result.current.selectedTokens[0].leverage).toBe(2)
    })

    it("sets default leverage of 1 when not specified in stored data", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          budget: 500,
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

  describe("server budget initialization useEffect", () => {
    it("uses budget preference from server when available", async () => {
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useBudgetPreference).mockReturnValue({
        data: { budget: 750 },
        isLoading: false,
      } as ReturnType<typeof useApiModule.useBudgetPreference>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.budget).toBe(750)
      })
    })

    it("falls back to balance when budget preference is zero", async () => {
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useBudgetPreference).mockReturnValue({
        data: { budget: 0 },
        isLoading: false,
      } as ReturnType<typeof useApiModule.useBudgetPreference>)
      vi.mocked(useApiModule.useHyperliquidBalance).mockReturnValue({
        data: { perp_usdc_balance: 2000 },
      } as ReturnType<typeof useApiModule.useHyperliquidBalance>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.budget).toBe(2000)
      })
    })
  })

  describe("exchange positions loading useEffect", () => {
    it("loads positions from exchange when no localStorage data exists", async () => {
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
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
          total_notional: 400,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
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
          total_notional: 400,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
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
          total_notional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
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
          total_notional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
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
          total_notional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
        data: { positions: [], total_notional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleAddToken("NEW/USDC:USDC")
      })

      expect(result.current.selectedTokens[0].status).toBe("idle")
    })
  })

  describe("percentage recalculation useEffect", () => {
    it("recalculates percentages when budget changes", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("100")
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      const initialPercentage = result.current.selectedTokens[0].percentage

      await act(async () => {
        result.current.handleBudgetInputChange("200")
      })

      await waitFor(() => {
        // The percentage should be recalculated based on locked USD value
        // With MIN_USD of 11 and budget of 200, percentage = (11/200)*100 = 5.5%
        expect(result.current.selectedTokens[0].percentage).toBeLessThan(
          initialPercentage,
        )
      })
    })

    it("enforces minimum percentage based on MIN_USD", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("1000")
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

  describe("debounced budget save useEffect", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("calls saveBudgetPreference after 3 seconds delay", async () => {
      const mockSaveBudget = vi.fn()
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useSaveBudgetPreference).mockReturnValue({
        mutate: mockSaveBudget,
      } as unknown as ReturnType<typeof useApiModule.useSaveBudgetPreference>)
      // Ensure no positions load to avoid initial budget save
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
        data: { positions: [], total_notional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("300")
      })

      // Clear any calls from initialization
      mockSaveBudget.mockClear()

      // Now test the debounced save
      await act(async () => {
        result.current.handleBudgetInputChange("400")
      })

      // Should not call immediately
      expect(mockSaveBudget).not.toHaveBeenCalled()

      // Advance timers by 3 seconds
      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      expect(mockSaveBudget).toHaveBeenCalledWith({ budget: 400 })
    })

    it("debounces multiple budget changes", async () => {
      const mockSaveBudget = vi.fn()
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useSaveBudgetPreference).mockReturnValue({
        mutate: mockSaveBudget,
      } as unknown as ReturnType<typeof useApiModule.useSaveBudgetPreference>)
      // Ensure no positions load to avoid initial budget save
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
        data: { positions: [], total_notional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Initialize budget first to mark as initialized
      await act(async () => {
        result.current.handleBudgetInputChange("100")
      })

      // Clear any calls from initialization
      mockSaveBudget.mockClear()

      await act(async () => {
        result.current.handleBudgetInputChange("200")
      })

      await act(async () => {
        vi.advanceTimersByTime(1000)
      })

      await act(async () => {
        result.current.handleBudgetInputChange("300")
      })

      await act(async () => {
        vi.advanceTimersByTime(1000)
      })

      await act(async () => {
        result.current.handleBudgetInputChange("400")
      })

      // Not called yet (we just cleared the mock)
      expect(mockSaveBudget).not.toHaveBeenCalled()

      // Advance by 3 more seconds
      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      // Should be called with the final value
      expect(mockSaveBudget).toHaveBeenCalledWith({ budget: 400 })
    })
  })

  describe("handleRemoveToken with initialPortfolio", () => {
    it("marks token as deleted when it was in initialPortfolio", async () => {
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
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
          total_notional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
        data: { positions: [], total_notional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
  })

  describe("handleUndoRemoveToken", () => {
    it("restores deleted token with previous percentage", async () => {
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
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
          total_notional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useHyperliquidPositions).mockReturnValue({
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
          total_notional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useHyperliquidPositions>)

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
})
