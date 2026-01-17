import * as React from "react"
import { useEffect, useRef, useMemo, useState, useCallback } from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import {
  Search,
  Plus,
  Minus,
  X,
  Send,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { HelpOverlay } from "./components/HelpOverlay"
import { usePrototypeData } from "./hooks/usePrototypeData"
import {
  createChart,
  AreaSeries,
  HistogramSeries,
  type Time,
} from "lightweight-charts"

type PanelId = "positions" | "screener"
type ChartView = "equity" | "drawdown" | "pnl" | "rollingSharpe"

const formatNum = (n: number | null | undefined, decimals = 2): string => {
  if (n === null || n === undefined) return "—"
  return n.toFixed(decimals)
}

const formatPct = (n: number): string =>
  `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`

const formatUsd = (n: number): string => {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

const CHART_VIEW_OPTIONS: { value: ChartView; label: string }[] = [
  { value: "equity", label: "Equity Curve" },
  { value: "drawdown", label: "Drawdown" },
  { value: "pnl", label: "Daily PnL" },
  { value: "rollingSharpe", label: "Rolling Sharpe" },
]

const PrototypePage = () => {
  const data = usePrototypeData()
  const [focusedPanel, setFocusedPanel] = useState<PanelId | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [collapsedUnderlyings, setCollapsedUnderlyings] = useState<Set<string>>(
    new Set(),
  )
  const [chartView, setChartView] = useState<ChartView>("equity")
  const performanceChartRef = useRef<HTMLDivElement>(null)

  const {
    positionsByUnderlying,
    greeks,
    factorExposures,
    assetAnalysis,
    isLoading,
    stagedTrades,
    addStagedTrade,
    removeStagedTrade,
    clearStagedTrades,
    executeStagedTrades,
    riskMetrics,
    stressTests,
    monteCarloData,
    backtestData,
    performanceStats,
    factorAttribution,
    concentrationMetrics,
    drawdownData,
    correlationMatrix,
    correlationAssets,
  } = data

  // Generate derived chart data
  const dailyPnlData = useMemo(() => {
    if (backtestData.length < 2) return []
    return backtestData.slice(1).map((d, i) => ({
      time: d.time,
      value: d.value - backtestData[i].value,
    }))
  }, [backtestData])

  const rollingSharpeData = useMemo(() => {
    if (dailyPnlData.length < 30) return []
    const result: { time: number; value: number }[] = []
    for (let i = 29; i < dailyPnlData.length; i++) {
      const window = dailyPnlData.slice(i - 29, i + 1)
      const mean = window.reduce((s, d) => s + d.value, 0) / 30
      const variance =
        window.reduce((s, d) => s + (d.value - mean) ** 2, 0) / 30
      const std = Math.sqrt(variance)
      const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0
      result.push({ time: dailyPnlData[i].time, value: sharpe })
    }
    return result
  }, [dailyPnlData])

  // Performance chart (single unified chart)
  useEffect(() => {
    const container = performanceChartRef.current
    if (!container || !backtestData.length) return

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { color: "transparent" }, textColor: "#888" },
      grid: { vertLines: { color: "#222" }, horzLines: { color: "#222" } },
      timeScale: { borderColor: "#333", timeVisible: false },
      rightPriceScale: { borderColor: "#333" },
      crosshair: { mode: 0 },
    })

    if (chartView === "equity") {
      const series = chart.addSeries(AreaSeries, {
        lineColor: "#22c55e",
        topColor: "rgba(34, 197, 94, 0.3)",
        bottomColor: "rgba(34, 197, 94, 0)",
        lineWidth: 2,
      })
      series.setData(
        backtestData.map(d => ({ time: d.time as Time, value: d.value })),
      )
    } else if (chartView === "drawdown") {
      const series = chart.addSeries(AreaSeries, {
        lineColor: "#ef4444",
        topColor: "rgba(239, 68, 68, 0)",
        bottomColor: "rgba(239, 68, 68, 0.3)",
        lineWidth: 2,
      })
      series.setData(
        drawdownData.map(d => ({ time: d.time as Time, value: d.drawdown })),
      )
    } else if (chartView === "pnl") {
      const series = chart.addSeries(HistogramSeries, {
        color: "#22c55e",
      })
      series.setData(
        dailyPnlData.map(d => ({
          time: d.time as Time,
          value: d.value,
          color: d.value >= 0 ? "#22c55e" : "#ef4444",
        })),
      )
    } else {
      // rollingSharpe
      const series = chart.addSeries(AreaSeries, {
        lineColor: "#3b82f6",
        topColor: "rgba(59, 130, 246, 0.3)",
        bottomColor: "rgba(59, 130, 246, 0)",
        lineWidth: 2,
      })
      series.setData(
        rollingSharpeData.map(d => ({ time: d.time as Time, value: d.value })),
      )
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
  }, [backtestData, drawdownData, dailyPnlData, rollingSharpeData, chartView])

  const analysisMap = useMemo(() => {
    const map = new Map<string, (typeof assetAnalysis)[0]>()
    for (const a of assetAnalysis) map.set(a.ticker, a)
    return map
  }, [assetAnalysis])

  const greeksMap = useMemo(() => {
    const map = new Map<string, (typeof greeks)[0]>()
    for (const g of greeks) map.set(g.symbol, g)
    return map
  }, [greeks])

  const portfolioGreeks = useMemo(() => {
    return greeks.reduce(
      (acc, g) => ({
        delta: acc.delta + g.delta,
        gamma: acc.gamma + g.gamma,
        theta: acc.theta + g.theta,
      }),
      { delta: 0, gamma: 0, theta: 0 },
    )
  }, [greeks])

  const totalNotional = useMemo(() => {
    return positionsByUnderlying.reduce(
      (sum, group) => sum + group.positions.reduce((s, p) => s + p.notional, 0),
      0,
    )
  }, [positionsByUnderlying])

  const hasStaged = stagedTrades.length > 0

  const filteredAssets = useMemo(() => {
    let results = assetAnalysis
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      results = results.filter(a => a.ticker.toLowerCase().includes(q))
    }
    return results.sort((a, b) => b.sharpe - a.sharpe)
  }, [assetAnalysis, searchQuery])

  const toggleUnderlying = (underlying: string) => {
    setCollapsedUnderlyings(prev => {
      const next = new Set(prev)
      if (next.has(underlying)) next.delete(underlying)
      else next.add(underlying)
      return next
    })
  }

  const focusPanel = useCallback((id: PanelId | null) => {
    setFocusedPanel(id)
  }, [])

  const toggleHelp = useCallback(() => {
    setShowHelp(prev => !prev)
  }, [])

  // Keyboard navigation
  useEffect(() => {
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
        } else {
          focusPanel(null)
        }
        return
      }

      if (event.key === "1") {
        event.preventDefault()
        focusPanel("screener")
        return
      }
      if (event.key === "2") {
        event.preventDefault()
        focusPanel("positions")
        return
      }

      if (focusedPanel && ["h", "l"].includes(key)) {
        event.preventDefault()
        if (key === "h") focusPanel("screener")
        if (key === "l") focusPanel("positions")
        return
      }

      if (!focusedPanel && ["h", "j", "k", "l"].includes(key)) {
        event.preventDefault()
        focusPanel("screener")
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [focusedPanel, showHelp, focusPanel, toggleHelp])

  const maxFreq = Math.max(...monteCarloData.map(d => d.frequency))
  const totalAttribution = factorAttribution.reduce(
    (sum, f) => sum + f.contribution,
    0,
  )

  const getCorrelation = (a1: string, a2: string): number => {
    const entry = correlationMatrix.find(
      e =>
        (e.asset1 === a1 && e.asset2 === a2) ||
        (e.asset1 === a2 && e.asset2 === a1),
    )
    return entry?.correlation ?? 0
  }

  const getCorrelationColor = (corr: number): string => {
    if (corr >= 0.7) return "bg-green-600"
    if (corr >= 0.3) return "bg-green-500/60"
    if (corr >= 0) return "bg-green-500/30"
    if (corr >= -0.3) return "bg-red-500/30"
    if (corr >= -0.7) return "bg-red-500/60"
    return "bg-red-600"
  }

  const FACTOR_COLORS: Record<string, string> = {
    "Market Beta": "#3b82f6",
    "Momentum": "#22c55e",
    "Carry": "#f59e0b",
    "Volatility": "#ef4444",
    "Size": "#8b5cf6",
    "Idiosyncratic": "#888888",
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden text-[11px]">
      {showHelp && <HelpOverlay onClose={toggleHelp} />}

      {/* Header */}
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0 bg-muted/30">
        <div className="flex items-center gap-4">
          <span className="font-semibold">Moneymentum</span>
          <div className="h-4 border-l border-border" />
          <span className="text-muted-foreground">NAV</span>
          <span className="font-mono">${data.nav.toLocaleString()}</span>
          <span className="text-muted-foreground">Notional</span>
          <span className="font-mono">{formatUsd(totalNotional)}</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-muted-foreground">Δ</span>
          <span className="font-mono">{portfolioGreeks.delta.toFixed(2)}</span>
          <span className="text-muted-foreground">Γ</span>
          <span className="font-mono">{portfolioGreeks.gamma.toFixed(3)}</span>
          <span className="text-muted-foreground">Θ</span>
          <span className="font-mono">{portfolioGreeks.theta.toFixed(3)}</span>
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
            focusPanel("screener")
          }}
        >
          <div className="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center gap-2">
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
              1
            </kbd>
            <span className="font-medium">SCREENER</span>
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
          <div className="flex-1 overflow-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-muted/90 z-10">
                <tr className="text-muted-foreground text-[10px]">
                  <th className="px-2 py-1 text-left font-medium">Symbol</th>
                  <th className="px-2 py-1 text-right font-medium">Sharpe</th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {filteredAssets.map(asset => (
                  <tr
                    key={asset.ticker}
                    className="border-b border-border/20 hover:bg-muted/30"
                  >
                    <td className="px-2 py-1 font-medium">{asset.ticker}</td>
                    <td
                      className={twMerge(
                        clsx(
                          "px-2 py-1 text-right font-mono",
                          asset.sharpe > 0 ? "text-green-500" : "text-red-500",
                        ),
                      )}
                    >
                      {asset.sharpe.toFixed(2)}
                    </td>
                    <td className="px-1 py-1 text-right">
                      <button
                        className="text-green-500 hover:text-green-400 p-0.5"
                        onClick={e => {
                          e.stopPropagation()
                          addStagedTrade(asset.ticker, "buy")
                        }}
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                      <button
                        className="text-red-500 hover:text-red-400 p-0.5"
                        onClick={e => {
                          e.stopPropagation()
                          addStagedTrade(asset.ticker, "sell")
                        }}
                      >
                        <Minus className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}
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
            focusPanel("positions")
          }}
        >
          <div className="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
                2
              </kbd>
              <span className="font-medium">POSITIONS</span>
            </div>
            <span className="text-muted-foreground">
              {positionsByUnderlying.length} assets
            </span>
          </div>

          {/* Positions table */}
          <div className="flex-1 overflow-auto min-h-0">
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
                      Notional
                    </th>
                    <th className="px-2 py-1 text-right font-medium">%</th>
                    <th className="px-2 py-1 text-right font-medium">Δ</th>
                    <th className="px-2 py-1 text-right font-medium">Γ</th>
                    <th className="px-2 py-1 text-right font-medium">Θ</th>
                    <th className="px-2 py-1 text-right font-medium">Sharpe</th>
                    <th className="px-1 py-1 w-14"></th>
                  </tr>
                </thead>
                <tbody>
                  {positionsByUnderlying.map(group => {
                    const isExpanded = !collapsedUnderlyings.has(
                      group.underlying,
                    )
                    const analysis = analysisMap.get(group.underlying)
                    const greekData = greeksMap.get(group.underlying)
                    const groupNotional = group.positions.reduce(
                      (s, p) => s + p.notional,
                      0,
                    )
                    const groupPct = group.positions.reduce(
                      (s, p) => s + p.percentage,
                      0,
                    )
                    const netSide = group.positions.reduce(
                      (s, p) =>
                        s + (p.side === "long" ? p.notional : -p.notional),
                      0,
                    )

                    return (
                      <React.Fragment key={group.underlying}>
                        <tr
                          className="border-b border-border/30 hover:bg-muted/20 cursor-pointer"
                          onClick={() => {
                            toggleUnderlying(group.underlying)
                          }}
                        >
                          <td className="px-1 py-1 text-muted-foreground">
                            {group.positions.length > 1 ? (
                              isExpanded ? (
                                <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ChevronRight className="h-3 w-3" />
                              )
                            ) : null}
                          </td>
                          <td className="px-2 py-1 font-medium">
                            {group.underlying}
                          </td>
                          <td className="px-2 py-1">
                            <span
                              className={twMerge(
                                clsx(
                                  "text-[10px] font-medium px-1.5 py-0.5 rounded",
                                  netSide >= 0
                                    ? "bg-green-500/20 text-green-500"
                                    : "bg-red-500/20 text-red-500",
                                ),
                              )}
                            >
                              {netSide >= 0 ? "LONG" : "SHORT"}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {formatUsd(groupNotional)}
                          </td>
                          <td className="px-2 py-1 text-right text-muted-foreground">
                            {groupPct.toFixed(1)}%
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
                          <td
                            className={twMerge(
                              clsx(
                                "px-2 py-1 text-right font-mono",
                                analysis?.sharpe && analysis.sharpe > 0
                                  ? "text-green-500"
                                  : "text-red-500",
                              ),
                            )}
                          >
                            {formatNum(analysis?.sharpe)}
                          </td>
                          <td
                            className="px-1 py-1 text-right"
                            onClick={e => {
                              e.stopPropagation()
                            }}
                          >
                            <button
                              className="text-green-500 hover:text-green-400 p-0.5"
                              onClick={() => {
                                addStagedTrade(group.underlying, "buy")
                              }}
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                            <button
                              className="text-red-500 hover:text-red-400 p-0.5"
                              onClick={() => {
                                addStagedTrade(group.underlying, "sell")
                              }}
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                        {isExpanded &&
                          group.positions.length > 1 &&
                          group.positions.map(pos => {
                            // Look up greeks by underlying, scale by position weight
                            const underlyingGreeks = greeksMap.get(
                              group.underlying,
                            )
                            const posWeight = pos.notional / groupNotional
                            const instrumentType = pos.symbol.includes("/")
                              ? "PERP"
                              : pos.symbol.includes("-PUT")
                                ? "PUT"
                                : pos.symbol.includes("-CALL")
                                  ? "CALL"
                                  : "SPOT"
                            return (
                              <tr
                                key={pos.symbol}
                                className="bg-muted/10 border-b border-border/10 text-muted-foreground"
                              >
                                <td></td>
                                <td className="px-2 py-0.5 pl-4">
                                  └ {instrumentType}
                                </td>
                                <td></td>
                                <td className="px-2 py-0.5 text-right font-mono">
                                  {formatUsd(pos.notional)}
                                </td>
                                <td className="px-2 py-0.5 text-right">
                                  {pos.percentage.toFixed(1)}%
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
                                <td colSpan={2}></td>
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

          {/* Staged Trades Section */}
          <div className="border-t border-border shrink-0">
            <div className="px-2 py-1.5 bg-muted/30 flex items-center justify-between">
              <span className="font-medium">STAGED TRADES</span>
              {hasStaged && (
                <button
                  className="text-muted-foreground hover:text-destructive"
                  onClick={e => {
                    e.stopPropagation()
                    clearStagedTrades()
                  }}
                >
                  Clear all
                </button>
              )}
            </div>
            {!hasStaged ? (
              <div className="px-2 py-3 text-muted-foreground text-center">
                No pending trades. Click{" "}
                <Plus className="h-3 w-3 inline text-green-500" /> or{" "}
                <Minus className="h-3 w-3 inline text-red-500" /> to stage.
              </div>
            ) : (
              <div className="max-h-[140px] overflow-auto">
                {stagedTrades.map(t => (
                  <div
                    key={t.id}
                    className="flex items-center px-2 py-1.5 border-b border-border/30"
                  >
                    <span
                      className={twMerge(
                        clsx(
                          "text-[10px] font-medium px-1.5 py-0.5 rounded",
                          t.side === "buy"
                            ? "bg-green-500/20 text-green-500"
                            : "bg-red-500/20 text-red-500",
                        ),
                      )}
                    >
                      {t.side === "buy" ? "BUY" : "SELL"}
                    </span>
                    <span className="flex-1 px-2 truncate font-medium">
                      {t.symbol}
                    </span>
                    <span className="text-muted-foreground font-mono">
                      {formatUsd(t.notional)}
                    </span>
                    <button
                      className="text-muted-foreground hover:text-destructive ml-2"
                      onClick={e => {
                        e.stopPropagation()
                        removeStagedTrade(t.id)
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <div className="p-2">
                  <Button
                    size="sm"
                    className="w-full h-7"
                    onClick={executeStagedTrades}
                  >
                    <Send className="h-3 w-3 mr-1.5" />
                    Execute {stagedTrades.length} trade
                    {stagedTrades.length > 1 ? "s" : ""}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Center: Analysis panels */}
        <div className="flex-1 flex flex-col gap-1 min-w-0">
          {/* Top row: Performance */}
          <div
            className="border border-border rounded flex flex-col"
            style={{ height: "45%" }}
          >
            <div className="px-2 py-1 border-b border-border bg-muted/30 font-medium">
              PERFORMANCE
            </div>
            <div className="flex-1 flex min-h-0">
              {/* Metrics on the left - single column with breathing room */}
              <div className="w-[180px] shrink-0 border-r border-border/30 p-3 overflow-auto flex flex-col gap-2">
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
              <div className="flex-1 flex flex-col min-w-0">
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/30 bg-muted/20">
                  {CHART_VIEW_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setChartView(opt.value)
                      }}
                      className={twMerge(
                        clsx(
                          "px-2.5 py-1 text-[10px] rounded transition-colors",
                          chartView === opt.value
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted",
                        ),
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex-1 min-h-0 p-2">
                  <div ref={performanceChartRef} className="w-full h-full" />
                </div>
              </div>
            </div>
          </div>

          {/* Bottom row: Factors and Risk side by side */}
          <div className="flex-1 flex gap-1 min-h-0">
            {/* Factors */}
            <div className="flex-1 border border-border rounded flex flex-col min-w-0">
              <div className="px-2 py-1 border-b border-border bg-muted/30 font-medium">
                FACTORS
              </div>
              <div className="flex-1 flex flex-col p-2 gap-3 overflow-auto">
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
              <div className="flex-1 flex flex-col p-2 gap-3 overflow-auto">
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
      <footer className="px-3 py-1 border-t border-border bg-muted/30 text-[10px] text-muted-foreground flex justify-between items-center">
        <div className="flex gap-4">
          <span>
            <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">1</kbd>{" "}
            Screener
            <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono ml-3">
              2
            </kbd>{" "}
            Positions
          </span>
          <span className="border-l border-border pl-4">
            <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">h</kbd>/
            <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">l</kbd>{" "}
            Navigate
          </span>
        </div>
        <span>
          <kbd className="px-1.5 py-0.5 bg-muted rounded font-mono">?</kbd> All
          shortcuts
        </span>
      </footer>
    </div>
  )
}

export default PrototypePage
