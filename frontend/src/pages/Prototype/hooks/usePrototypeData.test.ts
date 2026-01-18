import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { usePrototypeData } from "./usePrototypeData"

describe("usePrototypeData", () => {
  describe("positionsByUnderlying", () => {
    it("groups positions correctly by underlying", () => {
      const { result } = renderHook(() => usePrototypeData())

      // BTC should have multiple positions grouped together
      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      expect(btcGroup).toBeDefined()
      if (btcGroup) {
        expect(btcGroup.positions.length).toBeGreaterThan(1)
        expect(btcGroup.positions.every(p => p.symbol.includes("BTC"))).toBe(
          true,
        )
      }
    })

    it("sorts by total notional descending", () => {
      const { result } = renderHook(() => usePrototypeData())

      const groups = result.current.positionsByUnderlying
      for (let i = 0; i < groups.length - 1; i++) {
        const currentTotal = groups[i].positions.reduce(
          (sum, p) => sum + p.notional,
          0,
        )
        const nextTotal = groups[i + 1].positions.reduce(
          (sum, p) => sum + p.notional,
          0,
        )
        expect(currentTotal).toBeGreaterThanOrEqual(nextTotal)
      }
    })

    it("includes weight field in positions", () => {
      const { result } = renderHook(() => usePrototypeData())

      const firstGroup = result.current.positionsByUnderlying[0]
      expect(firstGroup.positions[0]).toHaveProperty("weight")
      expect(typeof firstGroup.positions[0].weight).toBe("number")
    })

    it("derives notional from weight, nav, and leverage", () => {
      const { result } = renderHook(() => usePrototypeData())

      const nav = result.current.nav
      const leverage = result.current.leverage
      const firstGroup = result.current.positionsByUnderlying[0]
      const firstPos = firstGroup.positions[0]

      // notional = nav × weight × leverage
      const expectedNotional = nav * firstPos.weight * leverage
      expect(firstPos.notional).toBeCloseTo(expectedNotional)
    })
  })

  describe("leverage", () => {
    it("starts with leverage of 1.0", () => {
      const { result } = renderHook(() => usePrototypeData())
      expect(result.current.leverage).toBe(1.0)
    })

    it("setLeverage updates leverage value", () => {
      const { result } = renderHook(() => usePrototypeData())

      act(() => {
        result.current.setLeverage(2.0)
      })

      expect(result.current.leverage).toBe(2.0)
    })

    it("changing leverage scales all notionals proportionally", () => {
      const { result } = renderHook(() => usePrototypeData())

      const initialNotional = result.current.totalNotional

      act(() => {
        result.current.setLeverage(2.0)
      })

      expect(result.current.totalNotional).toBeCloseTo(initialNotional * 2)
    })

    it("effectiveLeverage equals totalNotional / nav", () => {
      const { result } = renderHook(() => usePrototypeData())

      const expected = result.current.totalNotional / result.current.nav
      expect(result.current.effectiveLeverage).toBeCloseTo(expected)
    })

    it("effectiveLeverage scales with leverage setting", () => {
      const { result } = renderHook(() => usePrototypeData())

      const initialEffective = result.current.effectiveLeverage

      act(() => {
        result.current.setLeverage(3.0)
      })

      expect(result.current.effectiveLeverage).toBeCloseTo(initialEffective * 3)
    })

    it("weights remain constant when leverage changes", () => {
      const { result } = renderHook(() => usePrototypeData())

      const initialWeights = result.current.positionsByUnderlying.flatMap(g =>
        g.positions.map(p => p.weight),
      )

      act(() => {
        result.current.setLeverage(2.5)
      })

      const newWeights = result.current.positionsByUnderlying.flatMap(g =>
        g.positions.map(p => p.weight),
      )

      expect(newWeights).toEqual(initialWeights)
    })
  })

  describe("stagedTrades", () => {
    it("starts with empty staged trades", () => {
      const { result } = renderHook(() => usePrototypeData())
      expect(result.current.stagedTrades).toEqual([])
    })

    it("addStagedTrade creates unique IDs for different symbols", () => {
      const { result } = renderHook(() => usePrototypeData())

      // Use different symbols/sides to ensure unique IDs even in same ms
      act(() => {
        result.current.addStagedTrade("BTC", "buy")
        result.current.addStagedTrade("ETH", "sell")
        result.current.addStagedTrade("SOL", "buy")
      })

      const ids = result.current.stagedTrades.map(t => t.id)
      expect(new Set(ids).size).toBe(3) // All IDs are unique
    })

    it("addStagedTrade sets correct symbol and side", () => {
      const { result } = renderHook(() => usePrototypeData())

      act(() => {
        result.current.addStagedTrade("ETH", "sell")
      })

      expect(result.current.stagedTrades).toHaveLength(1)
      expect(result.current.stagedTrades[0].symbol).toBe("ETH")
      expect(result.current.stagedTrades[0].side).toBe("sell")
    })

    it("removeStagedTrade removes correct trade", () => {
      const { result } = renderHook(() => usePrototypeData())

      act(() => {
        result.current.addStagedTrade("BTC", "buy")
        result.current.addStagedTrade("ETH", "sell")
      })

      const btcTrade = result.current.stagedTrades.find(t => t.symbol === "BTC")
      const ethTrade = result.current.stagedTrades.find(t => t.symbol === "ETH")
      expect(btcTrade).toBeDefined()
      expect(ethTrade).toBeDefined()

      if (btcTrade && ethTrade) {
        act(() => {
          result.current.removeStagedTrade(btcTrade.id)
        })

        expect(result.current.stagedTrades).toHaveLength(1)
        expect(result.current.stagedTrades[0].id).toBe(ethTrade.id)
      }
    })

    it("clearStagedTrades empties array", () => {
      const { result } = renderHook(() => usePrototypeData())

      act(() => {
        result.current.addStagedTrade("BTC", "buy")
        result.current.addStagedTrade("ETH", "sell")
        result.current.addStagedTrade("SOL", "buy")
      })

      expect(result.current.stagedTrades).toHaveLength(3)

      act(() => {
        result.current.clearStagedTrades()
      })

      expect(result.current.stagedTrades).toEqual([])
    })

    it("executeStagedTrades clears trades", () => {
      const { result } = renderHook(() => usePrototypeData())

      act(() => {
        result.current.addStagedTrade("BTC", "buy")
        result.current.addStagedTrade("ETH", "sell")
      })

      expect(result.current.stagedTrades).toHaveLength(2)

      act(() => {
        result.current.executeStagedTrades()
      })

      expect(result.current.stagedTrades).toEqual([])
    })
  })

  describe("static data", () => {
    it("exposes NAV", () => {
      const { result } = renderHook(() => usePrototypeData())
      expect(result.current.nav).toBe(250000)
    })

    it("exposes greeks data", () => {
      const { result } = renderHook(() => usePrototypeData())
      expect(result.current.greeks).toBeDefined()
      expect(result.current.greeks.length).toBeGreaterThan(0)
      expect(result.current.greeks[0]).toHaveProperty("delta")
      expect(result.current.greeks[0]).toHaveProperty("gamma")
      expect(result.current.greeks[0]).toHaveProperty("theta")
    })

    it("exposes factor exposures", () => {
      const { result } = renderHook(() => usePrototypeData())
      expect(result.current.factorExposures).toBeDefined()
      expect(result.current.factorExposures.length).toBeGreaterThan(0)
    })

    it("exposes correlation matrix", () => {
      const { result } = renderHook(() => usePrototypeData())
      expect(result.current.correlationMatrix).toBeDefined()
      expect(result.current.correlationAssets).toBeDefined()
    })

    it("exposes risk metrics", () => {
      const { result } = renderHook(() => usePrototypeData())
      expect(result.current.riskMetrics).toBeDefined()
      expect(result.current.riskMetrics).toHaveProperty("var95")
      expect(result.current.riskMetrics).toHaveProperty("var99")
    })

    it("exposes performance data", () => {
      const { result } = renderHook(() => usePrototypeData())
      expect(result.current.backtestData).toBeDefined()
      expect(result.current.performanceStats).toBeDefined()
      expect(result.current.monteCarloData).toBeDefined()
    })
  })
})
