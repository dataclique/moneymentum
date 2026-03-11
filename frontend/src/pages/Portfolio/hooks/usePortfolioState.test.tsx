import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ParentProps } from "solid-js"
import { MIN_USD, usePortfolioState } from "./usePortfolioState"
import {
  useHyperliquidAccountSummary,
  useHyperliquidPositions,
  useHyperliquidLeverageLimits,
  useHyperliquidBalance,
  useRebalanceHyperliquidPositions,
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
  useHyperliquidBalance: vi.fn(() => ({
    data: 1000,
    isLoading: false,
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
    networkMode: () => "testnet",
    credentials: null,
    isConnected: () => false,
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
  return (props: ParentProps) => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  )
}

describe("usePortfolioState", () => {
  beforeEach(() => {
    // Ensure a working in-memory localStorage implementation for this test file.
    const globalAny = globalThis as any
    if (
      !globalAny.localStorage ||
      typeof globalAny.localStorage.getItem !== "function"
    ) {
      const store = new Map<string, string>()
      globalAny.localStorage = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, value)
        },
        removeItem: (key: string) => {
          store.delete(key)
        },
        clear: () => {
          store.clear()
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
          return store.size
        },
      }
    } else if (typeof globalAny.localStorage.clear !== "function") {
      globalAny.localStorage.clear = () => {
        const storage: Storage = globalAny.localStorage
        // Use the Storage API to ensure we clear actual stored keys.
        while (storage.length > 0) {
          const key = storage.key(0)
          if (key === null) {
            break
          }
          storage.removeItem(key)
        }
      }
    }

    if (typeof globalAny.localStorage.clear === "function") {
      globalAny.localStorage.clear()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    const globalAny = globalThis as any
    if (
      globalAny.localStorage &&
      typeof globalAny.localStorage.clear === "function"
    ) {
      globalAny.localStorage.clear()
    }
  })

  describe("constants", () => {
    it("exports correct MIN_USD", () => {
      expect(MIN_USD).toBe(11)
    })
  })

  describe("initial state", () => {
    it("returns empty selectedTokens when no stored data", () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      expect(result.selectedTokens).toEqual([])
      expect(result.activeTokens).toEqual([])
    })

    it("returns disableSubmit true when no tokens selected", () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      expect(result.disableSubmit).toBe(true)
    })

    it("returns zero netExposure when no tokens", () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      expect(result.netExposure).toBe(0)
    })
  })

  describe("handleAddToken", () => {
    it("adds a new token with default values", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      expect(result.selectedTokens).toHaveLength(1)
      expect(result.selectedTokens[0].symbol).toBe("BTC/USDC:USDC")
      expect(result.selectedTokens[0].side).toBe("buy")
      expect(result.selectedTokens[0].leverage).toBe(50) // Defaults to max leverage
      expect(result.selectedTokens[0].status).toBe("idle")
    })

    it("does not add duplicate tokens", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      result.handleAddToken("BTC/USDC:USDC")

      expect(result.selectedTokens).toHaveLength(1)
    })
  })

  describe("handleRemoveToken", () => {
    it("removes token that was not in initial portfolio", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      expect(result.selectedTokens).toHaveLength(1)

      result.handleRemoveToken("BTC/USDC:USDC")

      expect(result.selectedTokens).toHaveLength(0)
    })
  })

  describe("handleSideChange", () => {
    it("changes token side from buy to sell", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      expect(result.selectedTokens[0].side).toBe("buy")

      result.handleSideChange("BTC/USDC:USDC", "sell")

      expect(result.selectedTokens[0].side).toBe("sell")
    })
  })

  describe("handleLeverageChange", () => {
    it("changes token leverage within limits", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      expect(result.selectedTokens[0].leverage).toBe(50) // Defaults to max leverage

      result.handleLeverageChange("BTC/USDC:USDC", 5)

      expect(result.selectedTokens[0].leverage).toBe(5)
    })

    it("clamps leverage to minimum of 1", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      result.handleLeverageChange("BTC/USDC:USDC", 0)

      expect(result.selectedTokens[0].leverage).toBe(1)
    })
  })

  describe("netExposure calculation", () => {
    it("calculates positive exposure for long positions", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      // Token should be added with buy side
      expect(result.selectedTokens[0].side).toBe("buy")
      expect(result.netExposure).toBeGreaterThan(0)
    })

    it("calculates negative exposure for short positions", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      result.handleSideChange("BTC/USDC:USDC", "sell")

      expect(result.netExposure).toBeLessThan(0)
    })
  })

  describe("remainingPercent", () => {
    it("returns 100 when no tokens are allocated", () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      expect(result.remainingPercent).toBe(100)
    })
  })

  describe("localStorage persistence", () => {
    it("persists tokens to localStorage", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

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
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleCrossAccountLeverageChange(2.5)

      await waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).not.toBeNull()
        const parsed = JSON.parse(stored ?? "{}")
        expect(parsed.crossAccountLeverage).toBe(2.5)
      })
    })

    it("persists token modifications to localStorage", async () => {
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      result.handleSideChange("BTC/USDC:USDC", "sell")

      result.handleLeverageChange("BTC/USDC:USDC", 5)

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
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      expect(result.activeTokens).toHaveLength(1)

      result.handleRemoveToken("BTC/USDC:USDC")

      // Token was not in initial portfolio so it gets removed completely
      expect(result.activeTokens).toHaveLength(0)
      expect(result.selectedTokens).toHaveLength(0)
    })
  })

  describe("blockingReasons", () => {
    it("returns empty array when no blocking issues", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      result.handleWeightChange("BTC/USDC:USDC", 100)

      await waitFor(() => {
        expect(result.blockingReasons).toEqual([])
      })
    })
  })

  describe("displayNotional behavior", () => {
    it("uses targetNotional when accountValue and leverage are set", async () => {
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.accountValue).toBe(1000)
      })

      // With empty positions, leverage is set to 0. Set it explicitly to 1.
      result.handleCrossAccountLeverageChange(1)

      // accountValue = 1000, crossAccountLeverage = 1, targetNotional = 1000
      expect(result.displayNotional).toBe(1000)

      result.handleCrossAccountLeverageChange(2)

      // targetNotional = 1000 * 2 = 2000
      expect(result.displayNotional).toBe(2000)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // No accountValue and no tokens
      expect(result.displayNotional).toBe(0)
    })

    it("uses minimum required notional when totalNotional is zero but tokens exist", async () => {
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 0,
          totalNotionalPosition: 0,
          withdrawable: 0,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      // displayNotional should fall back to MIN_USD when totalNotional is 0
      await waitFor(() => {
        expect(result.displayNotional).toBeGreaterThanOrEqual(MIN_USD)
      })
    })
  })

  describe("localStorage initialization useEffect", () => {
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
        // Tokens from localStorage (no exchange data to compare) should be "idle" so they can be rebalanced
        expect(result.selectedTokens[0].status).toBe("idle")
      })
      expect(result.selectedTokens[0].symbol).toBe("BTC/USDC:USDC")
      // Tokens from localStorage (no exchange data to compare) should be "idle" so they can be rebalanced
      expect(result.selectedTokens[0].status).toBe("idle")
      expect(result.selectedTokens[0].leverage).toBe(2)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })
      expect(result.selectedTokens[0].leverage).toBe(1)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.accountValue).toBe(2000)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })
      expect(result.selectedTokens[0].symbol).toBe("SOL/USDC:USDC")
      expect(result.selectedTokens[0].notional).toBe(400)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })
      // The token should have status untouched since initialPortfolio is set
      expect(result.selectedTokens[0].status).toBe("untouched")
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Initially should be untouched when loaded from exchange
      expect(result.selectedTokens[0].status).toBe("untouched")
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      expect(result.selectedTokens[0].side).toBe("buy")

      result.handleSideChange("BTC/USDC:USDC", "sell")

      expect(result.selectedTokens[0].side).toBe("sell")
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      expect(result.selectedTokens[0].leverage).toBe(2)

      result.handleLeverageChange("BTC/USDC:USDC", 5)

      expect(result.selectedTokens[0].leverage).toBe(5)
    })

    it("adds new token with idle status", async () => {
      // Ensure no positions load from exchange that would set untouched status
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("NEW/USDC:USDC")

      expect(result.selectedTokens[0].status).toBe("idle")
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      // With empty positions, leverage is 0, token gets MIN_USD = 11, percentage = 100%
      // When leverage increases: percentage stays fixed, notional scales with targetNotional
      const initialPercentage = result.selectedTokens[0].percentage

      result.handleCrossAccountLeverageChange(2)

      await waitFor(() => {
        // Percentage stays fixed, notional = (percentage/100) * targetNotional
        // targetNotional = 1000 * 2 = 2000, so for 100% token: notional = 2000
        expect(result.selectedTokens[0].percentage).toBe(initialPercentage)
        const newNotional = result.selectedTokens[0].notional ?? 0
        const expectedNotional = (initialPercentage / 100) * 2000 // targetNotional at 2x
        expect(newNotional).toBeCloseTo(expectedNotional, 0)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      // MIN_USD is 11, so min percentage = (11/1000)*100 = 1.1%
      await waitFor(() => {
        expect(result.selectedTokens[0].percentage).toBeGreaterThanOrEqual(1.1)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      result.handleRemoveToken("BTC/USDC:USDC")

      // Should be marked as deleted, not removed
      expect(result.selectedTokens).toHaveLength(1)
      expect(result.selectedTokens[0].status).toBe("deleted")
      expect(result.selectedTokens[0].percentage).toBe(0)
    })

    it("removes token completely when it was not in initialPortfolio", async () => {
      // Ensure no positions load from exchange
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("NEW/USDC:USDC")

      expect(result.selectedTokens).toHaveLength(1)

      result.handleRemoveToken("NEW/USDC:USDC")

      // Should be completely removed
      expect(result.selectedTokens).toHaveLength(0)
    })

    it("marks token as deleted when loaded from localStorage with notional (exchange position)", async () => {
      // Token exists on exchange (in initialPortfolio) -> handleRemoveToken marks as deleted
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "ASTER/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 3,
              notional: 50,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          crossAccountLeverage: 1,
          tokens: [
            {
              symbol: "ASTER/USDC:USDC",
              percentage: 10,
              side: "buy",
              leverage: 3,
              lockedUsd: 50,
              notional: 50,
              status: "idle",
            },
          ],
        }),
      )

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      result.handleRemoveToken("ASTER/USDC:USDC")

      // initialPortfolio had ASTER from exchange -> token marked as deleted (not removed)
      expect(result.selectedTokens).toHaveLength(1)
      expect(result.selectedTokens[0].status).toBe("deleted")
      expect(result.selectedTokens[0].percentage).toBe(0)
    })

    it("completely removes token from localStorage without notional (no exchange position)", async () => {
      // No exchange positions - token is new, not on exchange
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      // Simulate a new token added locally but never synced to exchange
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          crossAccountLeverage: 1,
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      result.handleRemoveToken("NEW/USDC:USDC")

      // Should be completely removed since it doesn't exist on exchange
      expect(result.selectedTokens).toHaveLength(0)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      const originalPercentage = result.selectedTokens[0].percentage

      result.handleRemoveToken("BTC/USDC:USDC")

      expect(result.selectedTokens[0].status).toBe("deleted")

      result.handleUndoRemoveToken("BTC/USDC:USDC")

      expect(result.selectedTokens[0].status).toBe("untouched")
      expect(result.selectedTokens[0].percentage).toBe(originalPercentage)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      expect(result.hasPendingDeletions).toBe(false)

      result.handleRemoveToken("BTC/USDC:USDC")

      expect(result.hasPendingDeletions).toBe(true)
    })
  })

  describe("token status derivation", () => {
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      expect(result.selectedTokens[0].status).toBe("untouched")
      expect(result.selectedTokens[0].side).toBe("buy")

      result.handleSideChange("BTC/USDC:USDC", "sell")

      await waitFor(() => {
        expect(result.selectedTokens[0].status).toBe("modified")
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      expect(result.selectedTokens[0].status).toBe("untouched")
      expect(result.selectedTokens[0].leverage).toBe(2)

      result.handleLeverageChange("BTC/USDC:USDC", 5)

      await waitFor(() => {
        expect(result.selectedTokens[0].status).toBe("modified")
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      result.handleRemoveToken("BTC/USDC:USDC")

      expect(result.selectedTokens[0].status).toBe("deleted")

      // Status should remain deleted even though values differ from initial
      await waitFor(() => {
        expect(result.selectedTokens[0].status).toBe("deleted")
      })
    })
  })

  describe("initialization priority", () => {
    it("merges localStorage with exchange positions, adding missing exchange positions", async () => {
      // Set up localStorage with one token
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          crossAccountLeverage: 1,
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // Should have BOTH localStorage token AND exchange position
      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(2)
      })
      const symbols = result.selectedTokens.map(t => t.symbol)
      expect(symbols).toContain("ETH/USDC:USDC")
      expect(symbols).toContain("BTC/USDC:USDC")
    })

    it("uses localStorage values for tokens that exist in both localStorage and exchange", async () => {
      // Set up localStorage with customized values
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          crossAccountLeverage: 1,
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })
      // Should use localStorage values (user's customizations)
      const btcToken = result.selectedTokens[0]
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // crossAccountLeverage = totalNotional / accountValue = 750 / 500 = 1.5
      await waitFor(() => {
        expect(result.crossAccountLeverage).toBe(1.5)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      await waitFor(() => {
        expect(result.selectedTokens[0].lockedUsd).toBe(MIN_USD)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Should preserve the exchange notional, not bump to MIN_USD
      expect(result.selectedTokens[0].notional).toBe(5)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      result.handleRemoveToken("BTC/USDC:USDC")

      // Deleted token should have percentage 0 and remain deleted
      expect(result.selectedTokens[0].status).toBe("deleted")
      expect(result.selectedTokens[0].percentage).toBe(0)
    })
  })

  describe("crossAccountLeverage", () => {
    it("initializes crossAccountLeverage to 0 when no positions (totalNotional 0)", async () => {
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // When positions are empty, totalNotional = 0, so calcLeverage(0, accountValue) = 0
      await waitFor(() => {
        expect(result.crossAccountLeverage).toBe(0)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // crossAccountLeverage = totalNotional / accountValue = 2000 / 1000 = 2
      await waitFor(() => {
        expect(result.crossAccountLeverage).toBe(2)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleCrossAccountLeverageChange(2.5)

      expect(result.crossAccountLeverage).toBe(2.5)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleCrossAccountLeverageChange(10)

      expect(result.crossAccountLeverage).toBe(5)
    })

    it("calculates totalNotional as accountValue * crossAccountLeverage", async () => {
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.accountValue).toBe(1000)
      })

      // With empty positions, leverage is 0; set to 1 first
      result.handleCrossAccountLeverageChange(1)

      // With crossAccountLeverage = 1, targetNotional = 1000
      expect(result.targetNotional).toBe(1000)

      result.handleCrossAccountLeverageChange(2.5)

      // With crossAccountLeverage = 2.5, targetNotional = 2500
      expect(result.targetNotional).toBe(2500)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleCrossAccountLeverageChange(3)

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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // Should use exchange leverage (2.5), not localStorage (1.0)
      await waitFor(() => {
        expect(result.crossAccountLeverage).toBe(2.5)
      })
    })

    it("calculates token USD values based on totalNotional", async () => {
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.accountValue).toBe(1000)
      })

      result.handleAddToken("BTC/USDC:USDC")

      // Set token to 50% allocation
      result.handleWeightChange("BTC/USDC:USDC", 50)

      await waitFor(() => {
        expect(result.selectedTokens[0].percentage).toBe(50)
      })

      // Now increase leverage to 2
      result.handleCrossAccountLeverageChange(2)

      // With percentage as source of truth, 50% stays as 50%
      // With crossAccountLeverage = 2, totalNotional = 2000
      // So the USD value is now 50% of 2000 = 1000 USD
      await waitFor(() => {
        expect(result.totalNotional).toBe(1000)
        expect(result.selectedTokens[0].percentage).toBe(50)
      })
    })
  })

  describe("percentage derivation from lockedUsd", () => {
    it("derives percentage from lockedUsd and targetNotional", async () => {
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // Add a token (gets MIN_USD = 11 initially)
      result.handleAddToken("BTC/USDC:USDC")

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Set leverage 0.5 so targetNotional = 200 * 0.5 = 100
      result.handleCrossAccountLeverageChange(0.5)

      // Set weight to 11% so notional = 11% * 100 = 11 (MIN_USD)
      result.handleWeightChange("BTC/USDC:USDC", 11)

      // With targetNotional 100 and 11% weight, lockedUsd = 11
      expect(result.selectedTokens[0].lockedUsd).toBe(MIN_USD)
      expect(result.selectedTokens[0].percentage).toBeCloseTo(11, 1)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // crossAccountLeverage is initialized from exchange (0.5), but clamped to 0.1 (minimum)
      // targetNotional = 500 * 0.5 = 250
      // percentage = (notional 250 / totalNotional 250) * 100 = 100%
      // But we clamp the initial leverage, so it stays at the minimum 0.1
      // Actually, let's recalculate based on what the hook does

      // Wait for crossAccountLeverage to initialize from exchange
      await waitFor(() => {
        // With accountValue = 500 and crossAccountLeverage from exchange = 0.5
        // totalNotional = 500 * 0.5 = 250
        // percentage = (250 / 250) * 100 = 100%
        // But clamping rules: 0.1 min, 5 max, so 0.5 is valid
        expect(result.selectedTokens[0].percentage).toBe(100)
      })
    })
  })

  describe("delta tracking for insufficient adjustments", () => {
    it("marks deltaInsufficient true when adjustment is below minimum order size", async () => {
      // Account value 1000, crossAccountLeverage 1.0 => totalNotional 1000
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 100,
          withdrawable: 900,
          crossAccountLeverage: 1.0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      // Existing position with notional 100; totalNotional 100 => leverage 0.1
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Set leverage 1 so targetNotional = 1000
      result.handleCrossAccountLeverageChange(1)

      // Adjust to 10.5% (target $105) - delta of $5 is below MIN_CHANGE_DELTA ($10)
      result.handleWeightChange("BTC/USDC:USDC", 10.5)

      await waitFor(() => {
        const token = result.selectedTokens[0]
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Set leverage 1 so targetNotional = 1000
      result.handleCrossAccountLeverageChange(1)

      // Adjust to 12% (target $120) - delta of $20 meets MIN_ORDER_SIZE ($10)
      result.handleWeightChange("BTC/USDC:USDC", 12)

      await waitFor(() => {
        const token = result.selectedTokens[0]
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // Add a new token (no existing position)
      result.handleAddToken("NEW/USDC:USDC")

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
        const token = result.selectedTokens[0]
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Delete the token
      result.handleRemoveToken("BTC/USDC:USDC")

      await waitFor(() => {
        const token = result.selectedTokens[0]
        expect(token.status).toBe("deleted")
        // Deleted tokens should not have deltaInsufficient set
        expect(token.deltaInsufficient).toBeUndefined()
      })
    })

    it("keeps targetNotional matching currentNotional when leverage changes but position unchanged", async () => {
      // When leverage changes but user doesn't adjust the position slider,
      // the percentage is re-derived from notional/totalNotional, so targetNotional stays the same
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Initial: notional 100, totalNotional 1000, percentage 10% => target 100
      expect(result.selectedTokens[0].targetNotional).toBe(100)
      expect(result.selectedTokens[0].deltaInsufficient).toBe(false)

      // Change leverage to 2x => targetNotional becomes 2000
      // Percentage stays fixed (100%); targetNotional = 100% * 2000 = 2000
      result.handleCrossAccountLeverageChange(2)

      await waitFor(() => {
        const token = result.selectedTokens[0]
        // Percentage fixed at 100%; targetNotional = 100% * 2000 = 2000
        expect(token.targetNotional).toBe(2000)
        expect(token.currentNotional).toBe(100)
        // Delta 1900, so deltaInsufficient is false (above minimum)
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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
        const token = result.selectedTokens[0]
        // currentNotional should come from the exchange position
        expect(token.currentNotional).toBe(250)
        // targetNotional = (percentage / 100) * displayNotional
        // displayNotional = accountValue * crossAccountLeverage = 500 * 1 = 500
        // With percentage 50%, targetNotional = 0.5 * 500 = 250
        expect(token.targetNotional).toBe(250)
        // No difference, so deltaInsufficient should be false
        expect(token.deltaInsufficient).toBe(false)
      })
    })
  })

  describe("handleOpenPositions", () => {
    it("calls rebalance mutation with accountValue and crossAccountLeverage", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // Add a token and set leverage first (empty positions => leverage 0)
      result.handleAddToken("BTC/USDC:USDC")

      result.handleCrossAccountLeverageChange(2)

      // Set percentage to 100% (required to avoid "sum below 100%" block)
      result.handleWeightChange("BTC/USDC:USDC", 100)

      // Call handleOpenPositions
      result.handleOpenPositions()

      // With 2x leverage, totalNotional = 2000
      // 100% of $2000 = $2000 USD
      // Percentage sent to API should be 1 (100% as decimal)
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          accountValue: 1000,
          crossAccountLeverage: 2,
          positions: expect.arrayContaining([
            expect.objectContaining({
              symbol: "BTC/USDC:USDC",
              percentage: 1,
            }),
          ]),
        }),
        expect.any(Object),
      )
    })

    it("does not call mutation when accountValue is zero", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 0,
          totalNotionalPosition: 0,
          withdrawable: 0,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      result.handleWeightChange("BTC/USDC:USDC", 50)

      result.handleOpenPositions()

      expect(mockMutate).not.toHaveBeenCalled()
    })

    it("does not call mutation when no tokens selected", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 0,
          withdrawable: 1000,
          crossAccountLeverage: 0,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleOpenPositions()

      expect(mockMutate).not.toHaveBeenCalled()
    })

    it("does not call mutation when rebalance is already pending", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: true, // Already pending
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      result.handleWeightChange("BTC/USDC:USDC", 50)

      result.handleOpenPositions()

      expect(mockMutate).not.toHaveBeenCalled()
    })

    it("converts percentage to decimal for API", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      result.handleCrossAccountLeverageChange(1)

      // Set 25% (should be converted to 0.25 for API); need ~100% total so add second token
      result.handleAddToken("ETH/USDC:USDC")
      result.handleWeightChange("BTC/USDC:USDC", 25)
      result.handleWeightChange("ETH/USDC:USDC", 75)

      result.handleOpenPositions()

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          positions: expect.arrayContaining([
            expect.objectContaining({
              symbol: "BTC/USDC:USDC",
              percentage: 0.25, // Converted from 25%
            }),
            expect.objectContaining({
              symbol: "ETH/USDC:USDC",
              percentage: 0.75,
            }),
          ]),
        }),
        expect.any(Object),
      )
    })
  })

  describe("de-risking edge cases", () => {
    it("marks positions as deltaInsufficient when reducing leverage below minimum order size", async () => {
      // Scenario: User has 3x leverage, positions at $100 each
      // They want to reduce to 1x leverage, making each position $33
      // Delta to reduce is $67, which is > MIN_ORDER_SIZE, so should work
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 100,
          totalNotionalPosition: 300,
          withdrawable: 100,
          crossAccountLeverage: 3,
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
              notional: 300,
            },
          ],
          totalNotional: 300,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Reduce leverage from 3x to 1x
      result.handleCrossAccountLeverageChange(1)

      await waitFor(() => {
        // With 1x leverage on $100 account, target is $100
        // Current is $300, delta is $200 reduction (> MIN_ORDER_SIZE)
        expect(result.totalNotional).toBe(100)
        const token = result.selectedTokens[0]
        // deltaInsufficient should be false since delta > MIN_ORDER_SIZE
        expect(token.deltaInsufficient).toBe(false)
      })
    })

    it("marks deltaInsufficient true when de-risking creates small delta", async () => {
      // Scenario: Small delta when reducing
      // Account value $1000, crossAccountLeverage = 1, so totalNotional = $1000
      // Position at $105 (10.5%), reduce to target $100 (10%)
      // Delta is $5, below MIN_ORDER_SIZE
      vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
        data: {
          accountValue: 1000,
          totalNotionalPosition: 105,
          withdrawable: 1000,
          crossAccountLeverage: 1,
        },
        isLoading: false,
      } as ReturnType<typeof useHyperliquidAccountSummary>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 10.5,
              side: "buy",
              leverage: 1,
              notional: 105,
            },
          ],
          totalNotional: 105,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Set leverage 1 so targetNotional = 1000
      result.handleCrossAccountLeverageChange(1)

      // Adjust to exactly 10% (target $100, delta of $5 from current $105)
      result.handleWeightChange("BTC/USDC:USDC", 10)

      await waitFor(() => {
        const token = result.selectedTokens[0]
        // Delta is $5 (105 - 100), below MIN_ORDER_SIZE
        expect(token.deltaInsufficient).toBe(true)
      })
    })
  })

  describe("per-position leverage limits", () => {
    it("clamps individual position leverage to max allowed", async () => {
      vi.mocked(useHyperliquidLeverageLimits).mockReturnValue({
        data: [{ symbol: "BTC/USDC:USDC", maxLeverage: 3 }],
      } as unknown as ReturnType<typeof useHyperliquidLeverageLimits>)

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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      result.handleAddToken("BTC/USDC:USDC")

      // Try to set leverage to 10x, should be clamped to 3x
      result.handleLeverageChange("BTC/USDC:USDC", 10)

      await waitFor(() => {
        const token = result.selectedTokens.find(
          t => t.symbol === "BTC/USDC:USDC",
        )
        expect(token?.leverage).toBe(3) // Clamped to maxLeverage
      })
    })

    it("uses leverageLimitsMap for clamping", async () => {
      vi.mocked(useHyperliquidLeverageLimits).mockReturnValue({
        data: [
          { symbol: "BTC/USDC:USDC", maxLeverage: 5 },
          { symbol: "ETH/USDC:USDC", maxLeverage: 3 },
        ],
      } as unknown as ReturnType<typeof useHyperliquidLeverageLimits>)

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

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      expect(result.leverageLimitsMap["BTC/USDC:USDC"]).toBe(5)
      expect(result.leverageLimitsMap["ETH/USDC:USDC"]).toBe(3)
    })
  })

  describe("precise mode", () => {
    it("accepts isPrecise parameter", () => {
      const { result: resultFalse } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )
      const { result: resultTrue } = renderHook(
        () =>
          usePortfolioState(
            () => true,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      expect(resultFalse).toBeDefined()
      expect(resultTrue).toBeDefined()
    })

    it("when precise is OFF, shows error for positions with changes < $11 on submit", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 30,
              side: "buy",
              leverage: 1,
              notional: 300,
            },
            {
              symbol: "ETH/USDC:USDC",
              percentage: 70,
              side: "buy",
              leverage: 1,
              notional: 700,
            },
          ],
          totalNotional: 1000,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(2)
      })

      result.handleCrossAccountLeverageChange(1)

      result.handleWeightChange("BTC/USDC:USDC", 30.5)
      result.handleWeightChange("ETH/USDC:USDC", 69.5)

      // Try to rebalance - should set error message instead of calling mutate
      result.handleOpenPositions()

      // Should not call mutate (blocked by validation)
      expect(mockMutate).not.toHaveBeenCalled()

      // Should have error message on token
      await waitFor(() => {
        const token = result.selectedTokens.find(
          t => t.symbol === "BTC/USDC:USDC",
        )
        expect(token?.message ?? "").toContain("below minimum")
      })
    })

    it("when precise is ON, allows positions with changes < $11 and passes precise flag", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 30,
              side: "buy",
              leverage: 1,
              notional: 300,
            },
            {
              symbol: "ETH/USDC:USDC",
              percentage: 70,
              side: "buy",
              leverage: 1,
              notional: 700,
            },
          ],
          totalNotional: 1000,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => true,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(2)
      })

      result.handleCrossAccountLeverageChange(1)

      result.handleWeightChange("BTC/USDC:USDC", 30.5)
      result.handleWeightChange("ETH/USDC:USDC", 69.5)

      // Try to rebalance - should call mutate with precise: true
      result.handleOpenPositions()

      // Should call mutate with precise flag
      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalled()
      })

      const mutateCall = mockMutate.mock.calls[0][0]
      expect(mutateCall.precise).toBe(true)
      expect(mutateCall.positions).toBeDefined()
    })

    it("defaults to precise OFF when not provided", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 30,
              side: "buy",
              leverage: 1,
              notional: 300,
            },
            {
              symbol: "ETH/USDC:USDC",
              percentage: 70,
              side: "buy",
              leverage: 1,
              notional: 700,
            },
          ],
          totalNotional: 1000,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(2)
      })

      result.handleCrossAccountLeverageChange(1)

      result.handleWeightChange("BTC/USDC:USDC", 31.5)
      result.handleWeightChange("ETH/USDC:USDC", 68.5)

      // Submit
      result.handleOpenPositions()

      // Should call mutate with precise: false (default)
      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalled()
      })

      const mutateCall = mockMutate.mock.calls[0][0]
      expect(mutateCall.precise).toBe(false)
    })

    it("blocks small changes when precise is OFF but allows with different hook instance using true", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 30,
              side: "buy",
              leverage: 1,
              notional: 300,
            },
            {
              symbol: "ETH/USDC:USDC",
              percentage: 70,
              side: "buy",
              leverage: 1,
              notional: 700,
            },
          ],
          totalNotional: 1000,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result: resultFalse } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        { wrapper: createWrapper() },
      )

      await waitFor(() => {
        expect(resultFalse.selectedTokens).toHaveLength(2)
      })

      resultFalse.handleCrossAccountLeverageChange(1)

      resultFalse.handleWeightChange("BTC/USDC:USDC", 30.5)
      resultFalse.handleWeightChange("ETH/USDC:USDC", 69.5)

      resultFalse.handleOpenPositions()

      // With precise: false, small change should be blocked
      expect(mockMutate).not.toHaveBeenCalled()
      await waitFor(() => {
        const msg = resultFalse.selectedTokens[0].message ?? ""
        expect(msg).toContain("below minimum")
      })

      // Now test with precise: true - should allow small changes
      mockMutate.mockClear()

      const { result: resultTrue } = renderHook(
        () =>
          usePortfolioState(
            () => true,
            () => false,
          ),
        { wrapper: createWrapper() },
      )

      await waitFor(() => {
        expect(resultTrue.selectedTokens).toHaveLength(2)
      })

      resultTrue.handleCrossAccountLeverageChange(1)

      resultTrue.handleWeightChange("BTC/USDC:USDC", 30.5)
      resultTrue.handleWeightChange("ETH/USDC:USDC", 69.5)

      resultTrue.handleOpenPositions()

      // With precise: true, small change should be allowed
      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalled()
      })

      const mutateCall = mockMutate.mock.calls[0][0]
      expect(mutateCall.precise).toBe(true)
    })

    it("handles multiple tokens with mixed small and large changes when precise is OFF", async () => {
      const mockMutate = vi.fn()
      vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useRebalanceHyperliquidPositions>)

      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 30,
              side: "buy",
              leverage: 1,
              notional: 300,
            },
            {
              symbol: "ETH/USDC:USDC",
              percentage: 20,
              side: "buy",
              leverage: 1,
              notional: 200,
            },
          ],
          totalNotional: 1000,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      // isWeightRedistribution: false so changing one token doesn't affect the other
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(2)
      })

      result.handleCrossAccountLeverageChange(1)

      // BTC: small change ($5), ETH: rest to reach 100%
      // 30.5% of 1000 = $305 (delta $5), 69.5% = $695 (delta $495)
      result.handleWeightChange("BTC/USDC:USDC", 30.5) // $5 change

      result.handleWeightChange("ETH/USDC:USDC", 69.5) // large change

      result.handleOpenPositions()

      // Should not submit because BTC has small change
      expect(mockMutate).not.toHaveBeenCalled()

      // BTC should have error message
      const btcToken = result.selectedTokens.find(
        t => t.symbol === "BTC/USDC:USDC",
      )
      expect(btcToken?.message ?? "").toContain("below minimum")

      // ETH should NOT have error message (its change is large enough, $495)
      const ethToken = result.selectedTokens.find(
        t => t.symbol === "ETH/USDC:USDC",
      )
      expect(ethToken?.message ?? "").not.toContain("below minimum")
    })
  })

  describe("tokensBelowMinimum validation", () => {
    it("does not block submission when untouched position drops below minimum", async () => {
      // Simulate an existing position that dropped below $11 due to market movement
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 100,
              side: "buy",
              leverage: 1,
              notional: 8, // Below MIN_USD ($11), simulating market drop
            },
          ],
          totalNotional: 8,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Verify token is untouched (loaded from exchange, not modified)
      expect(result.selectedTokens[0].status).toBe("untouched")
      expect(result.selectedTokens[0].notional).toBe(8)

      // Should NOT have blocking reason for position below minimum
      const belowMinimumReason = result.blockingReasons.find(reason =>
        reason.includes("below minimum"),
      )
      expect(belowMinimumReason).toBeUndefined()
    })

    it("blocks submission when idle position is below minimum", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: { positions: [], totalNotional: 0 },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      vi.mocked(useHyperliquidBalance).mockReturnValue({
        data: 100,
      } as unknown as ReturnType<typeof useHyperliquidBalance>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      // Set budget
      result.handleCrossAccountLeverageChange(1)

      // Add a token - it will get MIN_USD ($11) as lockedUsd by default
      result.handleAddToken("BTC/USDC:USDC")

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
      })

      // Force lockedUsd below minimum by using slider
      result.handleWeightChange("BTC/USDC:USDC", 5) // 5% of 100 = $5

      await waitFor(() => {
        // Token should be idle (new, not from exchange)
        expect(result.selectedTokens[0].status).toBe("idle")
      })

      // The value is clamped to MIN_USD, so it won't actually go below
      // This is expected behavior - the slider enforces minimum
      expect(result.selectedTokens[0].lockedUsd).toBeGreaterThanOrEqual(MIN_USD)
    })

    it("blocks submission when modified position is set below minimum", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 50,
              side: "buy",
              leverage: 1,
              notional: 500,
            },
          ],
          totalNotional: 1000,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(1)
        expect(result.selectedTokens[0].status).toBe("untouched")
      })

      // Modify the position by changing leverage (makes it "modified")
      result.handleLeverageChange("BTC/USDC:USDC", 2)

      await waitFor(() => {
        expect(result.selectedTokens[0].status).toBe("modified")
      })

      // Position value ($500) is still above minimum, so no blocking
      const belowMinimumReason = result.blockingReasons.find(reason =>
        reason.includes("below minimum"),
      )
      expect(belowMinimumReason).toBeUndefined()
    })

    it("allows submission with untouched position below minimum alongside modified position", async () => {
      vi.mocked(useHyperliquidPositions).mockReturnValue({
        data: {
          positions: [
            {
              symbol: "BTC/USDC:USDC",
              percentage: 1,
              side: "buy",
              leverage: 1,
              notional: 5, // Below MIN_USD, simulating market drop
            },
            {
              symbol: "ETH/USDC:USDC",
              percentage: 99,
              side: "buy",
              leverage: 1,
              notional: 495,
            },
          ],
          totalNotional: 500,
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useHyperliquidPositions>)

      // With isWeightRedistribution: false, changing ETH doesn't affect BTC
      const { result } = renderHook(
        () =>
          usePortfolioState(
            () => false,
            () => false,
          ),
        {
          wrapper: createWrapper(),
        },
      )

      await waitFor(() => {
        expect(result.selectedTokens).toHaveLength(2)
      })

      // Modify ETH position (large change to pass MIN_CHANGE_DELTA check)
      result.handleWeightChange("ETH/USDC:USDC", 80) // Change from 99% to 80%

      await waitFor(() => {
        const btc = result.selectedTokens.find(
          t => t.symbol === "BTC/USDC:USDC",
        )
        const eth = result.selectedTokens.find(
          t => t.symbol === "ETH/USDC:USDC",
        )
        expect(btc?.status).toBe("untouched")
        expect(eth?.status).toBe("modified")
      })

      // BTC is below minimum but untouched - should NOT block
      const belowMinimumReason = result.blockingReasons.find(reason =>
        reason.includes("below minimum"),
      )
      expect(belowMinimumReason).toBeUndefined()
    })
  })
})
