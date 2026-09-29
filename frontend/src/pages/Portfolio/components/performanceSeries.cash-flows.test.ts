import { afterEach, describe, expect, it, vi } from "vitest"

import { twrPercentSeries, underwaterDrawdownSeries } from "./performanceSeries"

const sameInstantFlows = [
  {
    label: "two deposits",
    openingEquity: "100",
    closingEquity: "200",
    events: [
      { kind: "deposit", amount_usd: "50" },
      { kind: "deposit", amount_usd: "50" },
    ],
  },
  {
    label: "two withdrawals",
    openingEquity: "200",
    closingEquity: "100",
    events: [
      { kind: "withdraw", amount_usd: "50" },
      { kind: "withdraw", amount_usd: "50" },
    ],
  },
  {
    label: "offsetting deposit and withdrawal",
    openingEquity: "100",
    closingEquity: "100",
    events: [
      { kind: "deposit", amount_usd: "50" },
      { kind: "withdraw", amount_usd: "50" },
    ],
  },
  {
    label: "mixed net deposit",
    openingEquity: "100",
    closingEquity: "150",
    events: [
      { kind: "deposit", amount_usd: "70" },
      { kind: "withdraw", amount_usd: "20" },
    ],
  },
] as const

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each([
  { metric: "TWR", buildSeries: twrPercentSeries },
  { metric: "drawdown", buildSeries: underwaterDrawdownSeries },
])("$metric cash-flow isolation", ({ buildSeries }) => {
  it.each(sameInstantFlows)(
    "does not manufacture performance from $label at one valuation",
    ({ openingEquity, closingEquity, events }) => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const series = buildSeries(
        [
          { timestamp_ms: 1_000, value_usd: openingEquity },
          { timestamp_ms: 2_000, value_usd: closingEquity },
        ],
        events.map((event, index) => ({
          ...event,
          timestamp_ms: 2_000,
          source_id: `flow-${index}`,
        })),
      )

      expect(series.map(point => point.timestamp_ms)).toEqual([1_000, 2_000])
      expect(series[0]?.value).toBeCloseTo(0, 10)
      expect(series[1]?.value).toBeCloseTo(0, 10)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )
})
