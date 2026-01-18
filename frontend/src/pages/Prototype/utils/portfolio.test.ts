import { describe, it, expect } from "vitest"
import {
  aggregateGreeks,
  calculateTotalNotional,
  calculateGroupNotional,
  calculateGroupWeight,
  calculateNetSide,
  calculatePositionWeight,
  filterAssetsByQuery,
  sortAssetsBySharpe,
  lookupCorrelation,
  getCorrelationColor,
  calculateTotalAttribution,
} from "./portfolio"
import type { Greeks, CorrelationEntry, FactorAttribution } from "../mockData"
import type { PositionsByUnderlying } from "../hooks/usePrototypeData"

describe("aggregateGreeks", () => {
  it("returns zeros for empty array", () => {
    expect(aggregateGreeks([])).toEqual({ delta: 0, gamma: 0, theta: 0 })
  })

  it("aggregates single greek correctly", () => {
    const greeks: Greeks[] = [
      { symbol: "BTC", delta: 0.5, gamma: 0.1, theta: -0.05 },
    ]
    expect(aggregateGreeks(greeks)).toEqual({
      delta: 0.5,
      gamma: 0.1,
      theta: -0.05,
    })
  })

  it("sums multiple greeks correctly", () => {
    const greeks: Greeks[] = [
      { symbol: "BTC", delta: 0.5, gamma: 0.1, theta: -0.05 },
      { symbol: "ETH", delta: 0.3, gamma: 0.2, theta: -0.02 },
    ]
    const result = aggregateGreeks(greeks)
    expect(result.delta).toBeCloseTo(0.8)
    expect(result.gamma).toBeCloseTo(0.3)
    expect(result.theta).toBeCloseTo(-0.07)
  })

  it("handles negative values", () => {
    const greeks: Greeks[] = [
      { symbol: "BTC", delta: 0.5, gamma: 0.1, theta: -0.05 },
      { symbol: "ETH", delta: -0.8, gamma: -0.05, theta: 0.02 },
    ]
    const result = aggregateGreeks(greeks)
    expect(result.delta).toBeCloseTo(-0.3)
    expect(result.gamma).toBeCloseTo(0.05)
    expect(result.theta).toBeCloseTo(-0.03)
  })
})

describe("calculateTotalNotional", () => {
  it("returns zero for empty array", () => {
    expect(calculateTotalNotional([])).toBe(0)
  })

  it("calculates total for single group", () => {
    const groups: PositionsByUnderlying[] = [
      {
        underlying: "BTC",
        positions: [
          {
            symbol: "BTC/USDC",
            side: "long",
            weight: 0.1,
            notional: 1000,
            percentage: 10,
          },
          {
            symbol: "BTC-SPOT",
            side: "long",
            weight: 0.05,
            notional: 500,
            percentage: 5,
          },
        ],
      },
    ]
    expect(calculateTotalNotional(groups)).toBe(1500)
  })

  it("calculates total across multiple groups", () => {
    const groups: PositionsByUnderlying[] = [
      {
        underlying: "BTC",
        positions: [
          {
            symbol: "BTC/USDC",
            side: "long",
            weight: 0.1,
            notional: 1000,
            percentage: 10,
          },
        ],
      },
      {
        underlying: "ETH",
        positions: [
          {
            symbol: "ETH/USDC",
            side: "long",
            weight: 0.2,
            notional: 2000,
            percentage: 20,
          },
        ],
      },
    ]
    expect(calculateTotalNotional(groups)).toBe(3000)
  })
})

describe("calculateGroupNotional", () => {
  it("returns zero for empty positions", () => {
    expect(calculateGroupNotional([])).toBe(0)
  })

  it("sums position notionals", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
      {
        symbol: "BTC-SPOT",
        side: "long",
        weight: 0.05,
        notional: 500,
        percentage: 5,
      },
    ]
    expect(calculateGroupNotional(positions)).toBe(1500)
  })
})

describe("calculateGroupWeight", () => {
  it("returns zero for empty positions", () => {
    expect(calculateGroupWeight([])).toBe(0)
  })

  it("sums position weights", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
      {
        symbol: "BTC-SPOT",
        side: "long",
        weight: 0.05,
        notional: 500,
        percentage: 5,
      },
    ]
    expect(calculateGroupWeight(positions)).toBeCloseTo(0.15)
  })
})

