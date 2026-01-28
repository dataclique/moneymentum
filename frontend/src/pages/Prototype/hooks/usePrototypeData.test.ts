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

    it("generates staged trades when weight changes", () => {
      const { result } = renderHook(() => usePrototypeData())

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcPerp = btcGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(btcPerp).toBeDefined()

      act(() => {
        result.current.updateInstrumentWeight(btcPerp!.symbol, 0.3)
      })

      // Should have staged trades generated from the weight change
      expect(result.current.stagedTrades.length).toBeGreaterThan(0)
      expect(
        result.current.stagedTrades.some(t => t.source === "weight_edit"),
      ).toBe(true)
    })

    it("generates staged trades when leverage changes", () => {
      const { result } = renderHook(() => usePrototypeData())

      act(() => {
        result.current.setLeverage(1.5)
      })

      // All positions should have leverage_change trades
      expect(result.current.stagedTrades.length).toBeGreaterThan(0)
      expect(
        result.current.stagedTrades.every(t => t.source === "leverage_change"),
      ).toBe(true)
    })

    it("clearStagedTrades reverts to committed state", () => {
      const { result } = renderHook(() => usePrototypeData())

      // Make changes
      act(() => {
        result.current.setLeverage(2.0)
      })

      expect(result.current.stagedTrades.length).toBeGreaterThan(0)

      // Clear
      act(() => {
        result.current.clearStagedTrades()
      })

      expect(result.current.stagedTrades).toEqual([])
      expect(result.current.leverage).toBe(1.0) // Reverted to committed
    })

    it("executeStagedTrades commits changes", () => {
      const { result } = renderHook(() => usePrototypeData())

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcPerp = btcGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(btcPerp).toBeDefined()

      const newWeight = 0.3
      act(() => {
        result.current.updateInstrumentWeight(btcPerp!.symbol, newWeight)
      })

      expect(result.current.stagedTrades.length).toBeGreaterThan(0)

      act(() => {
        result.current.executeStagedTrades()
      })

      // Staged trades should be cleared
      expect(result.current.stagedTrades).toEqual([])

      // Weight should remain at the new value (now committed)
      const updatedGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const updatedPerp = updatedGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(updatedPerp!.weight).toBeCloseTo(newWeight)
    })
  })

  describe("adjustPositionWeight", () => {
    it("increases weight by positive delta", () => {
      const { result } = renderHook(() => usePrototypeData())

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcPerp = btcGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(btcPerp).toBeDefined()

      const initialWeight = btcPerp!.weight

      act(() => {
        result.current.adjustPositionWeight(btcPerp!.symbol, 0.01)
      })

      const updatedGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const updatedPerp = updatedGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(updatedPerp!.weight).toBeCloseTo(initialWeight + 0.01)
    })

    it("decreases weight by negative delta", () => {
      const { result } = renderHook(() => usePrototypeData())

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcPerp = btcGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(btcPerp).toBeDefined()

      const initialWeight = btcPerp!.weight

      act(() => {
        result.current.adjustPositionWeight(btcPerp!.symbol, -0.01)
      })

      const updatedGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const updatedPerp = updatedGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(updatedPerp!.weight).toBeCloseTo(initialWeight - 0.01)
    })

    it("clamps weight to minimum of 0", () => {
      const { result } = renderHook(() => usePrototypeData())

      // Find a position with small weight
      const apeGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "APE",
      )
      const apePerp = apeGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(apePerp).toBeDefined()

      act(() => {
        result.current.adjustPositionWeight(apePerp!.symbol, -1.0) // Try to go negative
      })

      const updatedGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "APE",
      )
      const updatedPerp = updatedGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(updatedPerp!.weight).toBe(0)
    })

    it("clamps weight to maximum of 1", () => {
      const { result } = renderHook(() => usePrototypeData())

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcPerp = btcGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(btcPerp).toBeDefined()

      act(() => {
        result.current.adjustPositionWeight(btcPerp!.symbol, 10.0) // Try to exceed 1
      })

      const updatedGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const updatedPerp = updatedGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(updatedPerp!.weight).toBe(1)
    })

    it("rebalances other weights proportionally when one weight increases", () => {
      const { result } = renderHook(() => usePrototypeData())

      // Get total weight before change
      const totalWeightBefore = result.current.positionsByUnderlying
        .flatMap(g => g.positions)
        .reduce((sum, p) => sum + p.weight, 0)

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcPerp = btcGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(btcPerp).toBeDefined()

      act(() => {
        result.current.updateInstrumentWeight(btcPerp!.symbol, 0.5)
      })

      // Total weight should remain approximately the same (rebalanced)
      const totalWeightAfter = result.current.positionsByUnderlying
        .flatMap(g => g.positions)
        .reduce((sum, p) => sum + p.weight, 0)

      expect(totalWeightAfter).toBeCloseTo(totalWeightBefore)
    })

    it("updates notional after weight change", () => {
      const { result } = renderHook(() => usePrototypeData())

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcPerp = btcGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )
      expect(btcPerp).toBeDefined()

      act(() => {
        result.current.adjustPositionWeight(btcPerp!.symbol, 0.05)
      })

      const updatedGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const updatedPerp = updatedGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )

      // notional = nav × weight × leverage
      const expectedNotional =
        result.current.nav * updatedPerp!.weight * result.current.leverage
      expect(updatedPerp!.notional).toBeCloseTo(expectedNotional)
    })
  })

  describe("instrument costs", () => {
    it("includes funding rate for perp positions", () => {
      const { result } = renderHook(() => usePrototypeData())

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcPerp = btcGroup?.positions.find(p =>
        p.symbol.includes("/USDC:USDC"),
      )

      expect(btcPerp).toBeDefined()
      expect(btcPerp!.fundingRate).toBeDefined()
      expect(typeof btcPerp!.fundingRate).toBe("number")
    })

    it("includes carry rate for spot positions", () => {
      const { result } = renderHook(() => usePrototypeData())

      const btcGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "BTC",
      )
      const btcSpot = btcGroup?.positions.find(p => p.symbol.includes("-SPOT"))

      expect(btcSpot).toBeDefined()
      expect(btcSpot!.carryRate).toBeDefined()
      expect(typeof btcSpot!.carryRate).toBe("number")
    })

    it("includes theta for option positions", () => {
      const { result } = renderHook(() => usePrototypeData())

      const ethGroup = result.current.positionsByUnderlying.find(
        g => g.underlying === "ETH",
      )
      const ethPut = ethGroup?.positions.find(p => p.symbol.includes("-PUT"))

      expect(ethPut).toBeDefined()
      expect(ethPut!.theta).toBeDefined()
      expect(typeof ethPut!.theta).toBe("number")
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

  describe("committed vs target state", () => {
    it("exposes hasUnsavedChanges flag", () => {
      const { result } = renderHook(() => usePrototypeData())

      expect(result.current.hasUnsavedChanges).toBe(false)

      act(() => {
        result.current.setLeverage(2.0)
      })

      expect(result.current.hasUnsavedChanges).toBe(true)

      act(() => {
        result.current.clearStagedTrades()
      })

      expect(result.current.hasUnsavedChanges).toBe(false)
    })

    it("exposes committedLeverage and targetLeverage", () => {
      const { result } = renderHook(() => usePrototypeData())

      expect(result.current.committedLeverage).toBe(1.0)
      expect(result.current.targetLeverage).toBe(1.0)

      act(() => {
        result.current.setLeverage(2.0)
      })

      expect(result.current.committedLeverage).toBe(1.0) // Unchanged
      expect(result.current.targetLeverage).toBe(2.0) // Changed

      act(() => {
        result.current.executeStagedTrades()
      })

      expect(result.current.committedLeverage).toBe(2.0) // Now committed
      expect(result.current.targetLeverage).toBe(2.0)
    })
  })
})
