import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useListSelection } from "./hooks/useListSelection"
import { computeProjectedExposures } from "./utils/portfolio"
import type { PositionsByUnderlying } from "./hooks/usePrototypeData"

describe("keyboard-only workflows", () => {
  const mockOnAddTrade = vi.fn()
  const mockOnAdjustWeight = vi.fn()

  const defaultConfig = {
    screenerItems: [{ symbol: "BTC" }, { symbol: "ETH" }, { symbol: "SOL" }],
    positionItems: [
      {
        underlying: "BTC",
        instruments: [{ symbol: "BTC/USDC:USDC" }, { symbol: "BTC-SPOT" }],
      },
      {
        underlying: "ETH",
        instruments: [{ symbol: "ETH/USDC:USDC" }],
      },
    ],
    onAddTrade: mockOnAddTrade,
    onAdjustWeight: mockOnAdjustWeight,
  }

  describe("screener navigation workflow", () => {
    it("can navigate to screener with number key 1", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      expect(result.current.focusedPanel).toBe("screener")
      expect(result.current.getSelectedIndex("screener")).toBe(0)
    })

    it("can navigate screener items with j/k", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      // j moves down
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(1)

      // j again
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(2)

      // k moves up
      act(() => {
        result.current.moveSelection("up")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(1)
    })

    it("can get selected symbol for modal", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      // Navigate to SOL (index 2)
      act(() => {
        result.current.moveSelection("down")
        result.current.moveSelection("down")
      })

      expect(result.current.getSelectedIndex("screener")).toBe(2)
      // The caller (index.tsx) uses sortedAssets[selectedIndex] to get the ticker
    })
  })

  describe("positions navigation workflow", () => {
    it("can navigate to positions with number key 2", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("positions")
      })

      expect(result.current.focusedPanel).toBe("positions")
      expect(result.current.getSelectedIndex("positions")).toBe(0)
    })

    it("can navigate position underlyings with j/k", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("positions")
      })

      // BTC starts expanded (multi-instrument), so collapse first to test underlying navigation
      act(() => {
        result.current.toggleExpand() // Collapse BTC
      })

      // j moves to next underlying
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedIndex("positions")).toBe(1)

      // k moves back
      act(() => {
        result.current.moveSelection("up")
      })
      expect(result.current.getSelectedIndex("positions")).toBe(0)
    })

    it("can expand underlying with o and navigate to instruments", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("positions")
      })

      // BTC has 2 instruments and starts expanded
      expect(result.current.getSelectedSymbol()).toBe("BTC")
      expect(result.current.isExpanded("BTC")).toBe(true)

      // First collapse to test expand behavior
      act(() => {
        result.current.toggleExpand()
      })
      expect(result.current.isExpanded("BTC")).toBe(false)

      // o expands
      act(() => {
        result.current.toggleExpand()
      })
      expect(result.current.isExpanded("BTC")).toBe(true)

      // j navigates into instruments
      act(() => {
        result.current.moveSelection("down")
      })

      expect(result.current.getSelectedInstrument()).toBe("BTC/USDC:USDC")

      // j to next instrument
      act(() => {
        result.current.moveSelection("down")
      })

      expect(result.current.getSelectedInstrument()).toBe("BTC-SPOT")
    })

    it("can trigger weight edit on selected instrument", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("positions")
      })

      // BTC starts expanded (multi-instrument), just navigate into instruments
      act(() => {
        result.current.moveSelection("down")
      })

      expect(result.current.getSelectedInstrument()).toBe("BTC/USDC:USDC")

      // Shift+Plus adjusts weight
      act(() => {
        result.current.adjustWeight(0.05)
      })

      expect(mockOnAdjustWeight).toHaveBeenCalledWith("BTC/USDC:USDC", 0.05)
    })
  })

  describe("panel switching workflow", () => {
    it("can switch between panels with h/l", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      // Start in screener
      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.focusedPanel).toBe("screener")

      // l moves to positions
      act(() => {
        result.current.focusPanel("positions")
      })
      expect(result.current.focusedPanel).toBe("positions")

      // h moves back to screener
      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.focusedPanel).toBe("screener")
    })

    it("preserves selection when switching panels", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      // Navigate in screener
      act(() => {
        result.current.focusPanel("screener")
      })

      act(() => {
        result.current.moveSelection("down")
      })

      act(() => {
        result.current.moveSelection("down")
      })

      expect(result.current.getSelectedIndex("screener")).toBe(2)

      // Switch to positions
      act(() => {
        result.current.focusPanel("positions")
      })

      // Switch back to screener - selection should be preserved
      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(2)
    })
  })

  describe("escape key workflow", () => {
    it("clears selection first, then focus on second escape", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.focusedPanel).toBe("screener")
      expect(result.current.getSelectedIndex("screener")).toBe(0)

      // First escape: clears selection
      act(() => {
        result.current.handleEscape()
      })
      expect(result.current.focusedPanel).toBe("screener")
      expect(result.current.getSelectedIndex("screener")).toBeNull()

      // Second escape: unfocuses panel
      act(() => {
        result.current.handleEscape()
      })
      expect(result.current.focusedPanel).toBeNull()
    })

    it("works correctly after navigating to instrument", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("positions")
      })

      // BTC starts expanded, just navigate into instruments
      act(() => {
        result.current.moveSelection("down")
      })

      expect(result.current.getSelectedInstrument()).toBe("BTC/USDC:USDC")

      // First escape: clears selection (goes back to underlying level conceptually)
      act(() => {
        result.current.handleEscape()
      })
      expect(result.current.focusedPanel).toBe("positions")

      // Second escape: unfocuses
      act(() => {
        result.current.handleEscape()
      })
      expect(result.current.focusedPanel).toBeNull()
    })
  })

  describe("trade staging workflow", () => {
    it("can stage buy trade with + key after navigating", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      act(() => {
        result.current.moveSelection("down")
      })

      expect(result.current.getSelectedIndex("screener")).toBe(1)

      act(() => {
        result.current.triggerTrade("buy")
      })

      expect(mockOnAddTrade).toHaveBeenCalledWith("ETH", "buy")
    })

    it("can stage sell trade with - key", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      act(() => {
        result.current.triggerTrade("sell")
      })

      expect(mockOnAddTrade).toHaveBeenCalledWith("BTC", "sell")
    })
  })

  describe("complete keyboard workflows", () => {
    it("full flow: focus screener → navigate → stage trade → switch panel → navigate → adjust weight", () => {
      const onAdjustWeight = vi.fn()
      const onAddTrade = vi.fn()
      const { result } = renderHook(() =>
        useListSelection({
          ...defaultConfig,
          onAddTrade,
          onAdjustWeight,
        }),
      )

      // Step 1: Focus screener (pressing 1)
      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.focusedPanel).toBe("screener")
      expect(result.current.getSelectedIndex("screener")).toBe(0)

      // Step 2: Navigate to ETH (pressing j)
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedSymbol()).toBe("ETH")

      // Step 3: Stage buy trade (pressing +)
      act(() => {
        result.current.triggerTrade("buy")
      })
      expect(onAddTrade).toHaveBeenCalledWith("ETH", "buy")

      // Step 4: Switch to positions (pressing 2)
      act(() => {
        result.current.focusPanel("positions")
      })
      expect(result.current.focusedPanel).toBe("positions")
      expect(result.current.getSelectedSymbol()).toBe("BTC")

      // Step 5: BTC is already expanded (multi-instrument), navigate to first instrument
      expect(result.current.isExpanded("BTC")).toBe(true)
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedInstrument()).toBe("BTC/USDC:USDC")

      // Step 6: Adjust weight (pressing Shift++)
      act(() => {
        result.current.adjustWeight(0.05)
      })
      expect(onAdjustWeight).toHaveBeenCalledWith("BTC/USDC:USDC", 0.05)
    })

    it("navigates through all instruments then to next underlying", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      // Focus positions
      act(() => {
        result.current.focusPanel("positions")
      })

      // BTC starts expanded (multi-instrument, has 2 instruments)
      expect(result.current.isExpanded("BTC")).toBe(true)

      // Navigate to first instrument
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedInstrument()).toBe("BTC/USDC:USDC")

      // Navigate to second instrument
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedInstrument()).toBe("BTC-SPOT")

      // Navigate past instruments → should go to ETH underlying
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedSymbol()).toBe("ETH")
      expect(result.current.getSelectedInstrument()).toBeNull()
    })

    it("preserves expansion state when navigating between underlyings", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      // Focus positions
      act(() => {
        result.current.focusPanel("positions")
      })

      // BTC starts expanded (multi-instrument)
      expect(result.current.isExpanded("BTC")).toBe(true)

      // Navigate through BTC instruments to reach ETH
      // BTC (expanded) -> BTC inst 0 -> BTC inst 1 -> ETH
      act(() => {
        result.current.moveSelection("down") // BTC inst 0
      })
      act(() => {
        result.current.moveSelection("down") // BTC inst 1
      })
      act(() => {
        result.current.moveSelection("down") // ETH underlying
      })
      expect(result.current.getSelectedSymbol()).toBe("ETH")

      // ETH starts collapsed (single instrument), expand it
      expect(result.current.isExpanded("ETH")).toBe(false)
      act(() => {
        result.current.toggleExpand()
      })
      expect(result.current.isExpanded("ETH")).toBe(true)

      // BTC should still be expanded
      expect(result.current.isExpanded("BTC")).toBe(true)
    })

    it("collapses expanded underlying with o key", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      // Focus positions
      act(() => {
        result.current.focusPanel("positions")
      })

      // BTC starts expanded (multi-instrument)
      expect(result.current.isExpanded("BTC")).toBe(true)

      // Navigate to instrument
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedInstrument()).toBe("BTC/USDC:USDC")

      // Go back to underlying level
      act(() => {
        result.current.moveSelection("up")
      })
      expect(result.current.getSelectedInstrument()).toBeNull()
      expect(result.current.getSelectedSymbol()).toBe("BTC")

      // Collapse with o
      act(() => {
        result.current.toggleExpand()
      })
      expect(result.current.isExpanded("BTC")).toBe(false)
    })
  })
})