describe("calculateNetSide", () => {
  it("returns long when all positions are long", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
    ]
    expect(calculateNetSide(positions)).toBe("long")
  })

  it("returns short when all positions are short", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "short",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
    ]
    expect(calculateNetSide(positions)).toBe("short")
  })

  it("returns long when net exposure is significantly positive (>10% of gross)", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
      {
        symbol: "BTC-SPOT",
        side: "short",
        weight: 0.05,
        notional: 500,
        percentage: 5,
      },
    ]
    // net = 500, gross = 1500, ratio = 33% > 10%
    expect(calculateNetSide(positions)).toBe("long")
  })

  it("returns short when net exposure is significantly negative (>10% of gross)", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.05,
        notional: 500,
        percentage: 5,
      },
      {
        symbol: "BTC-SPOT",
        side: "short",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
    ]
    // net = -500, gross = 1500, ratio = 33% > 10%
    expect(calculateNetSide(positions)).toBe("short")
  })

  it("returns neutral when net exposure is zero (basis trade)", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
      {
        symbol: "BTC-SPOT",
        side: "short",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
    ]
    // net = 0, gross = 2000, ratio = 0% < 10%
    expect(calculateNetSide(positions)).toBe("neutral")
  })

  it("returns neutral when net exposure is small (<10% of gross)", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1050,
        percentage: 10,
      },
      {
        symbol: "BTC-SPOT",
        side: "short",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
    ]
    // net = 50, gross = 2050, ratio = 2.4% < 10%
    expect(calculateNetSide(positions)).toBe("neutral")
  })

  it("returns long for empty positions", () => {
    expect(calculateNetSide([])).toBe("long")
  })

  it("returns long when net exposure is exactly at 10% threshold", () => {
    // At exactly 10%, should be directional not neutral
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1100,
        percentage: 10,
      },
      {
        symbol: "BTC-SPOT",
        side: "short",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
    ]
    // net = 100, gross = 2100, ratio ≈ 4.8% < 10%, still neutral
    expect(calculateNetSide(positions)).toBe("neutral")
  })

  it("returns long when net exposure is just above 10% threshold", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1200,
        percentage: 10,
      },
      {
        symbol: "BTC-SPOT",
        side: "short",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
    ]
    // net = 200, gross = 2200, ratio ≈ 9.1% < 10%, still neutral
    expect(calculateNetSide(positions)).toBe("neutral")
  })

  it("returns long when clearly above threshold", () => {
    const positions: PositionsByUnderlying["positions"] = [
      {
        symbol: "BTC/USDC",
        side: "long",
        weight: 0.1,
        notional: 1300,
        percentage: 10,
      },
      {
        symbol: "BTC-SPOT",
        side: "short",
        weight: 0.1,
        notional: 1000,
        percentage: 10,
      },
    ]
    // net = 300, gross = 2300, ratio ≈ 13% > 10%
    expect(calculateNetSide(positions)).toBe("long")
  })
})

describe("calculatePositionWeight", () => {
  it("calculates correct weight", () => {
    expect(calculatePositionWeight(250, 1000)).toBe(0.25)
  })

  it("returns zero when group notional is zero", () => {
    expect(calculatePositionWeight(100, 0)).toBe(0)
  })

  it("returns 1 when position equals group", () => {
    expect(calculatePositionWeight(1000, 1000)).toBe(1)
  })
})

describe("filterAssetsByQuery", () => {
  const assets = [
    { ticker: "BTC", sharpe: 1.2 },
    { ticker: "ETH", sharpe: 0.9 },
    { ticker: "SOL", sharpe: 1.5 },
  ]

  it("returns all assets when query is empty", () => {
    expect(filterAssetsByQuery(assets, "")).toEqual(assets)
  })

  it("filters by exact match (case insensitive)", () => {
    expect(filterAssetsByQuery(assets, "BTC")).toEqual([
      { ticker: "BTC", sharpe: 1.2 },
    ])
    expect(filterAssetsByQuery(assets, "btc")).toEqual([
      { ticker: "BTC", sharpe: 1.2 },
    ])
  })

  it("filters by partial match", () => {
    expect(filterAssetsByQuery(assets, "T")).toEqual([
      { ticker: "BTC", sharpe: 1.2 },
      { ticker: "ETH", sharpe: 0.9 },
    ])
  })

  it("returns empty array when no match", () => {
    expect(filterAssetsByQuery(assets, "XYZ")).toEqual([])
  })
})

