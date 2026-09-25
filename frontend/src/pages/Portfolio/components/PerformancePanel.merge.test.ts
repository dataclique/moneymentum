import { describe, expect, it } from "vitest"

import {
  chartableEquityPoints,
  equityPriceScaleRange,
  mergeEquitySeries,
} from "@/pages/Portfolio/components/PerformancePanel"
import type { VenuePerformanceSeries } from "@/services/account-performance"

const venueSeries = (
  venue: VenuePerformanceSeries["venue"],
  equity_points: VenuePerformanceSeries["equity_points"],
): VenuePerformanceSeries => ({
  venue,
  equity_points,
  events: [],
  fetched_at: "2026-01-01T00:00:00Z",
  coverage_start_ms: equity_points[0]?.timestamp_ms ?? 0,
  coverage_end_ms: equity_points[equity_points.length - 1]?.timestamp_ms ?? 0,
})

describe("mergeEquitySeries", () => {
  it("sums overlapping venue samples on the same second", () => {
    const hyperliquid = venueSeries("hyperliquid", [
      { timestamp_ms: 1_000, value_usd: "100" },
      { timestamp_ms: 2_000, value_usd: "110" },
    ])
    const derive = venueSeries("derive", [
      { timestamp_ms: 1_000, value_usd: "50" },
      { timestamp_ms: 3_000, value_usd: "60" },
    ])

    // LOCF: at t=2s Derive still contributes 50; at t=3s HL still contributes 110.
    expect(mergeEquitySeries([hyperliquid, derive])).toEqual([
      { timestamp_ms: 1_000, value_usd: "150" },
      { timestamp_ms: 2_000, value_usd: "160" },
      { timestamp_ms: 3_000, value_usd: "170" },
    ])
  })

  it("carries the last Hyperliquid balance across Derive-only timestamps", () => {
    const hyperliquid = venueSeries("hyperliquid", [
      { timestamp_ms: 1_000, value_usd: "111" },
    ])
    const derive = venueSeries("derive", [
      { timestamp_ms: 2_000, value_usd: "99667" },
      { timestamp_ms: 3_000, value_usd: "99700" },
    ])

    expect(mergeEquitySeries([hyperliquid, derive])).toEqual([
      { timestamp_ms: 1_000, value_usd: "111" },
      { timestamp_ms: 2_000, value_usd: "99778" },
      { timestamp_ms: 3_000, value_usd: "99811" },
    ])
  })

  it("treats the period before a venue's first sample as zero", () => {
    const derive = venueSeries("derive", [
      { timestamp_ms: 5_000, value_usd: "50000" },
    ])
    const hyperliquid = venueSeries("hyperliquid", [
      { timestamp_ms: 1_000, value_usd: "0" },
      { timestamp_ms: 2_000, value_usd: "100" },
    ])

    expect(mergeEquitySeries([hyperliquid, derive])).toEqual([
      { timestamp_ms: 1_000, value_usd: "0" },
      { timestamp_ms: 2_000, value_usd: "100" },
      { timestamp_ms: 5_000, value_usd: "50100" },
    ])
  })

  it("skips non-finite and negative venue samples", () => {
    const hyperliquid = venueSeries("hyperliquid", [
      { timestamp_ms: 1_000, value_usd: "100" },
      { timestamp_ms: 2_000, value_usd: "not-a-number" },
      { timestamp_ms: 3_000, value_usd: "-5" },
      { timestamp_ms: 4_000, value_usd: "120" },
    ])

    expect(mergeEquitySeries([hyperliquid])).toEqual([
      { timestamp_ms: 1_000, value_usd: "100" },
      { timestamp_ms: 4_000, value_usd: "120" },
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
