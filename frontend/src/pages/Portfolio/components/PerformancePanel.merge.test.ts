import { describe, expect, it } from "vitest"

import {
  chartableEquityPoints,
  equityPriceScaleRange,
  mergeEquitySeries,
} from "@/pages/Portfolio/components/PerformancePanel"
import type { VenuePerformanceSeries } from "@/services/account-performance"

describe("mergeEquitySeries", () => {
  it("sums overlapping venue samples on the same second", () => {
    const hyperliquid: VenuePerformanceSeries = {
      venue: "hyperliquid",
      equity_points: [
        { timestamp_ms: 1_000, value_usd: "100" },
        { timestamp_ms: 2_000, value_usd: "110" },
      ],
      events: [],
      fetched_at: "2026-01-01T00:00:00Z",
      coverage_start_ms: 1_000,
      coverage_end_ms: 2_000,
    }
    const derive: VenuePerformanceSeries = {
      venue: "derive",
      equity_points: [
        { timestamp_ms: 1_000, value_usd: "50" },
        { timestamp_ms: 3_000, value_usd: "60" },
      ],
      events: [],
      fetched_at: "2026-01-01T00:00:00Z",
      coverage_start_ms: 1_000,
      coverage_end_ms: 3_000,
    }

    expect(mergeEquitySeries([hyperliquid, derive])).toEqual([
      { timestamp_ms: 1_000, value_usd: "150" },
      { timestamp_ms: 2_000, value_usd: "110" },
      { timestamp_ms: 3_000, value_usd: "60" },
    ])
  })

  it("skips zero and non-finite venue samples", () => {
    const hyperliquid: VenuePerformanceSeries = {
      venue: "hyperliquid",
      equity_points: [
        { timestamp_ms: 1_000, value_usd: "100" },
        { timestamp_ms: 2_000, value_usd: "0" },
        { timestamp_ms: 3_000, value_usd: "not-a-number" },
      ],
      events: [],
      fetched_at: "2026-01-01T00:00:00Z",
      coverage_start_ms: 1_000,
      coverage_end_ms: 3_000,
    }

    expect(mergeEquitySeries([hyperliquid])).toEqual([
      { timestamp_ms: 1_000, value_usd: "100" },
    ])
  })
})

describe("chartableEquityPoints", () => {
  it("keeps only strictly positive finite equity", () => {
    expect(
      chartableEquityPoints([
        { timestamp_ms: 1, value_usd: "10" },
        { timestamp_ms: 2, value_usd: "0" },
        { timestamp_ms: 3, value_usd: "-1" },
        { timestamp_ms: 4, value_usd: "bad" },
      ]),
    ).toEqual([{ timestamp_ms: 1, value_usd: "10" }])
  })
})

describe("equityPriceScaleRange", () => {
  it("expands a tiny swing to at least five percent of mid", () => {
    const range = equityPriceScaleRange([100_000, 100_010])
    expect(range).not.toBeNull()
    if (range === null) return
    const mid = 100_005
    const minSpan = mid * 0.05
    expect(range.maxValue - range.minValue).toBeGreaterThanOrEqual(
      minSpan * 1.1,
    )
  })

  it("ignores zeros when computing the scale", () => {
    const range = equityPriceScaleRange([0, 50_000, 50_100])
    expect(range).not.toBeNull()
    if (range === null) return
    expect(range.minValue).toBeGreaterThan(0)
  })
})
