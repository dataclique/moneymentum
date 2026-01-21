import * as React from "react"
import { useEffect, useRef, useMemo, useState, useCallback } from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import {
  Search,
  ChevronDown,
  ChevronRight,
  Settings,
  Columns,
} from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { HelpOverlay } from "./components/HelpOverlay"
import { StagedTradesPanel } from "./components/StagedTradesPanel"
import { FactorConfigPanel } from "./components/FactorConfigPanel"
import { EditableCell } from "./components/EditableCell"
import { AddPositionModal } from "./components/AddPositionModal"
import type { FactorExposure } from "./mockData"
import { MOCK_INSTRUMENT_COSTS, getInstrumentsForAsset } from "./mockData"
import { usePrototypeData } from "./hooks/usePrototypeData"
import { useListSelection } from "./hooks/useListSelection"
import { getDirection } from "./utils/keys"
import {
  useScreenerConfig,
  SCREENER_COLUMN_LABELS,
  ALL_SCREENER_COLUMNS,
} from "./hooks/useScreenerConfig"
import { MetricSelector } from "./components/MetricSelector"
import { getMetricById, WINDOW_OPTIONS } from "./metrics/registry"
import { formatNum, formatPct, formatUsd } from "./utils/formatters"
import {
  aggregateGreeks,
  calculateTotalNotional,
  calculateGroupNotional,
  calculateNetSide,
  calculatePositionWeight,
  lookupCorrelation,
  getCorrelationColor,
  calculateTotalAttribution,
  FACTOR_COLORS,
} from "./utils/portfolio"
import {
  createChart,
  AreaSeries,
  HistogramSeries,
  LineSeries,
  type Time,
} from "lightweight-charts"

type SecondaryFocus = "performance" | "staged" | "none"

