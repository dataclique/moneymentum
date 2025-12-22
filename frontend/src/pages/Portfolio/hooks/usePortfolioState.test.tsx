import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import { MIN_USD, usePortfolioState } from "./usePortfolioState"
import {
  useHyperliquidBalance,
  useHyperliquidPositions,
} from "@/hooks/useTrading"

vi.mock("@/hooks/useTrading", () => ({
  useHyperliquidBalance: vi.fn(() => ({
    data: 1000,
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

    it("persists budget to localStorage when budget changes", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("500")
      })

      await waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).not.toBeNull()
        const parsed = JSON.parse(stored ?? "{}")
        expect(parsed.budget).toBe(500)
      })
    })

    it("persists token modifications to localStorage", async () => {
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

  describe("budgetForUi fallback behavior", () => {
    it("uses current budget when sufficient for tokens", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("200")
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // Budget 200 is sufficient for 1 token requiring MIN_USD (11)
      expect(result.current.budgetForUi).toBe(200)
    })

    it("falls back to last sufficient budget when current budget becomes insufficient", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Set a sufficient budget first
      await act(async () => {
        result.current.handleBudgetInputChange("100")
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await act(async () => {
        result.current.handleAddToken("ETH/USDC:USDC")
      })

      // With 2 tokens, need 22 (2 * MIN_USD)
      expect(result.current.budgetForUi).toBe(100)

      // Now set budget to less than required (less than 22)
      await act(async () => {
        result.current.handleBudgetInputChange("15")
      })

      // Should fall back to last sufficient budget (100)
      await waitFor(() => {
        expect(result.current.budgetForUi).toBe(100)
      })
    })

    it("returns budget when no tokens regardless of amount", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("5")
      })

      // No tokens, so any budget is fine for UI
      expect(result.current.budgetForUi).toBe(5)
    })

    it("uses minimum required budget when no prior sufficient budget exists", async () => {
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Start with zero budget, add tokens
      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      // budgetForUi should show a reasonable value for UI calculations
      // When budget is 0 and we have tokens, it should fall back to MIN_USD
      await waitFor(() => {
        expect(result.current.budgetForUi).toBeGreaterThanOrEqual(MIN_USD)
      })
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

    it("initializes tokens from localStorage with idle status (can be submitted)", async () => {
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
      // Tokens from localStorage (no exchange data to compare) should be "idle" so they can be rebalanced
      expect(result.current.selectedTokens[0].status).toBe("idle")
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

  describe("budget initialization from balance", () => {
    it("initializes budget from balance when no positions exist", async () => {
      vi.mocked(useHyperliquidBalance).mockReturnValue({
        data: 2000,
      } as ReturnType<typeof useHyperliquidBalance>)

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

    it("uses exchange totalNotional as budget when loading positions", async () => {
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

      await waitFor(() => {
        expect(result.current.budget).toBe(750)
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

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("200")
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
      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("200")
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

  describe("percentage derivation from lockedUsd", () => {
    it("derives percentage from lockedUsd and budget", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      // Set budget to 200
      await act(async () => {
        result.current.handleBudgetInputChange("200")
      })

      // Add a token (should get MIN_USD = 11 as lockedUsd)
      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      // With budget 200 and lockedUsd 11, percentage should be (11/200)*100 = 5.5%
      expect(result.current.selectedTokens[0].lockedUsd).toBe(MIN_USD)
      expect(result.current.selectedTokens[0].percentage).toBeCloseTo(5.5, 1)
    })

    it("recalculates percentage when budget changes", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(() => usePortfolioState(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.handleBudgetInputChange("100")
      })

      await act(async () => {
        result.current.handleAddToken("BTC/USDC:USDC")
      })

      await waitFor(() => {
        expect(result.current.selectedTokens).toHaveLength(1)
      })

      const percentAt100 = result.current.selectedTokens[0].percentage

      // Double the budget
      await act(async () => {
        result.current.handleBudgetInputChange("200")
      })

      await waitFor(() => {
        // Percentage should roughly halve when budget doubles (same lockedUsd)
        expect(result.current.selectedTokens[0].percentage).toBeLessThan(
          percentAt100,
        )
      })
    })

    it("derives percentage from notional when available", async () => {
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

      // With notional 250 and budget 500 (from totalNotional), percentage = 50%
      expect(result.current.selectedTokens[0].percentage).toBe(50)
    })
  })
})
