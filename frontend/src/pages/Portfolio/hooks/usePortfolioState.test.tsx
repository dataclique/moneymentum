import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ParentProps } from "solid-js"

import { MIN_USD, usePortfolioState } from "./usePortfolioState"
import {
  useHyperliquidAccountSummary,
  useHyperliquidLeverageLimits,
  useHyperliquidPositions,
  useRebalanceHyperliquidPositions,
} from "@/hooks/useTrading"

vi.mock("@/hooks/useTrading", () => ({
  useHyperliquidAccountSummary: vi.fn(),
  useHyperliquidPositions: vi.fn(),
  useHyperliquidLeverageLimits: vi.fn(),
  useRebalanceHyperliquidPositions: vi.fn(),
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: vi.fn(() => ({
    networkMode: () => "testnet",
    isConnected: () => true,
  })),
}))

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (props: ParentProps) => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  )
}

describe("usePortfolioState", () => {
  const mutate = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useHyperliquidAccountSummary).mockReturnValue({
      data: {
        accountValue: 1000,
        totalNotionalPosition: 1000,
        withdrawable: 500,
        crossAccountLeverage: 1,
      },
      isLoading: false,
    } as ReturnType<typeof useHyperliquidAccountSummary>)

    vi.mocked(useHyperliquidPositions).mockReturnValue({
      data: {
        positions: [
          {
            symbol: "BTC/USDC:USDC",
            side: "buy",
            leverage: 2,
            notional: 600,
            percentage: 60,
          },
          {
            symbol: "ETH/USDC:USDC",
            side: "buy",
            leverage: 3,
            notional: 400,
            percentage: 40,
          },
        ],
        totalNotional: 1000,
      },
      isLoading: false,
    } as ReturnType<typeof useHyperliquidPositions>)

    vi.mocked(useHyperliquidLeverageLimits).mockReturnValue({
      data: [
        { symbol: "BTC/USDC:USDC", maxLeverage: 5 },
        { symbol: "ETH/USDC:USDC", maxLeverage: 7 },
        { symbol: "SOL/USDC:USDC", maxLeverage: 10 },
      ],
      isLoading: false,
    } as ReturnType<typeof useHyperliquidLeverageLimits>)

    vi.mocked(useRebalanceHyperliquidPositions).mockReturnValue({
      mutate,
      isPending: false,
    } as ReturnType<typeof useRebalanceHyperliquidPositions>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("exports MIN_USD", () => {
    expect(MIN_USD).toBe(11)
  })

  it("loads current and target portfolios from exchange positions", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.currentPortfolio)).toHaveLength(2)
      expect(Object.keys(result.targetPortfolio)).toHaveLength(2)
    })

    expect(result.currentPortfolio["BTC/USDC:USDC"]?.notional).toBe(600)
    expect(result.targetPortfolio["ETH/USDC:USDC"]?.notional).toBe(400)
    expect(result.currentTotalNotional).toBe(1000)
    expect(result.targetTotalNotional).toBe(1000)
  })

  it("adds and removes token in target portfolio", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toHaveLength(2)
    })

    result.handleAddToken("SOL/USDC:USDC")
    expect(result.targetPortfolio["SOL/USDC:USDC"]?.notional).toBe(MIN_USD)

    result.handleRemoveToken("SOL/USDC:USDC")
    expect(result.targetPortfolio["SOL/USDC:USDC"]).toBeUndefined()
  })

  it("archives a removed exchange position and restores it on undo", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toHaveLength(2)
    })

    result.handleRemoveToken("BTC/USDC:USDC")

    expect(result.targetPortfolio["BTC/USDC:USDC"]).toBeUndefined()
    expect(result.deletedArchive["BTC/USDC:USDC"]?.notional).toBe(600)
    expect(result.targetTotalNotional).toBe(400)

    result.handleUndoRemoveToken("BTC/USDC:USDC")

    expect(result.targetPortfolio["BTC/USDC:USDC"]?.notional).toBe(600)
    expect(result.deletedArchive["BTC/USDC:USDC"]).toBeUndefined()
    expect(result.targetTotalNotional).toBe(1000)
  })

  it("stages a close trade and dispatches a close action for a removed exchange position", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toHaveLength(2)
    })

    result.handleRemoveToken("BTC/USDC:USDC")

    await waitFor(() => {
      expect(result.stagedTrades.map(trade => trade.underlying)).toContain(
        "BTC/USDC:USDC",
      )
    })

    const closeTrade = result.stagedTrades.find(
      trade => trade.underlying === "BTC/USDC:USDC",
    )
    expect(closeTrade?.side).toBe("sell")
    expect(closeTrade?.notional).toBe(600)

    result.handleRebalancePositions()

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: expect.arrayContaining([
          {
            kind: "close",
            symbol: "BTC/USDC:USDC",
            side: "buy",
          },
        ]),
      }),
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    )
  })

  it("clamps per-symbol leverage to max from leverage limits", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toContain("BTC/USDC:USDC")
    })

    result.handleLeverageChange("BTC/USDC:USDC", 999)
    expect(result.targetPortfolio["BTC/USDC:USDC"]?.leverage).toBe(5)
  })

  it("builds staged trades from diff after target changes", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toHaveLength(2)
    })

    result.handleNotionalChange("BTC/USDC:USDC", 700)

    await waitFor(() => {
      expect(result.stagedTrades.length).toBeGreaterThan(0)
    })

    expect(result.stagedTrades[0]?.underlying).toBe("BTC/USDC:USDC")
  })

  it("blocks submit in non-precise mode when delta is below minimum", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toContain("BTC/USDC:USDC")
    })

    result.handleNotionalChange("BTC/USDC:USDC", 605)
    await waitFor(() => {
      expect(result.symbolsDeltaBelowMinimum).toContain("BTC/USDC:USDC")
    })

    expect(result.canSubmit).toBe(false)
  })

  it("allows submit in precise mode for small deltas", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toContain("BTC/USDC:USDC")
    })

    result.setIsPrecise(true)

    result.handleNotionalChange("BTC/USDC:USDC", 605)
    await waitFor(() => {
      expect(result.symbolsDeltaBelowMinimum).toContain("BTC/USDC:USDC")
    })

    expect(result.canSubmit).toBe(true)
  })

  it("redistributes other positions when weight redistribution is enabled", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toHaveLength(2)
    })

    const beforeEth = result.targetPortfolio["ETH/USDC:USDC"]?.notional ?? 0
    result.handleWeightChange("BTC/USDC:USDC", 80)
    const afterEth = result.targetPortfolio["ETH/USDC:USDC"]?.notional ?? 0

    expect(afterEth).toBeLessThan(beforeEth)
    expect(result.targetPortfolio["BTC/USDC:USDC"]?.notional).toBeCloseTo(
      800,
      3,
    )
  })

  it("shapes a small delta into a preciseRebalance action when precise mode is on", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toContain("BTC/USDC:USDC")
    })

    result.setIsPrecise(true)

    // 600 -> 605 is a +5 signed delta, strictly between NOTIONAL_EPSILON (0.1)
    // and MIN_USD (11), so the precise branch fires: close MIN_USD then reopen
    // the closed notional plus the delta.
    result.handleNotionalChange("BTC/USDC:USDC", 605)
    result.handleRebalancePositions()

    expect(mutate).toHaveBeenCalledWith(
      {
        actions: [
          expect.objectContaining({
            kind: "preciseRebalance",
            symbol: "BTC/USDC:USDC",
            side: "buy",
            leverage: 2,
            leverageChanged: false,
            closeNotional: MIN_USD,
            openNotional: MIN_USD + 5,
          }),
        ],
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    )
  })

  it("keeps a small delta as a plain rebalance action when precise mode is off", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toContain("BTC/USDC:USDC")
    })

    result.handleNotionalChange("BTC/USDC:USDC", 605)
    result.handleRebalancePositions()

    expect(mutate).toHaveBeenCalledWith(
      {
        actions: [
          expect.objectContaining({
            kind: "rebalance",
            symbol: "BTC/USDC:USDC",
            signedNotionalDelta: 5,
            leverage: 2,
            leverageChanged: false,
          }),
        ],
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    )
  })

  it("emits a plain rebalance action for large deltas even in precise mode", async () => {
    const { result } = renderHook(() => usePortfolioState(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(Object.keys(result.targetPortfolio)).toContain("BTC/USDC:USDC")
    })

    result.setIsPrecise(true)

    // 600 -> 700 is a +100 delta, well above MIN_USD, so the precise branch is
    // skipped and the action stays a plain rebalance regardless of the toggle.
    result.handleNotionalChange("BTC/USDC:USDC", 700)
    result.handleRebalancePositions()

    expect(mutate).toHaveBeenCalledWith(
      {
        actions: [
          expect.objectContaining({
            kind: "rebalance",
            symbol: "BTC/USDC:USDC",
            signedNotionalDelta: 100,
            leverage: 2,
            leverageChanged: false,
          }),
        ],
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    )
  })
})