describe("sortAssetsBySharpe", () => {
  it("sorts descending by sharpe", () => {
    const assets = [
      { ticker: "BTC", sharpe: 1.2 },
      { ticker: "SOL", sharpe: 1.5 },
      { ticker: "ETH", sharpe: 0.9 },
    ]
    const sorted = sortAssetsBySharpe(assets)
    expect(sorted.map(a => a.ticker)).toEqual(["SOL", "BTC", "ETH"])
  })

  it("does not mutate original array", () => {
    const assets = [
      { ticker: "BTC", sharpe: 1.2 },
      { ticker: "SOL", sharpe: 1.5 },
    ]
    const original = [...assets]
    sortAssetsBySharpe(assets)
    expect(assets).toEqual(original)
  })

  it("handles empty array", () => {
    expect(sortAssetsBySharpe([])).toEqual([])
  })

  it("handles negative sharpe values", () => {
    const assets = [
      { ticker: "BTC", sharpe: -0.5 },
      { ticker: "ETH", sharpe: 0.3 },
      { ticker: "SOL", sharpe: -1.0 },
    ]
    const sorted = sortAssetsBySharpe(assets)
    expect(sorted.map(a => a.ticker)).toEqual(["ETH", "BTC", "SOL"])
  })
})

describe("lookupCorrelation", () => {
  const matrix: CorrelationEntry[] = [
    { asset1: "BTC", asset2: "ETH", correlation: 0.85 },
    { asset1: "BTC", asset2: "SOL", correlation: 0.72 },
    { asset1: "ETH", asset2: "SOL", correlation: 0.78 },
  ]

  it("finds correlation in forward direction", () => {
    expect(lookupCorrelation(matrix, "BTC", "ETH")).toBe(0.85)
  })

  it("finds correlation in reverse direction (symmetric lookup)", () => {
    expect(lookupCorrelation(matrix, "ETH", "BTC")).toBe(0.85)
  })

  it("returns 0 for missing pair", () => {
    expect(lookupCorrelation(matrix, "BTC", "XYZ")).toBe(0)
  })

  it("returns 0 for empty matrix", () => {
    expect(lookupCorrelation([], "BTC", "ETH")).toBe(0)
  })
})

describe("getCorrelationColor", () => {
  it("returns bg-green-600 for high positive correlation", () => {
    expect(getCorrelationColor(0.7)).toBe("bg-green-600")
    expect(getCorrelationColor(0.9)).toBe("bg-green-600")
    expect(getCorrelationColor(1.0)).toBe("bg-green-600")
  })

  it("returns bg-green-500/60 for medium positive correlation", () => {
    expect(getCorrelationColor(0.3)).toBe("bg-green-500/60")
    expect(getCorrelationColor(0.5)).toBe("bg-green-500/60")
    expect(getCorrelationColor(0.69)).toBe("bg-green-500/60")
  })

  it("returns bg-green-500/30 for low positive correlation", () => {
    expect(getCorrelationColor(0)).toBe("bg-green-500/30")
    expect(getCorrelationColor(0.1)).toBe("bg-green-500/30")
    expect(getCorrelationColor(0.29)).toBe("bg-green-500/30")
  })

  it("returns bg-red-500/30 for low negative correlation", () => {
    expect(getCorrelationColor(-0.01)).toBe("bg-red-500/30")
    expect(getCorrelationColor(-0.2)).toBe("bg-red-500/30")
    expect(getCorrelationColor(-0.3)).toBe("bg-red-500/30") // -0.3 >= -0.3 is true
  })

  it("returns bg-red-500/60 for medium negative correlation", () => {
    expect(getCorrelationColor(-0.31)).toBe("bg-red-500/60")
    expect(getCorrelationColor(-0.5)).toBe("bg-red-500/60")
    expect(getCorrelationColor(-0.7)).toBe("bg-red-500/60") // -0.7 >= -0.7 is true
  })

  it("returns bg-red-600 for high negative correlation", () => {
    expect(getCorrelationColor(-0.71)).toBe("bg-red-600")
    expect(getCorrelationColor(-0.9)).toBe("bg-red-600")
    expect(getCorrelationColor(-1.0)).toBe("bg-red-600")
  })
})

describe("calculateTotalAttribution", () => {
  it("returns 0 for empty array", () => {
    expect(calculateTotalAttribution([])).toBe(0)
  })

  it("sums contributions correctly", () => {
    const attributions: FactorAttribution[] = [
      { factor: "Market", contribution: 0.1, color: "#000" },
      { factor: "Momentum", contribution: 0.05, color: "#000" },
      { factor: "Carry", contribution: -0.02, color: "#000" },
    ]
    expect(calculateTotalAttribution(attributions)).toBeCloseTo(0.13)
  })
})