const PrototypePage = () => {
  const data = usePrototypeData()
  const [showHelp, setShowHelp] = useState(false)
  // Single-instrument underlyings start collapsed, multi-instrument start expanded
  const [collapsedUnderlyings, setCollapsedUnderlyings] = useState<Set<string>>(
    () =>
      new Set(
        data.positionsByUnderlying
          .filter(group => group.positions.length === 1)
          .map(group => group.underlying),
      ),
  )
  const [selectedMetricIds, setSelectedMetricIds] = useState<string[]>([
    "equity",
  ])
  const [selectedWindowId, setSelectedWindowId] = useState("30d")
  const [isMetricSelectorOpen, setIsMetricSelectorOpen] = useState(false)
  const [showFactorConfig, setShowFactorConfig] = useState(false)
  const [customFactors, setCustomFactors] = useState<FactorExposure[] | null>(
    null,
  )
  const [addPositionModal, setAddPositionModal] = useState<{
    isOpen: boolean
    underlying: string | null
  }>({ isOpen: false, underlying: null })
  const [columnConfigVisible, setColumnConfigVisible] = useState(false)
  const closeColumnConfig = useCallback(() => {
    setColumnConfigVisible(false)
  }, [])
  const toggleColumnConfig = useCallback(() => {
    setColumnConfigVisible(prev => !prev)
  }, [])
  const [secondaryFocus, setSecondaryFocus] = useState<SecondaryFocus>("none")
  const performanceChartRef = useRef<HTMLDivElement>(null)

  const {
    positionsByUnderlying,
    greeks,
    factorExposures: defaultFactorExposures,
    assetAnalysis,
    isLoading,
    leverage,
    setLeverage,
    effectiveLeverage,
    stagedTrades,
    addStagedTrade,
    removeStagedTrade,
    clearStagedTrades,
    executeStagedTrades,
    updateInstrumentWeight,
    updateInstrumentNotional,
    riskMetrics,
    stressTests,
    monteCarloData,
    backtestData,
    performanceStats,
    factorAttribution,
    concentrationMetrics,
    correlationMatrix,
    correlationAssets,
  } = data

  const factorExposures = customFactors ?? defaultFactorExposures

  const screenerConfig = useScreenerConfig({ assets: assetAnalysis })
  const {
    sortColumn,
    sortDirection,
    setSortColumn,
    searchQuery,
    setSearchQuery,
    sortedAssets,
    visibleColumns,
    toggleColumn,
    isExpanded: isScreenerExpanded,
    toggleExpanded: toggleScreenerExpanded,
  } = screenerConfig

  // Prepare items for keyboard selection
  const screenerItems = useMemo(
    () => assetAnalysis.map(a => ({ symbol: a.ticker })),
    [assetAnalysis],
  )

  // Extract asset factors for staged trades impact preview
  const assetFactors = useMemo(
    () =>
      assetAnalysis.map(a => ({
        ticker: a.ticker,
        beta: a.beta,
        momentum: a.momentum,
        volatility: a.volatility,
        spyBeta: a.beta * 0.4, // Approximate SPY beta from BTC beta
        carry: 0, // Would come from funding rates, approximated here
      })),
    [assetAnalysis],
  )
  const positionItems = useMemo(
    () =>
      positionsByUnderlying.map(p => ({
        underlying: p.underlying,
        instruments: p.positions.map(pos => ({ symbol: pos.symbol })),
      })),
    [positionsByUnderlying],
  )

  const listSelection = useListSelection({
    screenerItems,
    positionItems,
    onAddTrade: addStagedTrade,
    onAdjustWeight: data.adjustPositionWeight,
  })

  const {
    focusedPanel,
    focusPanel,
    getSelectedIndex,
    moveSelection,
    triggerTrade,
    handleEscape,
    toggleExpand,
    getSelectedInstrument,
    getSelectedSymbol,
    adjustWeight,
  } = listSelection

  // Compute chart data using metric registry
  const selectedMetrics = selectedMetricIds
    .map(id => getMetricById(id))
    .filter(Boolean)
  const selectedWindow = WINDOW_OPTIONS.find(w => w.id === selectedWindowId)

  type ChartPoint = { time: number; value: number }
  const chartDataByMetric = useMemo((): Map<string, ChartPoint[]> => {
    if (!backtestData.length) return new Map<string, ChartPoint[]>()

    const inputData = backtestData.map(d => ({ time: d.time, value: d.value }))
    const windowDays = selectedWindow?.days ?? 30
    const result = new Map<string, ChartPoint[]>()

    for (const metric of selectedMetrics) {
      if (metric) {
        result.set(metric.id, metric.compute(inputData, windowDays))
      }
    }
    return result
  }, [selectedMetrics, backtestData, selectedWindow])

  // useEffect justified: LightweightCharts requires imperative DOM manipulation
  // and cleanup. No React wrapper exists that provides equivalent functionality.
  useEffect(() => {
    const container = performanceChartRef.current
    if (!container || !selectedMetrics.length) return

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { color: "transparent" }, textColor: "#888" },
      grid: { vertLines: { color: "#222" }, horzLines: { color: "#222" } },
      timeScale: { borderColor: "#333", timeVisible: false },
      rightPriceScale: { borderColor: "#333" },
      crosshair: { mode: 0 },
    })

    const hexToRgba = (hex: string, alpha: number) => {
      const r = parseInt(hex.slice(1, 3), 16)
      const g = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }

    for (const metric of selectedMetrics) {
      if (!metric) continue
      const data = chartDataByMetric.get(metric.id)
      if (!data?.length) continue

      if (metric.chartType === "area") {
        const isNegativeMetric = metric.id === "drawdown"
        const series = chart.addSeries(AreaSeries, {
          lineColor: metric.color,
          topColor: isNegativeMetric
            ? hexToRgba(metric.color, 0)
            : hexToRgba(metric.color, 0.3),
          bottomColor: isNegativeMetric
            ? hexToRgba(metric.color, 0.3)
            : hexToRgba(metric.color, 0),
          lineWidth: 2,
        })
        series.setData(
          data.map(d => ({ time: d.time as Time, value: d.value })),
        )
      } else if (metric.chartType === "histogram") {
        const series = chart.addSeries(HistogramSeries, {
          color: metric.color,
        })
        series.setData(
          data.map(d => ({
            time: d.time as Time,
            value: d.value,
            color:
              d.value >= 0 ? metric.color : (metric.negativeColor ?? "#ef4444"),
          })),
        )
      } else {
        const series = chart.addSeries(LineSeries, {
          color: metric.color,
          lineWidth: 2,
        })
        series.setData(
          data.map(d => ({ time: d.time as Time, value: d.value })),
        )
      }
    }

    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [chartDataByMetric, selectedMetrics])

  const greeksMap = useMemo(() => {
    const map = new Map<string, (typeof greeks)[0]>()
    for (const g of greeks) map.set(g.symbol, g)
    return map
  }, [greeks])

  const portfolioGreeks = useMemo(() => aggregateGreeks(greeks), [greeks])

  const totalNotional = useMemo(
    () => calculateTotalNotional(positionsByUnderlying),
    [positionsByUnderlying],
  )

  const toggleUnderlying = useCallback((underlying: string) => {
    setCollapsedUnderlyings(prev => {
      const next = new Set(prev)
      if (next.has(underlying)) next.delete(underlying)
      else next.add(underlying)
      return next
    })
  }, [])

  const toggleHelp = useCallback(() => {
    setShowHelp(prev => !prev)
  }, [])

  const openAddPositionModal = useCallback((underlying: string) => {
    setAddPositionModal({ isOpen: true, underlying })
  }, [])

  const closeAddPositionModal = useCallback(() => {
    setAddPositionModal({ isOpen: false, underlying: null })
  }, [])

  // Get instruments for the selected underlying in the modal
  const getInstrumentsForUnderlying = useCallback((underlying: string) => {
    const perpSymbol = `${underlying}/USDC:USDC`
    const spotSymbol = `${underlying}-SPOT`

    const instruments: Array<{
      symbol: string
      type: "perp" | "spot" | "call" | "put"
      rate: number
      rateLabel: string
    }> = []

    // Add perp if it has cost data
    const perpCost = MOCK_INSTRUMENT_COSTS.find(c => c.symbol === perpSymbol)
    if (perpCost) {
      instruments.push({
        symbol: perpSymbol,
        type: "perp",
        rate: perpCost.fundingRate ?? 0,
        rateLabel: "funding",
      })
    }

    // Add spot
    const spotCost = MOCK_INSTRUMENT_COSTS.find(c => c.symbol === spotSymbol)
    instruments.push({
      symbol: spotSymbol,
      type: "spot",
      rate: spotCost?.carryRate ?? 0,
      rateLabel: "carry",
    })

    return instruments
  }, [])

  const handleAddPosition = useCallback(
    (params: {
      symbol: string
      direction: "long" | "short"
      weight: number
    }) => {
      // For now, just add as a staged trade
      addStagedTrade(
        params.symbol,
        params.direction === "long" ? "buy" : "sell",
      )
    },
    [addStagedTrade],
  )

  // useEffect justified: Global keyboard shortcuts must listen on window/document
  // since they work regardless of which element has focus. Cannot use component-level onKeyDown.
  useEffect(() => {
    const blurLeverageControl = () => {
      document
        .querySelector<HTMLElement>('[data-testid="leverage-control"]')
        ?.blur()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const key = event.key.toLowerCase()

      if (key === "?" || (event.key === "F1" && !event.ctrlKey)) {
        event.preventDefault()
        toggleHelp()
        return
      }

      if (key === "escape") {
        event.preventDefault()
        if (showHelp) {
          setShowHelp(false)
        } else if (columnConfigVisible) {
          closeColumnConfig()
        } else if (secondaryFocus !== "none") {
          setSecondaryFocus("none")
        } else {
          handleEscape()
        }
        return
      }

      // Number keys for direct panel access
      // Use stopImmediatePropagation to prevent EditableCell's directEdit from capturing these
      if (event.key === "1") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (secondaryFocus === "staged") blurLeverageControl()
        setSecondaryFocus("none")
        focusPanel("screener")
        return
      }
      if (event.key === "2") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (secondaryFocus === "staged") blurLeverageControl()
        setSecondaryFocus("none")
        focusPanel("positions")
        return
      }
      if (event.key === "3") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (secondaryFocus === "staged") blurLeverageControl()
        focusPanel(null) // unfocus screener/positions
        setSecondaryFocus("performance")
        return
      }
      if (event.key === "4") {
        event.preventDefault()
        event.stopImmediatePropagation()
        focusPanel(null) // unfocus screener/positions
        setSecondaryFocus("staged")
        // Focus the leverage control so keyboard events work in real browsers
        const leverageControl = document.querySelector<HTMLElement>(
          '[data-testid="leverage-control"]',
        )
        leverageControl?.focus()
        return
      }

      // Navigation using vim keys (h/j/k/l) or arrow keys
      const direction = getDirection(event.key)

      // Horizontal: switch between panels (h/l or left/right arrows)
      if (focusedPanel && direction === "left") {
        event.preventDefault()
        focusPanel("screener")
        return
      }
      if (focusedPanel && direction === "right") {
        event.preventDefault()
        focusPanel("positions")
        return
      }

      // Vertical: navigate within lists (j/k or up/down arrows)
      // When hitting boundary, navigate to adjacent panel
      if (focusedPanel && direction === "down") {
        event.preventDefault()
        const result = moveSelection("down")
        if (result === "boundary" && focusedPanel === "positions") {
          // At bottom of positions list, move to staged changes
          focusPanel(null)
          setSecondaryFocus("staged")
          const leverageControl = document.querySelector<HTMLElement>(
            '[data-testid="leverage-control"]',
          )
          leverageControl?.focus()
        }
        return
      }
      if (focusedPanel && direction === "up") {
        event.preventDefault()
        moveSelection("up")
        return
      }

      // Navigate from staged changes back to positions with up
      if (secondaryFocus === "staged" && direction === "up") {
        event.preventDefault()
        blurLeverageControl()
        setSecondaryFocus("none")
        focusPanel("positions")
        return
      }

      // o, Space, or Enter to toggle expand/collapse in positions panel
      if (
        focusedPanel === "positions" &&
        (key === "o" || key === " " || key === "enter")
      ) {
        event.preventDefault()
        const selectedUnderlying = getSelectedSymbol()
        if (selectedUnderlying) {
          toggleUnderlying(selectedUnderlying)
        }
        toggleExpand()
        return
      }
      if (focusedPanel === "screener" && key === "o") {
        event.preventDefault()
        const selectedIdx = getSelectedIndex("screener")
        const asset = sortedAssets[selectedIdx] as
          | { ticker: string }
          | undefined
        if (asset) {
          toggleScreenerExpanded(asset.ticker)
        }
        return
      }

      // Enter to open add position modal from screener
      if (focusedPanel === "screener" && event.key === "Enter") {
        event.preventDefault()
        const selectedIdx = getSelectedIndex("screener")
        const asset = sortedAssets[selectedIdx] as
          | { ticker: string }
          | undefined
        if (asset) {
          openAddPositionModal(asset.ticker)
        }
        return
      }

      // +/- to stage trades (without shift) or adjust weight (with shift)
      if (focusedPanel && (key === "+" || key === "=")) {
        event.preventDefault()
        if (event.shiftKey) {
          adjustWeight(0.05) // +5%
        } else {
          triggerTrade("buy")
        }
        return
      }
      if (focusedPanel && key === "-") {
        event.preventDefault()
        if (event.shiftKey) {
          adjustWeight(-0.05) // -5%
        } else {
          triggerTrade("sell")
        }
        return
      }

      // m to open metric selector
      if (key === "m") {
        event.preventDefault()
        setIsMetricSelectorOpen(prev => !prev)
        return
      }

      // f to toggle factor config panel
      if (key === "f") {
        event.preventDefault()
        setShowFactorConfig(prev => !prev)
        return
      }

      // c to toggle screener column config
      if (key === "c") {
        event.preventDefault()
        toggleColumnConfig()
        return
      }

      // [ and ] for global leverage adjustment (works from any panel)
      if (event.key === "[") {
        event.preventDefault()
        setLeverage(prev => Math.max(0.1, Math.round((prev - 0.1) * 10) / 10))
        return
      }
      if (event.key === "]") {
        event.preventDefault()
        setLeverage(prev => Math.min(5, Math.round((prev + 0.1) * 10) / 10))
        return
      }

      // x to execute staged trades
      if (key === "x") {
        event.preventDefault()
        executeStagedTrades()
        return
      }

      // Start navigation from screener if nothing focused
      if (!focusedPanel && ["h", "j", "k", "l"].includes(key)) {
        event.preventDefault()
        focusPanel("screener")
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [
    focusedPanel,
    secondaryFocus,
    showHelp,
    columnConfigVisible,
    closeColumnConfig,
    toggleColumnConfig,
    focusPanel,
    toggleHelp,
    handleEscape,
    moveSelection,
    triggerTrade,
    toggleExpand,
    adjustWeight,
    getSelectedSymbol,
    getSelectedIndex,
    toggleUnderlying,
    toggleScreenerExpanded,
    sortedAssets,
    openAddPositionModal,
    setLeverage,
    executeStagedTrades,
  ])

  const maxFreq = Math.max(...monteCarloData.map(d => d.frequency))
  const totalAttribution = calculateTotalAttribution(factorAttribution)
  const selectedInstrumentSymbol = getSelectedInstrument()

  const getCorrelation = (a1: string, a2: string): number =>
    lookupCorrelation(correlationMatrix, a1, a2)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="h-screen flex flex-col bg-background overflow-hidden text-[11px]">
        {showHelp && <HelpOverlay onClose={toggleHelp} />}

        {addPositionModal.underlying && (
          <AddPositionModal
            isOpen={addPositionModal.isOpen}
            underlying={addPositionModal.underlying}
            instruments={getInstrumentsForUnderlying(
              addPositionModal.underlying,
            )}
            nav={data.nav}
            currentLeverage={leverage}
            onClose={closeAddPositionModal}
            onAddPosition={handleAddPosition}
          />
        )}

        {/* Header */}
        <header className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0 bg-muted/30">
          <div className="flex items-center gap-4">
            <span className="font-semibold">Moneymentum</span>
            <div className="h-4 border-l border-border" />
            <span className="text-muted-foreground">NAV</span>
            <span className="font-mono">${data.nav.toLocaleString()}</span>
            <span className="text-muted-foreground">Notional</span>
            <span className="font-mono">{formatUsd(totalNotional)}</span>
            <span className="text-muted-foreground">
              ({effectiveLeverage.toFixed(2)}x)
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-muted-foreground">Δ</span>
            <span className="font-mono">
              {portfolioGreeks.delta.toFixed(2)}
            </span>
            <span className="text-muted-foreground">Γ</span>
            <span className="font-mono">
              {portfolioGreeks.gamma.toFixed(3)}
            </span>
            <span className="text-muted-foreground">Θ</span>
            <span className="font-mono">
              {portfolioGreeks.theta.toFixed(3)}
            </span>
            <div className="h-4 border-l border-border" />
            <span className="text-muted-foreground">VaR 95%</span>
            <span className="font-mono text-red-400">
              {formatPct(riskMetrics.var95)}
            </span>
            <kbd
              className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded cursor-pointer hover:bg-muted/80"
              onClick={toggleHelp}
            >
              ?
            </kbd>
          </div>
        </header>

        {/* Main: 3 columns - Screener | Positions+Staged | Analysis */}
        <main className="flex-1 flex gap-1 p-1 min-h-0 overflow-hidden">
          {/* Left: Screener (narrow, for discovery - adjacent to positions for workflow) */}
          <div
            className={twMerge(
              clsx(
                "w-[180px] shrink-0 border rounded flex flex-col",
                focusedPanel === "screener"
                  ? "border-primary ring-1 ring-primary/50"
                  : "border-border",
              ),
            )}
            onClick={() => {
              setSecondaryFocus("none")
              focusPanel("screener")
            }}
          >
            <div className="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between relative">
              <div className="flex items-center gap-2">
                <span className="font-medium">SCREENER</span>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    toggleColumnConfig()
                  }}
                  className="text-muted-foreground hover:text-foreground"
                  title="Configure columns (c)"
                >
                  <Columns className="h-3 w-3" />
                </button>
              </div>
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
                1
              </kbd>
              {columnConfigVisible && (
                <div className="absolute top-full left-0 mt-1 z-20 bg-background border border-border rounded shadow-lg p-2 min-w-[120px]">
                  <div className="text-[10px] text-muted-foreground font-medium mb-1">
                    Columns
                  </div>
                  {ALL_SCREENER_COLUMNS.map(col => (
                    <label
                      key={col}
                      className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-muted/30 px-1 rounded"
                    >
                      <input
                        type="checkbox"
                        checked={visibleColumns.includes(col)}
                        onChange={() => {
                          toggleColumn(col)
                        }}
                        className="h-3 w-3"
                      />
                      <span className="text-[11px]">
                        {SCREENER_COLUMN_LABELS[col]}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="p-1.5 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={e => {
                    setSearchQuery(e.target.value)
                  }}
                  className="w-full pl-7 pr-2 py-1 bg-muted/50 border border-border rounded focus:outline-none focus:border-primary"
                />
              </div>
            </div>
            <div className="flex-1 overflow-auto scrollbar-hide">
              <table className="w-full">
                <thead className="sticky top-0 bg-muted/90 z-10">
                  <tr className="text-muted-foreground text-[10px]">
                    <th className="px-1 py-1 w-4"></th>
                    <th className="px-2 py-1 text-left font-medium">Symbol</th>
                    {visibleColumns.map(col => (
                      <th
                        key={col}
                        className="px-2 py-1 text-right font-medium cursor-pointer hover:text-foreground"
                        onClick={() => {
                          setSortColumn(col)
                        }}
                      >
                        {SCREENER_COLUMN_LABELS[col]}
                        {sortColumn === col && (
                          <span className="ml-0.5">
                            {sortDirection === "asc" ? "↑" : "↓"}
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedAssets.map((asset, index) => {
                    const isSelected =
                      focusedPanel === "screener" &&
                      getSelectedIndex("screener") === index
                    const isExpanded = isScreenerExpanded(asset.ticker)
                    const instruments = getInstrumentsForAsset(asset.ticker)
                    return (
                      <React.Fragment key={asset.ticker}>
                        <tr
                          className={twMerge(
                            clsx(
                              "border-b border-border/20 hover:bg-muted/30 cursor-pointer",
                              isSelected &&
                                "ring-1 ring-primary/50 bg-muted/40",
                            ),
                          )}
                        >
                          <td
                            className="px-1 py-1 text-muted-foreground"
                            onClick={e => {
                              e.stopPropagation()
                              toggleScreenerExpanded(asset.ticker)
                            }}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                          </td>
                          <td
                            className="px-2 py-1 font-medium"
                            onClick={() => {
                              openAddPositionModal(asset.ticker)
                            }}
                          >
                            {asset.ticker}
                          </td>
                          {visibleColumns.map(col => {
                            const value = asset[col]
                            const isRate = col === "fundingRate"
                            const formatted = isRate
                              ? `${(value * 100).toFixed(0)}%`
                              : value.toFixed(2)
                            return (
                              <td
                                key={col}
                                className={twMerge(
                                  clsx(
                                    "px-2 py-1 text-right font-mono",
                                    value > 0
                                      ? "text-green-500"
                                      : value < 0
                                        ? "text-red-500"
                                        : "text-muted-foreground",
                                  ),
                                )}
                                onClick={() => {
                                  openAddPositionModal(asset.ticker)
                                }}
                              >
                                {formatted}
                              </td>
                            )
                          })}
                        </tr>
                        {isExpanded &&
                          instruments.map(inst => (
                            <tr
                              key={inst.symbol}
                              className="border-b border-border/10 text-muted-foreground bg-muted/10 hover:bg-muted/20 cursor-pointer"
                              onClick={() => {
                                openAddPositionModal(asset.ticker)
                              }}
                            >
                              <td></td>
                              <td className="px-2 py-0.5 pl-5">
                                <span className="text-muted-foreground/60 mr-1">
                                  └
                                </span>
                                {inst.type.toUpperCase()}
                              </td>
                              {visibleColumns.map(col => {
                                if (col === "fundingRate") {
                                  return (
                                    <td
                                      key={col}
                                      className={twMerge(
                                        clsx(
                                          "px-2 py-0.5 text-right font-mono",
                                          inst.rate > 0
                                            ? "text-green-500"
                                            : inst.rate < 0
                                              ? "text-red-500"
                                              : "text-muted-foreground",
                                        ),
                                      )}
                                    >
                                      {`${(inst.rate * 100).toFixed(0)}%`}
                                    </td>
                                  )
                                }
                                return (
                                  <td
                                    key={col}
                                    className="px-2 py-0.5 text-right font-mono text-muted-foreground/50"
                                  >
                                    —
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Middle-left: Positions + Staged (full height) */}
          <div
            className={twMerge(
              clsx(
                "w-[540px] shrink-0 border rounded flex flex-col",
                focusedPanel === "positions"
                  ? "border-primary ring-1 ring-primary/50"
                  : "border-border",
              ),
            )}
            onClick={() => {
              setSecondaryFocus("none")
              focusPanel("positions")
            }}
          >
            <div className="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium">POSITIONS</span>
                <span className="text-muted-foreground">
                  {positionsByUnderlying.length} underlying assets
                </span>
              </div>
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
                2
              </kbd>
            </div>

            {/* Positions table */}
            <div className="flex-1 overflow-auto scrollbar-hide min-h-0">
              {isLoading ? (
                <div className="p-2 space-y-1">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <Skeleton key={i} className="h-5 w-full" />
                  ))}
                </div>
              ) : (
                <table className="w-full">
                  <thead className="sticky top-0 bg-muted/90 z-10">
                    <tr className="text-muted-foreground text-[10px]">
                      <th className="px-1 py-1 w-5"></th>
                      <th className="px-2 py-1 text-left font-medium">Asset</th>
                      <th className="px-2 py-1 text-left font-medium">Side</th>
                      <th className="px-2 py-1 text-right font-medium">
                        <span className="inline-flex items-center gap-1">
                          Weight
                          <kbd className="px-1 py-0.5 text-[8px] bg-muted/60 rounded font-mono opacity-60">
                            w
                          </kbd>
                        </span>
                      </th>
                      <th className="px-2 py-1 text-right font-medium">
                        <span className="inline-flex items-center gap-1">
                          Notional
                          <kbd className="px-1 py-0.5 text-[8px] bg-muted/60 rounded font-mono opacity-60">
                            n
                          </kbd>
                        </span>
                      </th>
                      <th className="px-2 py-1 text-right font-medium">Rate</th>
                      <th className="px-2 py-1 text-right font-medium">Δ</th>
                      <th className="px-2 py-1 text-right font-medium">Γ</th>
                      <th className="px-2 py-1 text-right font-medium">Θ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positionsByUnderlying.map((group, index) => {
                      const isExpanded = !collapsedUnderlyings.has(
                        group.underlying,
                      )
                      const greekData = greeksMap.get(group.underlying)
                      const groupNotional = calculateGroupNotional(
                        group.positions,
                      )
                      const groupPct = group.positions.reduce(
                        (s, p) => s + p.percentage,
                        0,
                      )
                      const netSide = calculateNetSide(group.positions)

                      // Calculate weighted average rate for the underlying
                      const groupWeightedRate =
                        groupNotional > 0
                          ? group.positions.reduce((sum, pos) => {
                              let posRate = 0
                              if (pos.fundingRate !== undefined) {
                                posRate =
                                  pos.side === "short"
                                    ? -pos.fundingRate
                                    : pos.fundingRate
                              } else if (pos.theta !== undefined) {
                                posRate = pos.theta * 365
                              } else {
                                posRate = pos.carryRate ?? 0
                              }
                              return (
                                sum + posRate * (pos.notional / groupNotional)
                              )
                            }, 0)
                          : 0

                      const isSelected =
                        focusedPanel === "positions" &&
                        getSelectedIndex("positions") === index

                      return (
                        <React.Fragment key={group.underlying}>
                          <tr
                            className={twMerge(
                              clsx(
                                "border-b border-border/30 hover:bg-muted/20 cursor-pointer",
                                isSelected &&
                                  "ring-1 ring-primary/50 bg-muted/40",
                              ),
                            )}
                            onClick={() => {
                              toggleUnderlying(group.underlying)
                            }}
                          >
                            <td className="px-1 py-1 text-muted-foreground">
                              {isExpanded ? (
                                <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ChevronRight className="h-3 w-3" />
                              )}
                            </td>
                            <td className="px-2 py-1 font-medium">
                              {group.underlying}
                            </td>
                            <td className="px-2 py-1">
                              <span
                                className={twMerge(
                                  clsx(
                                    "text-[10px] font-medium px-1.5 py-0.5 rounded",
                                    netSide === "long"
                                      ? "bg-green-500/20 text-green-500"
                                      : netSide === "short"
                                        ? "bg-red-500/20 text-red-500"
                                        : "bg-yellow-500/20 text-yellow-500",
                                  ),
                                )}
                              >
                                {netSide === "long"
                                  ? "LONG"
                                  : netSide === "short"
                                    ? "SHORT"
                                    : "NEUTRAL"}
                              </span>
                            </td>
                            <td className="px-2 py-1 text-right font-mono font-medium">
                              {groupPct.toFixed(1)}%
                            </td>
                            <td className="px-2 py-1 text-right font-mono">
                              {formatUsd(groupNotional)}
                            </td>
                            <td
                              className={twMerge(
                                clsx(
                                  "px-2 py-1 text-right font-mono",
                                  groupWeightedRate > 0
                                    ? "text-green-500"
                                    : groupWeightedRate < 0
                                      ? "text-red-500"
                                      : "text-muted-foreground",
                                ),
                              )}
                            >
                              {`${groupWeightedRate > 0 ? "+" : ""}${(groupWeightedRate * 100).toFixed(1)}%`}
                            </td>
                            <td className="px-2 py-1 text-right font-mono">
                              {formatNum(greekData?.delta, 2)}
                            </td>
                            <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                              {formatNum(greekData?.gamma, 3)}
                            </td>
                            <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                              {formatNum(greekData?.theta, 3)}
                            </td>
                          </tr>
                          {isExpanded &&
                            group.positions.map(pos => {
                              const underlyingGreeks = greeksMap.get(
                                group.underlying,
                              )
                              const posWeight = calculatePositionWeight(
                                pos.notional,
                                groupNotional,
                              )
                              const instrumentType = pos.symbol.includes("/")
                                ? "PERP"
                                : pos.symbol.includes("-PUT")
                                  ? "PUT"
                                  : pos.symbol.includes("-CALL")
                                    ? "CALL"
                                    : "SPOT"

                              const isOption =
                                instrumentType === "PUT" ||
                                instrumentType === "CALL"
                              const isLong = pos.side === "long"

                              const getOptionHint = () => {
                                if (!isOption) return null
                                if (instrumentType === "CALL") {
                                  return isLong
                                    ? "Long call: Unlimited upside potential. Maximum loss is the premium paid. Profits when underlying rises above strike + premium."
                                    : "Short call: Collects premium upfront. Unlimited loss potential if underlying rises. Profits when underlying stays below strike."
                                }
                                return isLong
                                  ? "Long put: Profits when underlying falls below strike minus premium paid. Maximum loss is limited to the premium. Common uses: (1) Portfolio hedge against downside moves, (2) Bearish directional bet with limited risk, (3) Pairs with long stock for protective put strategy."
                                  : "Short put: Collects premium upfront in exchange for obligation to buy at strike. Maximum loss occurs if underlying goes to zero (strike × contracts). Profits when underlying stays above strike. Common uses: (1) Generate income on assets you're willing to own, (2) Bullish bet that underlying won't fall, (3) Cash-secured put strategy for potential entry."
                              }
                              const optionHint = getOptionHint()

                              // Get rate: funding for perps, 0 for spots, theta (annualized) for options
                              const getRate = (): {
                                value: number
                                label: string
                              } => {
                                if (pos.fundingRate !== undefined) {
                                  // For shorts, you receive funding when rate is positive
                                  const effectiveRate =
                                    pos.side === "short"
                                      ? -pos.fundingRate
                                      : pos.fundingRate
                                  return {
                                    value: effectiveRate,
                                    label: "funding",
                                  }
                                }
                                if (pos.theta !== undefined) {
                                  return {
                                    value: pos.theta * 365,
                                    label: "theta",
                                  }
                                }
                                // Spots and any other instruments default to 0% rate
                                return {
                                  value: pos.carryRate ?? 0,
                                  label: "carry",
                                }
                              }
                              const rate = getRate()

                              const isInstrumentSelected =
                                focusedPanel === "positions" &&
                                selectedInstrumentSymbol === pos.symbol

                              return (
                                <tr
                                  key={pos.symbol}
                                  className={twMerge(
                                    clsx(
                                      "border-b border-border/10 text-muted-foreground",
                                      isInstrumentSelected
                                        ? "bg-primary/20 ring-1 ring-primary/50"
                                        : "bg-muted/10",
                                    ),
                                  )}
                                >
                                  <td></td>
                                  <td className="px-2 py-0.5 pl-6 whitespace-nowrap">
                                    <span className="text-muted-foreground mr-1">
                                      └
                                    </span>
                                    {instrumentType}
                                  </td>
                                  <td className="px-2 py-0.5">
                                    <span className="relative inline-flex items-center">
                                      <span
                                        className={twMerge(
                                          clsx(
                                            "text-[10px] font-medium px-1.5 py-0.5 rounded",
                                            isLong
                                              ? "bg-green-500/20 text-green-500"
                                              : "bg-red-500/20 text-red-500",
                                          ),
                                        )}
                                      >
                                        {isLong ? "LONG" : "SHORT"}
                                      </span>
                                      {optionHint && (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span className="absolute -top-1 -right-2 text-[8px] text-muted-foreground/60 hover:text-muted-foreground cursor-help">
                                              ?
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent
                                            side="top"
                                            className="max-w-[280px]"
                                          >
                                            {optionHint}
                                          </TooltipContent>
                                        </Tooltip>
                                      )}
                                    </span>
                                  </td>
                                  <td className="px-2 py-0.5 text-right font-mono">
                                    <EditableCell
                                      value={pos.weight}
                                      format="percent"
                                      onCommit={newWeight => {
                                        updateInstrumentWeight(
                                          pos.symbol,
                                          newWeight,
                                        )
                                      }}
                                      isSelected={isInstrumentSelected}
                                      editKey="w"
                                      directEdit
                                    />
                                  </td>
                                  <td className="px-2 py-0.5 text-right font-mono">
                                    <EditableCell
                                      value={pos.notional}
                                      format="currency"
                                      onCommit={newNotional => {
                                        updateInstrumentNotional(
                                          pos.symbol,
                                          newNotional,
                                        )
                                      }}
                                      isSelected={isInstrumentSelected}
                                      editKey="n"
                                    />
                                  </td>
                                  <td
                                    className={twMerge(
                                      clsx(
                                        "px-2 py-0.5 text-right font-mono",
                                        rate.value > 0
                                          ? "text-green-500"
                                          : rate.value < 0
                                            ? "text-red-500"
                                            : "",
                                      ),
                                    )}
                                  >
                                    {`${rate.value > 0 ? "+" : ""}${(rate.value * 100).toFixed(1)}%`}
                                  </td>
                                  <td className="px-2 py-0.5 text-right font-mono">
                                    {underlyingGreeks
                                      ? formatNum(
                                          underlyingGreeks.delta * posWeight,
                                          2,
                                        )
                                      : "—"}
                                  </td>
                                  <td className="px-2 py-0.5 text-right font-mono">
                                    {underlyingGreeks
                                      ? formatNum(
                                          underlyingGreeks.gamma * posWeight,
                                          3,
                                        )
                                      : "—"}
                                  </td>
                                  <td className="px-2 py-0.5 text-right font-mono">
                                    {underlyingGreeks
                                      ? formatNum(
                                          underlyingGreeks.theta * posWeight,
                                          3,
                                        )
                                      : "—"}
                                  </td>
                                </tr>
                              )
                            })}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <StagedTradesPanel
              stagedTrades={stagedTrades}
              leverage={leverage}
              effectiveLeverage={effectiveLeverage}
              nav={data.nav}
              positions={positionsByUnderlying}
              assetFactors={assetFactors}
              isFocused={secondaryFocus === "staged"}
              onLeverageChange={setLeverage}
              onRemoveTrade={removeStagedTrade}
              onClearAll={clearStagedTrades}
              onExecute={executeStagedTrades}
            />
          </div>

          {/* Center: Analysis panels */}
          <div className="flex-1 flex flex-col gap-1 min-w-0">
            {/* Top row: Performance */}
            <div
              className={twMerge(
                clsx(
                  "border border-border rounded flex flex-col",
                  secondaryFocus === "performance" && "ring-1 ring-primary/50",
                ),
              )}
              style={{ height: "45%" }}
            >
              <div className="px-2 py-1 border-b border-border bg-muted/30 font-medium flex justify-between items-center">
                <span>PERFORMANCE</span>
                <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
                  3
                </kbd>
              </div>
              <div className="flex-1 flex min-h-0">
                {/* Metrics on the left - single column with breathing room */}
                <div className="w-[180px] shrink-0 border-r border-border/30 p-3 overflow-auto scrollbar-hide flex flex-col gap-2">
                  <MetricSelector
                    selectedMetricIds={selectedMetricIds}
                    selectedWindowId={selectedWindowId}
                    onMetricToggle={id => {
                      setSelectedMetricIds(prev =>
                        prev.includes(id)
                          ? prev.filter(x => x !== id)
                          : [...prev, id],
                      )
                    }}
                    onWindowChange={setSelectedWindowId}
                    isOpen={isMetricSelectorOpen}
                    onOpenChange={setIsMetricSelectorOpen}
                    isFocused={secondaryFocus === "performance"}
                  />
                  <div className="flex justify-between pb-2 border-b border-border/30">
                    <span className="text-muted-foreground">Total Return</span>
                    <span
                      className={
                        performanceStats.totalReturn >= 0
                          ? "text-green-500 font-mono"
                          : "text-red-500 font-mono"
                      }
                    >
                      {formatPct(performanceStats.totalReturn)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sharpe</span>
                    <span className="font-mono">
                      {performanceStats.sharpeRatio.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sortino</span>
                    <span className="font-mono">
                      {performanceStats.sortinoRatio.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Calmar</span>
                    <span className="font-mono">
                      {Math.abs(
                        performanceStats.totalReturn /
                          performanceStats.maxDrawdown,
                      ).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Max Drawdown</span>
                    <span className="text-red-400 font-mono">
                      {formatPct(performanceStats.maxDrawdown)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Win Rate</span>
                    <span className="font-mono">
                      {(performanceStats.winRate * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Profit Factor</span>
                    <span className="font-mono">
                      {performanceStats.profitFactor.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Volatility</span>
                    <span className="font-mono">
                      {formatPct(riskMetrics.var95 * 1.645)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Beta</span>
                    <span className="font-mono">1.05</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">VaR 95%</span>
                    <span className="text-red-400 font-mono">
                      {formatPct(riskMetrics.var95)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">VaR 99%</span>
                    <span className="text-red-400 font-mono">
                      {formatPct(riskMetrics.var99)}
                    </span>
                  </div>
                </div>
                {/* Chart on the right */}
                <div className="flex-1 min-w-0 p-2">
                  <div ref={performanceChartRef} className="w-full h-full" />
                </div>
              </div>
            </div>

            {/* Bottom row: Factors and Risk side by side */}
            <div className="flex-1 flex gap-1 min-h-0">
              {/* Factors */}
              <div className="flex-1 border border-border rounded flex flex-col min-w-0 relative">
                <div className="px-2 py-1 border-b border-border bg-muted/30 font-medium flex items-center justify-between">
                  <span>FACTORS</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setShowFactorConfig(true)
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      title="Configure factors (f)"
                    >
                      <Settings className="h-3 w-3" />
                    </button>
                    <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
                      f
                    </kbd>
                  </div>
                </div>
                {showFactorConfig && (
                  <FactorConfigPanel
                    factors={factorExposures}
                    onClose={() => {
                      setShowFactorConfig(false)
                    }}
                    onSave={setCustomFactors}
                  />
                )}
                <div className="flex-1 flex flex-col p-2 gap-3 overflow-auto scrollbar-hide">
                  <div className="space-y-1.5">
                    <div className="text-[10px] text-muted-foreground font-medium">
                      Exposures
                    </div>
                    {factorExposures.map(f => (
                      <div key={f.name} className="flex items-center gap-2">
                        <span className="w-20 text-muted-foreground truncate">
                          {f.name}
                        </span>
                        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden relative">
                          <div className="absolute left-1/2 w-px h-full bg-border" />
                          <div
                            className={twMerge(
                              clsx(
                                "absolute h-full rounded-full",
                                f.value >= 0
                                  ? "left-1/2 bg-green-500"
                                  : "right-1/2 bg-red-500",
                              ),
                            )}
                            style={{
                              width: `${Math.min(Math.abs(f.value) * 50, 50)}%`,
                            }}
                          />
                        </div>
                        <span className="w-12 text-right font-mono">
                          {f.value >= 0 ? "+" : ""}
                          {f.value.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border/50 pt-2">
                    <div className="text-[10px] text-muted-foreground font-medium mb-1.5">
                      Attribution
                    </div>
                    {factorAttribution.map(f => (
                      <div
                        key={f.factor}
                        className="flex items-center gap-2 mb-1"
                      >
                        <span className="w-20 text-muted-foreground truncate">
                          {f.factor}
                        </span>
                        <div className="flex-1 h-2 bg-muted rounded overflow-hidden">
                          <div
                            className="h-full rounded"
                            style={{
                              width: `${Math.abs(f.contribution / totalAttribution) * 100}%`,
                              backgroundColor:
                                FACTOR_COLORS[f.factor] ?? "#888888",
                            }}
                          />
                        </div>
                        <span
                          className={twMerge(
                            clsx(
                              "w-14 text-right font-mono",
                              f.contribution >= 0
                                ? "text-green-500"
                                : "text-red-500",
                            ),
                          )}
                        >
                          {f.contribution >= 0 ? "+" : ""}
                          {(f.contribution * 100).toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border/50 pt-2">
                    <div className="text-[10px] text-muted-foreground font-medium mb-1.5">
                      Concentration
                    </div>
                    <div className="space-y-1">
                      {concentrationMetrics.map(m => (
                        <div
                          key={m.metric}
                          className="flex items-center justify-between"
                        >
                          <span className="text-muted-foreground">
                            {m.metric}
                          </span>
                          <span className="font-mono">
                            {m.value <= 1
                              ? `${(m.value * 100).toFixed(0)}%`
                              : m.value.toFixed(1)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Risk */}
              <div className="flex-1 border border-border rounded flex flex-col min-w-0">
                <div className="px-2 py-1 border-b border-border bg-muted/30 font-medium">
                  RISK
                </div>
                <div className="flex-1 flex flex-col p-2 gap-3 overflow-auto scrollbar-hide">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">VaR 95%</span>
                      <span className="text-red-400 font-mono">
                        {formatPct(riskMetrics.var95)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">VaR 99%</span>
                      <span className="text-red-400 font-mono">
                        {formatPct(riskMetrics.var99)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Diversification
                      </span>
                      <span className="font-mono">
                        {riskMetrics.diversificationRatio.toFixed(2)}x
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Effective Bets
                      </span>
                      <span className="font-mono">
                        {riskMetrics.effectiveBets.toFixed(1)}
                      </span>
                    </div>
                  </div>
                  <div className="border-t border-border/50 pt-2">
                    <div className="text-[10px] text-muted-foreground font-medium mb-1.5">
                      Stress Tests
                    </div>
                    <div className="space-y-1">
                      {stressTests.map(t => (
                        <div
                          key={t.scenario}
                          className="flex items-center justify-between"
                        >
                          <span className="text-muted-foreground truncate">
                            {t.scenario}
                          </span>
                          <span
                            className={
                              t.portfolioImpact < 0
                                ? "text-red-400 font-mono"
                                : "text-green-400 font-mono"
                            }
                          >
                            {formatPct(t.portfolioImpact)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="border-t border-border/50 pt-2">
                    <div className="text-[10px] text-muted-foreground font-medium mb-1.5">
                      Monte Carlo (1 Year)
                    </div>
                    <div className="flex items-end gap-px h-12">
                      {monteCarloData.map(d => (
                        <div
                          key={d.bucket}
                          className="flex-1"
                          style={{
                            height: `${(d.frequency / maxFreq) * 100}%`,
                            backgroundColor:
                              d.bucket >= 0 ? "#22c55e" : "#ef4444",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="border-t border-border/50 pt-2">
                    <div className="text-[10px] text-muted-foreground font-medium mb-1.5">
                      Correlation
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="p-0.5"></th>
                          {correlationAssets.map(a => (
                            <th
                              key={a}
                              className="p-0.5 text-[10px] text-muted-foreground font-medium text-center"
                            >
                              {a}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {correlationAssets.map(a1 => (
                          <tr key={a1}>
                            <td className="p-0.5 text-[10px] text-muted-foreground font-medium">
                              {a1}
                            </td>
                            {correlationAssets.map(a2 => {
                              const corr = getCorrelation(a1, a2)
                              return (
                                <td key={a2} className="p-0.5 text-center">
                                  <div
                                    className={twMerge(
                                      clsx(
                                        "w-full h-4 flex items-center justify-center rounded text-[9px] font-mono",
                                        getCorrelationColor(corr),
                                        a1 === a2 ? "opacity-40" : "",
                                      ),
                                    )}
                                  >
                                    {corr.toFixed(1)}
                                  </div>
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="px-3 py-1.5 border-t border-border bg-muted/30 text-[10px] text-muted-foreground flex justify-between items-center">
          <div className="flex gap-3">
            <span className={focusedPanel === "screener" ? "text-primary" : ""}>
              <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">1</kbd>{" "}
              Screener
            </span>
            <span
              className={focusedPanel === "positions" ? "text-primary" : ""}
            >
              <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">2</kbd>{" "}
              Positions
            </span>
            <span className="border-l border-border pl-3">
              <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">j</kbd>/
              <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">k</kbd>{" "}
              navigate
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">o</kbd>{" "}
              expand
            </span>
            {focusedPanel === "positions" && (
              <>
                <span className="border-l border-border pl-3">
                  <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">
                    w
                  </kbd>{" "}
                  weight
                </span>
                <span>
                  <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">
                    n
                  </kbd>{" "}
                  notional
                </span>
              </>
            )}
            <span className="border-l border-border pl-3">
              <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">[</kbd>/
              <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">]</kbd>{" "}
              leverage
            </span>
            {stagedTrades.length > 0 && (
              <span className="text-primary">
                <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">
                  x
                </kbd>{" "}
                execute
              </span>
            )}
          </div>
          <span>
            <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">?</kbd>{" "}
            all shortcuts
          </span>
        </footer>
      </div>
    </TooltipProvider>
  )
}

export default PrototypePage