describe("factor exposure projections", () => {
  const basePositions: PositionsByUnderlying[] = [
    {
      underlying: "BTC",
      positions: [
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          weight: 0.3,
          notional: 30000,
          percentage: 30,
        },
      ],
    },
    {
      underlying: "ETH",
      positions: [
        {
          symbol: "ETH/USDC:USDC",
          side: "long",
          weight: 0.2,
          notional: 20000,
          percentage: 20,
        },
      ],
    },
  ]

  const assetFactors = [
    {
      ticker: "BTC",
      beta: 1.0,
      momentum: 0.12,
      volatility: 0.65,
      spyBeta: 0.45,
    },
    {
      ticker: "ETH",
      beta: 1.25,
      momentum: 0.08,
      volatility: 0.78,
      spyBeta: 0.42,
    },
    {
      ticker: "SOL",
      beta: 1.8,
      momentum: 0.15,
      volatility: 0.92,
      spyBeta: 0.38,
    },
  ]

  it("shows all factor changes in staged trades impact", () => {
    const result = computeProjectedExposures({
      positions: basePositions,
      stagedTrades: [
        { id: "1", symbol: "SOL", side: "buy", notional: 10000, leverage: 1 },
      ],
      nav: 100000,
      leverage: 1.0,
      assetFactors,
    })

    // Should have factor changes for all factors
    expect(result.factorChanges.btcBeta).toBeDefined()
    expect(result.factorChanges.spyBeta).toBeDefined()
    expect(result.factorChanges.momentum).toBeDefined()
    expect(result.factorChanges.volatility).toBeDefined()
    expect(result.factorChanges.carry).toBeDefined()

    // BTC beta should increase (adding high-beta SOL)
    expect(result.factorChanges.btcBeta.delta).toBeGreaterThan(0)

    // Momentum should increase (SOL has higher momentum)
    expect(result.factorChanges.momentum.delta).toBeGreaterThan(0)

    // Volatility should increase (SOL is more volatile)
    expect(result.factorChanges.volatility.delta).toBeGreaterThan(0)
  })

  it("computes correct weighted average for projected factors", () => {
    const result = computeProjectedExposures({
      positions: basePositions,
      stagedTrades: [],
      nav: 100000,
      leverage: 1.0,
      assetFactors,
    })

    // Current BTC beta should be weighted average
    // BTC weight = 30k/50k = 0.6, ETH weight = 20k/50k = 0.4
    // Expected beta = 0.6 * 1.0 + 0.4 * 1.25 = 1.1
    expect(result.factorChanges.btcBeta.current).toBeCloseTo(1.1)

    // No change since no staged trades
    expect(result.factorChanges.btcBeta.delta).toBe(0)
  })

  it("shows factor decrease when selling high-factor asset", () => {
    const result = computeProjectedExposures({
      positions: basePositions,
      stagedTrades: [
        { id: "1", symbol: "ETH", side: "sell", notional: 10000, leverage: 1 },
      ],
      nav: 100000,
      leverage: 1.0,
      assetFactors,
    })

    // Selling high-beta ETH should decrease portfolio beta
    expect(result.factorChanges.btcBeta.delta).toBeLessThan(0)
  })
})

