import { useState, useCallback, useMemo } from "react"

type SortDirection = "asc" | "desc"

export type ScreenerColumn =
  | "sharpe"
  | "sortino"
  | "beta"
  | "volatility"
  | "momentum"

interface Asset {
  ticker: string
  sharpe: number
  sortino: number
  beta: number
  volatility: number
  momentum: number
}

interface UseScreenerConfigOptions<T extends Asset> {
  assets: T[]
}

const DEFAULT_VISIBLE_COLUMNS: ScreenerColumn[] = ["sharpe"]

export const SCREENER_COLUMN_LABELS: Record<ScreenerColumn, string> = {
  sharpe: "Sharpe",
  sortino: "Sortino",
  beta: "Beta",
  volatility: "Vol",
  momentum: "Mom",
}

export const ALL_SCREENER_COLUMNS: ScreenerColumn[] = [
  "sharpe",
  "sortino",
  "beta",
  "volatility",
  "momentum",
]

export const useScreenerConfig = <T extends Asset>({
  assets,
}: UseScreenerConfigOptions<T>) => {
  const [sortColumn, setSortColumnState] = useState<ScreenerColumn>("sharpe")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")
  const [searchQuery, setSearchQuery] = useState("")
  const [expandedUnderlyings, setExpandedUnderlyings] = useState<Set<string>>(
    new Set(),
  )
  const [visibleColumns, setVisibleColumns] = useState<ScreenerColumn[]>(
    DEFAULT_VISIBLE_COLUMNS,
  )

  const setSortColumn = useCallback(
    (column: ScreenerColumn) => {
      if (column === sortColumn) {
        setSortDirection(prev => (prev === "asc" ? "desc" : "asc"))
      } else {
        setSortColumnState(column)
        setSortDirection("asc")
      }
    },
    [sortColumn],
  )

  const sortedAssets = useMemo(() => {
    const filtered =
      searchQuery.trim() === ""
        ? assets
        : assets.filter(a =>
            a.ticker.toLowerCase().includes(searchQuery.toLowerCase()),
          )

    return [...filtered].sort((a, b) => {
      const aValue = a[sortColumn]
      const bValue = b[sortColumn]
      const multiplier = sortDirection === "asc" ? 1 : -1
      return (aValue - bValue) * multiplier
    })
  }, [assets, searchQuery, sortColumn, sortDirection])

  const isExpanded = useCallback(
    (underlying: string): boolean => expandedUnderlyings.has(underlying),
    [expandedUnderlyings],
  )

  const toggleExpanded = useCallback((underlying: string) => {
    setExpandedUnderlyings(prev => {
      const hasUnderlying = prev.has(underlying)
      return hasUnderlying
        ? new Set([...prev].filter(u => u !== underlying))
        : new Set([...prev, underlying])
    })
  }, [])

  const collapseAll = useCallback(() => {
    setExpandedUnderlyings(new Set())
  }, [])

  const toggleColumn = useCallback((column: ScreenerColumn) => {
    setVisibleColumns(prev => {
      const hasColumn = prev.includes(column)
      if (hasColumn && prev.length === 1) {
        return prev
      }
      return hasColumn ? prev.filter(c => c !== column) : [...prev, column]
    })
  }, [])

  return useMemo(
    () => ({
      sortColumn,
      sortDirection,
      setSortColumn,
      searchQuery,
      setSearchQuery,
      sortedAssets,
      isExpanded,
      toggleExpanded,
      collapseAll,
      visibleColumns,
      toggleColumn,
    }),
    [
      sortColumn,
      sortDirection,
      setSortColumn,
      searchQuery,
      sortedAssets,
      isExpanded,
      toggleExpanded,
      collapseAll,
      visibleColumns,
      toggleColumn,
    ],
  )
}
