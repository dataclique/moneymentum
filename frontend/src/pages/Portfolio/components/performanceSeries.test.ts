import { describe, expect, it } from "vitest"

import type { VenuePerformanceSeries } from "@/services/account-performance"

import {
  filterEquityOutliers,
  forwardFillMergeEquity,
  resampleEquityPoints,
  twrPercentSeries,
  underwaterDrawdownSeries,
} from "./performanceSeries"

const venue = (
  name: "hyperliquid" | "derive",
  points: { timestamp_ms: number; value_usd: string }[],
  events: VenuePerformanceSeries["events"] = [],
): VenuePerformanceSeries => ({
  venue: name,
  equity_points: points,
  events,
  fetched_at: "2026-01-01T00:00:00Z",
  coverage_start_ms: points[0]?.timestamp_ms ?? null,
  coverage_end_ms: points[points.length - 1]?.timestamp_ms ?? null,
})

describe("filterEquityOutliers", () => {
  it("replaces a 99 percent glitch with the previous value", () => {
    const filtered = filterEquityOutliers([
      { timestamp_ms: 1_000, value_usd: "100" },
      { timestamp_ms: 2_000, value_usd: "0.5" },
      { timestamp_ms: 3_000, value_usd: "101" },
    ])
    expect(filtered).toEqual([
      { timestamp_ms: 1_000, value_usd: "100" },
      { timestamp_ms: 2_000, value_usd: "100" },
      { timestamp_ms: 3_000, value_usd: "101" },
    ])
  })
})

describe("resampleEquityPoints", () => {
  it("keeps the last sample in each hour bucket", () => {
    const hour = 3_600_000
    const resampled = resampleEquityPoints(
      [
        { timestamp_ms: hour + 10, value_usd: "1" },
        { timestamp_ms: hour + 20, value_usd: "2" },
        { timestamp_ms: 2 * hour + 5, value_usd: "3" },
      ],
      hour,
    )
    expect(resampled).toHaveLength(2)
    expect(resampled[0]?.value_usd).toBe("2")
    expect(resampled[1]?.value_usd).toBe("3")
  })
})

describe("forwardFillMergeEquity", () => {
  it("carries sparse venue equity forward before summing", () => {
    const merged = forwardFillMergeEquity([
      venue("hyperliquid", [
        { timestamp_ms: 1_000, value_usd: "100" },
        { timestamp_ms: 3_000, value_usd: "110" },
      ]),
      venue("derive", [
        { timestamp_ms: 2_000, value_usd: "50" },
        { timestamp_ms: 3_000, value_usd: "55" },
      ]),
    ])
    expect(merged).toEqual([
      { timestamp_ms: 1_000, value_usd: "100" },
      { timestamp_ms: 2_000, value_usd: "150" },
      { timestamp_ms: 3_000, value_usd: "165" },
    ])
  })
})

describe("twrPercentSeries", () => {
  it("does not treat a deposit jump as return", () => {
    const series = twrPercentSeries(
      [
        { timestamp_ms: 1_000, value_usd: "100" },
        { timestamp_ms: 2_000, value_usd: "150" },
        { timestamp_ms: 3_000, value_usd: "165" },
      ],
      [
        {
          kind: "deposit",
          timestamp_ms: 2_000,
          amount_usd: "50",
          source_id: "dep-1",
        },
      ],
    )
    expect(series[0]?.value).toBeCloseTo(0, 5)
    expect(series[1]?.value).toBeCloseTo(0, 5)
    expect(series[2]?.value).toBeCloseTo(10, 5)
  })
})

describe("underwaterDrawdownSeries", () => {
  it("reports drawdown from peak as non-positive percent", () => {
    const series = underwaterDrawdownSeries(
      [
        { timestamp_ms: 1_000, value_usd: "100" },
        { timestamp_ms: 2_000, value_usd: "120" },
        { timestamp_ms: 3_000, value_usd: "90" },
      ],
      [],
    )
    expect(series[0]?.value).toBeCloseTo(0, 5)
    expect(series[1]?.value).toBeCloseTo(0, 5)
    expect(series[2]?.value).toBeCloseTo(-25, 5)
  })
})
