import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ParentProps } from "solid-js"

import type { PortfolioInterface } from "./usePortfolioState"
import { useBeta } from "./useBeta"
import type { ReadonlyBetaPosition } from "./useReadonlyPortfolioState"

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return (props: ParentProps) => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  )
}

const targetPortfolio = (): Record<string, PortfolioInterface | undefined> => ({
  "BTC/USDC:USDC": {
    symbol: "BTC/USDC:USDC",
    side: "buy",
    leverage: 1,
    notional: 60,
  },
  "ETH/USDC:USDC": {
    symbol: "ETH/USDC:USDC",
    side: "buy",
    leverage: 1,
    notional: 40,
  },
})
const targetTotalNotional = () => 100

describe("useBeta", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ beta: 1.23 }),
    })
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("includes readonly btc notional in beta weights when includeInBeta is true", async () => {
    const readonlyPositions = (): ReadonlyBetaPosition[] => [
      {
        symbol: "BTC",
        side: "buy",
        notionalUsd: 100,
        includeInBeta: true,
      },
    ]

    const { result } = renderHook(
      () => useBeta(targetPortfolio, targetTotalNotional, readonlyPositions),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.beta).toBe(1.23)
    })

    const callBody = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body)) as {
      weights: Record<string, number>
    }
    expect(callBody.weights.BTC).toBeCloseTo(0.8, 6)
    expect(callBody.weights.ETH).toBeCloseTo(0.2, 6)
  })

  it("excludes readonly btc notional from beta weights when includeInBeta is false", async () => {
    const readonlyPositions = (): ReadonlyBetaPosition[] => [
      {
        symbol: "BTC",
        side: "buy",
        notionalUsd: 100,
        includeInBeta: false,
      },
    ]

    const { result } = renderHook(
      () => useBeta(targetPortfolio, targetTotalNotional, readonlyPositions),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.beta).toBe(1.23)
    })

    const callBody = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body)) as {
      weights: Record<string, number>
    }
    expect(callBody.weights.BTC).toBeCloseTo(0.6, 6)
    expect(callBody.weights.ETH).toBeCloseTo(0.4, 6)
  })
})
