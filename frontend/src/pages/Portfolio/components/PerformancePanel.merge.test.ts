import { describe, expect, it } from "vitest"

import { mergeEquitySeries } from "@/pages/Portfolio/components/PerformancePanel"
import type { VenuePerformanceSeries } from "@/services/account-performance"

describe("mergeEquitySeries", () => {
  it("forward-fills sparse venues then sums", () => {
    const hyperliquid: VenuePerformanceSeries = {
      venue: "hyperliquid",
      equity_points: [
        { timestamp_ms: 1_000, value_usd: "100" },
        { timestamp_ms: 3_000, value_usd: "110" },
      ],
      events: [],
      fetched_at: "2026-01-01T00:00:00Z",
      coverage_start_ms: 1_000,
      coverage_end_ms: 3_000,
    }
    const derive: VenuePerformanceSeries = {
      venue: "derive",
      equity_points: [
        { timestamp_ms: 2_000, value_usd: "50" },
        { timestamp_ms: 3_000, value_usd: "60" },
      ],
      events: [],
      fetched_at: "2026-01-01T00:00:00Z",
      coverage_start_ms: 2_000,
      coverage_end_ms: 3_000,
    }

    expect(mergeEquitySeries([hyperliquid, derive])).toEqual([
      { timestamp_ms: 1_000, value_usd: "100" },
      { timestamp_ms: 2_000, value_usd: "150" },
      { timestamp_ms: 3_000, value_usd: "170" },
    ])
  })
})
