import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ParentProps } from "solid-js"

import type { PortfolioInterface } from "./usePortfolioState"
import { useRisk, type RiskReport } from "./useRisk"

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
    side: "sell",
    leverage: 1,
    notional: 40,
  },
})
const targetTotalNotional = () => 100

const riskReport: RiskReport = {
  contract: {
    window: { lookbackDays: 90 },
    samplingFrequency: "daily",
    confidenceLevels: [0.9, 0.95, 0.99],
  },
  tailRisk: [
    { confidenceLevel: 0.9, var: 0.021, cvar: 0.034 },
    { confidenceLevel: 0.95, var: 0.029, cvar: 0.041 },
    { confidenceLevel: 0.99, var: 0.052, cvar: 0.052 },
  ],
  drawdown: { maxDrawdown: 0.18, peakToTroughPeriods: 12 },
  correlation: {
    tickers: ["BTC", "ETH"],
    matrix: [
      [1, 0.82],
      [0.82, 1],
    ],
    shrinkageIntensity: 0.07,
  },
  effectiveBets: {
    meucci: 1.4,
    stressedMeucci: 1.1,
    inverseHerfindahl: 1.92,
  },
}

describe("useRisk", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => riskReport,
    })
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("posts signed active-position weights and exposes the report", async () => {
    const { result } = renderHook(
      () => useRisk(targetPortfolio, targetTotalNotional, () => []),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.report).not.toBeNull()
    })

    const [requestUrl, requestInit] = fetchMock.mock.lastCall as [
      string,
      { body: string },
    ]
    expect(requestUrl).toContain("api/risk")
    const callBody = JSON.parse(requestInit.body) as {
      weights: Record<string, number>
    }
    expect(callBody.weights.BTC).toBeCloseTo(0.6, 6)
    expect(callBody.weights.ETH).toBeCloseTo(-0.4, 6)

    expect(result.report?.tailRisk).toHaveLength(3)
    expect(result.report?.drawdown.maxDrawdown).toBeCloseTo(0.18, 6)
    expect(result.report?.effectiveBets.meucci).toBeCloseTo(1.4, 6)
    expect(result.report?.correlation.tickers).toEqual(["BTC", "ETH"])
  })

  it("does not fetch when the portfolio has no positions", async () => {
    const { result } = renderHook(
      () =>
        useRisk(
          () => ({}),
          () => 0,
          () => [],
        ),
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(result.isLoading).toBe(false)
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.report).toBeNull()
  })

  it("surfaces the backend error message on failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        error: "no candle data for DOGE in the measurement window",
      }),
    })

    const { result } = renderHook(
      () => useRisk(targetPortfolio, targetTotalNotional, () => []),
      { wrapper: createWrapper() },
    )

    // The hook retries twice with backoff before surfacing the failure.
    await waitFor(
      () => {
        expect(result.error).not.toBeNull()
      },
      { timeout: 10_000 },
    )

    expect(String(result.error)).toContain(
      "no candle data for DOGE in the measurement window",
    )
  })
})
