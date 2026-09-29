import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import type { Coordinate, MouseEventParams, Time } from "lightweight-charts"

import { PerformancePanel } from "./PerformancePanel"

type ChartSample = { time: Time; value: number }
const chartProbe = vi.hoisted(() => {
  const series: { samples: readonly ChartSample[] }[] = []
  const listeners: ((event: MouseEventParams) => void)[] = []
  return { series, listeners }
})

vi.mock("lightweight-charts", () => ({
  AreaSeries: "area",
  LineSeries: "line",
  CrosshairMode: { Normal: 0 },
  LineStyle: { Dashed: 2 },
  createChart: () => ({
    addSeries: () => {
      const recorded: { samples: readonly ChartSample[] } = { samples: [] }
      chartProbe.series.push(recorded)
      return {
        setData: (samples: readonly ChartSample[]) => {
          recorded.samples = samples
        },
        createPriceLine: vi.fn(),
      }
    },
    priceScale: () => ({ applyOptions: vi.fn() }),
    timeScale: () => ({
      fitContent: vi.fn(),
      getVisibleLogicalRange: () => null,
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
    subscribeCrosshairMove: (listener: (event: MouseEventParams) => void) => {
      chartProbe.listeners.push(listener)
    },
    unsubscribeCrosshairMove: vi.fn(),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  }),
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    mainAddress: () => "0x1111111111111111111111111111111111111111",
    networkMode: () => "mainnet",
    deriveCredentials: () => null,
    isHyperliquidConnected: () => true,
    isDeriveConnected: () => false,
    isDeriveLocked: () => false,
  }),
}))
vi.mock("@tanstack/solid-query", () => ({
  useQuery: () => ({
    isEnabled: true,
    isLoading: false,
    isError: false,
    error: null,
    data: [
      {
        venue: "hyperliquid",
        equity_points: [
          {
            timestamp_ms: Date.parse("2026-09-01T00:00:00Z"),
            value_usd: "100",
          },
          {
            timestamp_ms: Date.parse("2026-09-02T00:00:00Z"),
            value_usd: "110",
          },
        ],
        events: [],
        fetched_at: "2026-09-02T12:00:00Z",
        coverage_start_ms: Date.parse("2026-09-01T00:00:00Z"),
        coverage_end_ms: Date.parse("2026-09-02T00:00:00Z"),
      },
    ],
  }),
}))
vi.mock("../../Prototype/components/MetricSelector", () => ({
  MetricSelector: () => null,
}))

beforeEach(() => {
  chartProbe.series.length = 0
  chartProbe.listeners.length = 0
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T12:00:00Z"))
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("PerformancePanel crosshair values", () => {
  it.each([
    { barIndex: 0, equity: 100 },
    { barIndex: 1, equity: 110 },
  ])(
    "shows the plotted equity for bucket $barIndex, not the preceding bucket",
    async ({ barIndex, equity }) => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      render(() => <PerformancePanel />)
      await waitFor(() => {
        expect(chartProbe.listeners).toHaveLength(1)
      })
      const totalSeries = chartProbe.series.find(
        (_series, index) => index === 0,
      )
      const plottedBar = totalSeries?.samples.find(
        (_sample, index) => index === barIndex,
      )
      const onCrosshair = chartProbe.listeners.find(
        (_listener, index) => index === 0,
      )
      if (plottedBar === undefined || onCrosshair === undefined) {
        expect.fail(
          "Expected the real panel to populate the chart and register its crosshair callback",
        )
      }

      onCrosshair({
        time: plottedBar.time,
        point: { x: 100 as Coordinate, y: 40 as Coordinate },
        seriesData: new Map(),
      })

      const totalLabel = screen.queryByText("Total")
      expect(totalLabel).not.toBeNull()
      expect(totalLabel?.parentElement?.textContent).toContain(
        equity.toLocaleString(undefined, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        }),
      )
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )
})
