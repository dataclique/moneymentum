import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useScreenerConfig } from "./useScreenerConfig"

interface TestAsset {
  ticker: string
  sharpe: number
  sortino: number
  beta: number
  volatility: number
  momentum: number
}

const mockAssets: TestAsset[] = [
  {
    ticker: "BTC",
    sharpe: 1.5,
    sortino: 2.0,
    beta: 1.2,
    volatility: 0.5,
    momentum: 0.1,
  },
  {
    ticker: "ETH",
    sharpe: 1.2,
    sortino: 1.8,
    beta: 1.4,
    volatility: 0.6,
    momentum: 0.15,
  },
  {
    ticker: "SOL",
    sharpe: 0.8,
    sortino: 1.0,
    beta: 1.8,
    volatility: 0.8,
    momentum: 0.2,
  },
]

describe("useScreenerConfig", () => {
  describe("sorting", () => {
    it("sorts by sharpe descending by default", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      const sorted = result.current.sortedAssets
      expect(sorted[0].ticker).toBe("BTC")
      expect(sorted[1].ticker).toBe("ETH")
      expect(sorted[2].ticker).toBe("SOL")
    })

    it("sorts by column ascending when clicked", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      act(() => {
        result.current.setSortColumn("beta")
      })

      const sorted = result.current.sortedAssets
      expect(sorted[0].ticker).toBe("BTC") // beta 1.2
      expect(sorted[1].ticker).toBe("ETH") // beta 1.4
      expect(sorted[2].ticker).toBe("SOL") // beta 1.8
    })

    it("toggles sort direction when same column clicked again", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      // First click - ascending for beta
      act(() => {
        result.current.setSortColumn("beta")
      })
      expect(result.current.sortDirection).toBe("asc")

      // Second click - descending
      act(() => {
        result.current.setSortColumn("beta")
      })
      expect(result.current.sortDirection).toBe("desc")

      const sorted = result.current.sortedAssets
      expect(sorted[0].ticker).toBe("SOL") // beta 1.8
      expect(sorted[1].ticker).toBe("ETH") // beta 1.4
      expect(sorted[2].ticker).toBe("BTC") // beta 1.2
    })

    it("resets to ascending when different column selected", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      act(() => {
        result.current.setSortColumn("sharpe")
        result.current.setSortColumn("sharpe") // toggle to desc
      })
      expect(result.current.sortDirection).toBe("desc")

      act(() => {
        result.current.setSortColumn("volatility")
      })
      expect(result.current.sortDirection).toBe("asc")
      expect(result.current.sortColumn).toBe("volatility")
    })
  })

  describe("filtering", () => {
    it("filters assets by search query (case insensitive)", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      act(() => {
        result.current.setSearchQuery("btc")
      })

      expect(result.current.sortedAssets).toHaveLength(1)
      expect(result.current.sortedAssets[0].ticker).toBe("BTC")
    })

    it("returns all assets when search query is empty", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      act(() => {
        result.current.setSearchQuery("")
      })

      expect(result.current.sortedAssets).toHaveLength(3)
    })

    it("applies both filter and sort", () => {
      const assets = [
        ...mockAssets,
        {
          ticker: "ETHFI",
          sharpe: 0.5,
          sortino: 0.8,
          beta: 1.6,
          volatility: 0.7,
          momentum: 0.12,
        },
      ]

      const { result } = renderHook(() => useScreenerConfig({ assets }))

      act(() => {
        result.current.setSearchQuery("eth")
        result.current.setSortColumn("sharpe")
      })

      expect(result.current.sortedAssets).toHaveLength(2)
      expect(result.current.sortedAssets[0].ticker).toBe("ETHFI") // sharpe 0.5
      expect(result.current.sortedAssets[1].ticker).toBe("ETH") // sharpe 1.2
    })
  })

  describe("expansion", () => {
    it("starts with no expanded underlyings", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      expect(result.current.isExpanded("BTC")).toBe(false)
      expect(result.current.isExpanded("ETH")).toBe(false)
    })

    it("expands underlying when toggled", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      act(() => {
        result.current.toggleExpanded("BTC")
      })

      expect(result.current.isExpanded("BTC")).toBe(true)
      expect(result.current.isExpanded("ETH")).toBe(false)
    })

    it("collapses expanded underlying when toggled again", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      act(() => {
        result.current.toggleExpanded("BTC")
        result.current.toggleExpanded("BTC")
      })

      expect(result.current.isExpanded("BTC")).toBe(false)
    })

    it("allows multiple underlyings to be expanded", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      act(() => {
        result.current.toggleExpanded("BTC")
        result.current.toggleExpanded("ETH")
      })

      expect(result.current.isExpanded("BTC")).toBe(true)
      expect(result.current.isExpanded("ETH")).toBe(true)
    })

    it("collapses all when collapseAll is called", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      act(() => {
        result.current.toggleExpanded("BTC")
        result.current.toggleExpanded("ETH")
        result.current.collapseAll()
      })

      expect(result.current.isExpanded("BTC")).toBe(false)
      expect(result.current.isExpanded("ETH")).toBe(false)
    })
  })

  describe("visible columns", () => {
    it("has default visible columns", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      expect(result.current.visibleColumns).toContain("sharpe")
    })

    it("toggles column visibility", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      const initialHasSortino =
        result.current.visibleColumns.includes("sortino")

      act(() => {
        result.current.toggleColumn("sortino")
      })

      expect(result.current.visibleColumns.includes("sortino")).toBe(
        !initialHasSortino,
      )
    })

    it("always keeps at least one column visible", () => {
      const { result } = renderHook(() =>
        useScreenerConfig({ assets: mockAssets }),
      )

      // Try to hide all columns
      act(() => {
        for (const col of result.current.visibleColumns) {
          result.current.toggleColumn(col)
        }
      })

      expect(result.current.visibleColumns.length).toBeGreaterThanOrEqual(1)
    })
  })
})