describe("leverage keyboard controls", () => {
  it("leverage state is passed through hooks correctly", () => {
    // This test verifies that the leverage control can be adjusted
    // The actual keyboard handler is in the parent component
    // Here we test that the state management works correctly
    const leverage = 1.5
    const nav = 100000
    const positions: PositionsByUnderlying[] = [
      {
        underlying: "BTC",
        positions: [
          {
            symbol: "BTC/USDC:USDC",
            side: "long",
            weight: 0.5,
            notional: 50000,
            percentage: 50,
          },
        ],
      },
    ]

    const result = computeProjectedExposures({
      positions,
      stagedTrades: [],
      nav,
      leverage,
      assetFactors: [{ ticker: "BTC", beta: 1.0 }],
    })

    // Effective leverage should be notional * leverage / nav
    // = 50000 * 1.5 / 100000 = 0.75
    expect(result.currentEffectiveLeverage).toBeCloseTo(0.75)
  })

  it("leverage changes scale effective exposure proportionally", () => {
    const nav = 100000
    const positions: PositionsByUnderlying[] = [
      {
        underlying: "BTC",
        positions: [
          {
            symbol: "BTC/USDC:USDC",
            side: "long",
            weight: 0.5,
            notional: 50000,
            percentage: 50,
          },
        ],
      },
    ]

    const at1x = computeProjectedExposures({
      positions,
      stagedTrades: [],
      nav,
      leverage: 1.0,
      assetFactors: [{ ticker: "BTC", beta: 1.0 }],
    })

    const at2x = computeProjectedExposures({
      positions,
      stagedTrades: [],
      nav,
      leverage: 2.0,
      assetFactors: [{ ticker: "BTC", beta: 1.0 }],
    })

    // At 2x leverage, effective leverage should be 2x the 1x value
    expect(at2x.currentEffectiveLeverage).toBeCloseTo(
      at1x.currentEffectiveLeverage * 2,
    )
  })
})
