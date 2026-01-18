import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useListSelection } from "./useListSelection"

describe("useListSelection", () => {
  const mockOnAddTrade = vi.fn()

  const defaultConfig = {
    screenerItems: [
      { symbol: "BTC" },
      { symbol: "ETH" },
      { symbol: "SOL" },
      { symbol: "DOGE" },
    ],
    positionItems: [
      { underlying: "BTC" },
      { underlying: "ETH" },
      { underlying: "SOL" },
    ],
    onAddTrade: mockOnAddTrade,
  }

  beforeEach(() => {
    mockOnAddTrade.mockClear()
  })

  describe("panel focus", () => {
    it("starts with no focused panel", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))
      expect(result.current.focusedPanel).toBeNull()
    })

    it("focuses screener panel with 1 key", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      expect(result.current.focusedPanel).toBe("screener")
    })

    it("focuses positions panel with 2 key", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("positions")
      })

      expect(result.current.focusedPanel).toBe("positions")
    })

    it("switches between panels with h/l keys", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.focusedPanel).toBe("screener")

      act(() => {
        result.current.focusPanel("positions")
      })
      expect(result.current.focusedPanel).toBe("positions")

      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.focusedPanel).toBe("screener")
    })
  })

  describe("row selection", () => {
    it("starts with no selected row in either panel", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      expect(result.current.getSelectedIndex("screener")).toBeNull()
      expect(result.current.getSelectedIndex("positions")).toBeNull()
    })

    it("selects first row when focusing panel with no prior selection", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      expect(result.current.getSelectedIndex("screener")).toBe(0)
    })

    it("preserves selection when switching panels", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

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

      act(() => {
        result.current.focusPanel("positions")
      })
      expect(result.current.getSelectedIndex("positions")).toBe(0)

      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(2)
    })
  })

  describe("j/k navigation", () => {
    it("moves selection down with j (moveSelection down)", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(0)

      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(1)

      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(2)
    })

    it("moves selection up with k (moveSelection up)", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

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

      act(() => {
        result.current.moveSelection("up")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(1)

      act(() => {
        result.current.moveSelection("up")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(0)
    })

    it("stops at bottom boundary", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      // Move past the end
      for (let i = 0; i < 10; i++) {
        act(() => {
          result.current.moveSelection("down")
        })
      }

      expect(result.current.getSelectedIndex("screener")).toBe(3) // last index
    })

    it("stops at top boundary", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      // Try to move past the beginning
      act(() => {
        result.current.moveSelection("up")
      })

      expect(result.current.getSelectedIndex("screener")).toBe(0)
    })

    it("does nothing when no panel is focused", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.moveSelection("down")
      })

      expect(result.current.getSelectedIndex("screener")).toBeNull()
      expect(result.current.getSelectedIndex("positions")).toBeNull()
    })
  })

  describe("trading actions (+/-)", () => {
    it("calls onAddTrade with buy when + is pressed on screener", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })
      act(() => {
        result.current.moveSelection("down") // select ETH (index 1)
      })

      act(() => {
        result.current.triggerTrade("buy")
      })

      expect(mockOnAddTrade).toHaveBeenCalledWith("ETH", "buy")
    })

    it("calls onAddTrade with sell when - is pressed on screener", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })
      act(() => {
        result.current.moveSelection("down")
      })
      act(() => {
        result.current.moveSelection("down") // select SOL (index 2)
      })

      act(() => {
        result.current.triggerTrade("sell")
      })

      expect(mockOnAddTrade).toHaveBeenCalledWith("SOL", "sell")
    })

    it("calls onAddTrade with underlying when on positions panel", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("positions")
      })
      act(() => {
        result.current.moveSelection("down") // select ETH (index 1)
      })

      act(() => {
        result.current.triggerTrade("buy")
      })

      expect(mockOnAddTrade).toHaveBeenCalledWith("ETH", "buy")
    })

    it("does nothing when no panel is focused", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.triggerTrade("buy")
      })

      expect(mockOnAddTrade).not.toHaveBeenCalled()
    })

    it("does nothing when no row is selected", () => {
      const { result } = renderHook(() =>
        useListSelection({
          ...defaultConfig,
          screenerItems: [],
        }),
      )

      act(() => {
        result.current.focusPanel("screener")
      })

      act(() => {
        result.current.triggerTrade("buy")
      })

      expect(mockOnAddTrade).not.toHaveBeenCalled()
    })
  })

  describe("escape behavior", () => {
    it("first escape clears selection", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })
      act(() => {
        result.current.moveSelection("down")
      })
      expect(result.current.getSelectedIndex("screener")).toBe(1)

      act(() => {
        result.current.handleEscape()
      })

      expect(result.current.getSelectedIndex("screener")).toBeNull()
      expect(result.current.focusedPanel).toBe("screener")
    })

    it("second escape unfocuses panel", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
        result.current.moveSelection("down")
      })

      // First escape - clears selection
      act(() => {
        result.current.handleEscape()
      })
      expect(result.current.focusedPanel).toBe("screener")

      // Second escape - unfocuses panel
      act(() => {
        result.current.handleEscape()
      })
      expect(result.current.focusedPanel).toBeNull()
    })

    it("escape unfocuses immediately when no selection", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })

      // Clear selection first
      act(() => {
        result.current.handleEscape()
      })
      expect(result.current.getSelectedIndex("screener")).toBeNull()
      expect(result.current.focusedPanel).toBe("screener")

      // Now escape should unfocus
      act(() => {
        result.current.handleEscape()
      })
      expect(result.current.focusedPanel).toBeNull()
    })
  })

  describe("dynamic list updates", () => {
    it("clamps selection when list shrinks", () => {
      const { result, rerender } = renderHook(
        props => useListSelection(props),
        { initialProps: defaultConfig },
      )

      act(() => {
        result.current.focusPanel("screener")
      })
      act(() => {
        result.current.moveSelection("down")
      })
      act(() => {
        result.current.moveSelection("down")
      })
      act(() => {
        result.current.moveSelection("down") // index 3 (last item)
      })
      expect(result.current.getSelectedIndex("screener")).toBe(3)

      // Shrink the list
      rerender({
        ...defaultConfig,
        screenerItems: [{ symbol: "BTC" }, { symbol: "ETH" }],
      })

      expect(result.current.getSelectedIndex("screener")).toBe(1) // clamped to new last index
    })

    it("handles empty list gracefully", () => {
      const { result, rerender } = renderHook(
        props => useListSelection(props),
        { initialProps: defaultConfig },
      )

      act(() => {
        result.current.focusPanel("screener")
      })

      rerender({
        ...defaultConfig,
        screenerItems: [],
      })

      expect(result.current.getSelectedIndex("screener")).toBeNull()
    })
  })

  describe("getSelectedSymbol helper", () => {
    it("returns symbol for screener panel", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("screener")
      })
      act(() => {
        result.current.moveSelection("down") // ETH
      })

      expect(result.current.getSelectedSymbol()).toBe("ETH")
    })

    it("returns underlying for positions panel", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      act(() => {
        result.current.focusPanel("positions")
      })
      act(() => {
        result.current.moveSelection("down")
      })
      act(() => {
        result.current.moveSelection("down") // SOL
      })

      expect(result.current.getSelectedSymbol()).toBe("SOL")
    })

    it("returns null when no panel focused", () => {
      const { result } = renderHook(() => useListSelection(defaultConfig))

      expect(result.current.getSelectedSymbol()).toBeNull()
    })

    it("returns null when no selection", () => {
      const { result } = renderHook(() =>
        useListSelection({
          ...defaultConfig,
          screenerItems: [],
        }),
      )

      act(() => {
        result.current.focusPanel("screener")
      })

      expect(result.current.getSelectedSymbol()).toBeNull()
    })
  })
})
