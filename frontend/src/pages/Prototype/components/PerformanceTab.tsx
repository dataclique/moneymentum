import { useEffect, useRef, useState, useCallback } from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import {
  createChart,
  AreaSeries,
  HistogramSeries,
  type Time,
} from "lightweight-charts"
import type {
  BacktestPoint,
  DrawdownPoint,
  ReturnDistributionBucket,
  PerformanceStats,
} from "../mockData"

type ChartType = "equity" | "drawdown" | "distribution"
type Period = "1M" | "3M" | "6M" | "1Y" | "All"
type ComparisonMode = "current" | "target" | "compare"

const CHART_TYPES: ChartType[] = ["equity", "drawdown", "distribution"]
const PERIODS: Period[] = ["1M", "3M", "6M", "1Y", "All"]
const COMPARISON_MODES: ComparisonMode[] = ["current", "target", "compare"]

interface PerformanceTabProps {
  backtestData: BacktestPoint[]
  drawdownData: DrawdownPoint[]
  returnDistribution: ReturnDistributionBucket[]
  performanceStats: PerformanceStats
  hasStagedTrades: boolean
  isFocused?: boolean
}

const formatPct = (n: number): string =>
  `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`

const PERIOD_DAYS: Record<Period, number> = {
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "1Y": 365,
  "All": Infinity,
}

export const PerformanceTab = ({
  backtestData,
  drawdownData,
  returnDistribution,
  performanceStats,
  hasStagedTrades,
  isFocused = false,
}: PerformanceTabProps) => {
  const chartRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [chartType, setChartType] = useState<ChartType>("equity")
  const [period, setPeriod] = useState<Period>("All")
  const [comparisonMode, setComparisonMode] =
    useState<ComparisonMode>("current")

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isFocused) return

      // Number keys 1-3 for chart type
      if (event.key >= "1" && event.key <= "3") {
        const index = parseInt(event.key) - 1
        if (index < CHART_TYPES.length) {
          setChartType(CHART_TYPES[index])
        }
        return
      }

      // q/w/e for periods (first 3), r/t for last 2
      const periodKeyMap: Record<string, number> = {
        q: 0, // 1M
        w: 1, // 3M
        e: 2, // 6M
        r: 3, // 1Y
        t: 4, // All
      }
      if (event.key in periodKeyMap) {
        setPeriod(PERIODS[periodKeyMap[event.key]])
        return
      }

      // Arrow left/right for period navigation
      if (event.key === "ArrowLeft" || event.key === "h") {
        const currentIndex = PERIODS.indexOf(period)
        if (currentIndex > 0) {
          setPeriod(PERIODS[currentIndex - 1])
        }
        return
      }
      if (event.key === "ArrowRight" || event.key === "l") {
        const currentIndex = PERIODS.indexOf(period)
        if (currentIndex < PERIODS.length - 1) {
          setPeriod(PERIODS[currentIndex + 1])
        }
        return
      }

      // c for cycling comparison mode (when staged trades exist)
      if (event.key === "c" && hasStagedTrades) {
        const currentIndex = COMPARISON_MODES.indexOf(comparisonMode)
        const nextIndex = (currentIndex + 1) % COMPARISON_MODES.length
        setComparisonMode(COMPARISON_MODES[nextIndex])
        return
      }
    },
    [isFocused, period, comparisonMode, hasStagedTrades],
  )

  // useEffect justified: Global keyboard listener needed for keyboard navigation
  // when this panel is focused. Cannot be handled via onKeyDown since focus may
  // not be on this DOM element while it's logically "focused" in the app state.
  useEffect(() => {
    if (!isFocused) return
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isFocused, handleKeyDown])

  // useEffect justified: LightweightCharts requires imperative DOM manipulation
  // and cleanup. No React wrapper exists that provides equivalent functionality.
  useEffect(() => {
    const container = chartRef.current
    if (!container) return

    const filterDataByPeriod = <T extends { time: number }>(data: T[]): T[] => {
      if (period === "All") return data
      const now = Math.floor(Date.now() / 1000)
      const cutoff = now - PERIOD_DAYS[period] * 24 * 60 * 60
      return data.filter(d => d.time >= cutoff)
    }

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { color: "transparent" }, textColor: "#888" },
      grid: { vertLines: { color: "#222" }, horzLines: { color: "#222" } },
      timeScale: { borderColor: "#333", timeVisible: false },
      rightPriceScale: { borderColor: "#333" },
      crosshair: { mode: 0 },
    })

    if (chartType === "equity") {
      const series = chart.addSeries(AreaSeries, {
        lineColor: "#22c55e",
        topColor: "rgba(34, 197, 94, 0.3)",
        bottomColor: "rgba(34, 197, 94, 0)",
        lineWidth: 1,
      })
      const filteredData = filterDataByPeriod(backtestData)
      series.setData(
        filteredData.map(d => ({ time: d.time as Time, value: d.value })),
      )
    } else if (chartType === "drawdown") {
      const series = chart.addSeries(AreaSeries, {
        lineColor: "#ef4444",
        topColor: "rgba(239, 68, 68, 0)",
        bottomColor: "rgba(239, 68, 68, 0.3)",
        lineWidth: 1,
      })
      const filteredData = filterDataByPeriod(drawdownData)
      series.setData(
        filteredData.map(d => ({ time: d.time as Time, value: d.drawdown })),
      )
    } else {
      const series = chart.addSeries(HistogramSeries, {
        color: "#22c55e",
      })
      series.setData(
        returnDistribution.map((d, i) => ({
          time: i as unknown as Time,
          value: d.frequency,
          color: d.bucket >= 0 ? "#22c55e" : "#ef4444",
        })),
      )
      chart.timeScale().applyOptions({ visible: false })
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
  }, [backtestData, drawdownData, returnDistribution, chartType, period])

  const targetStats: PerformanceStats = {
    totalReturn: performanceStats.totalReturn * 1.08,
    sharpeRatio: performanceStats.sharpeRatio * 1.05,
    maxDrawdown: performanceStats.maxDrawdown * 0.92,
    sortinoRatio: performanceStats.sortinoRatio * 1.06,
    winRate: performanceStats.winRate + 0.02,
    profitFactor: performanceStats.profitFactor * 1.04,
  }

  const displayStats =
    comparisonMode === "target" ? targetStats : performanceStats
  const calmar = Math.abs(displayStats.totalReturn / displayStats.maxDrawdown)

  return (
    <div
      ref={containerRef}
      className={twMerge(
        clsx(
          "flex flex-col h-full",
          isFocused && "ring-1 ring-primary/50 ring-inset",
        ),
      )}
      data-testid="performance-tab"
    >
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/50 shrink-0">
        <div className="flex gap-1">
          {CHART_TYPES.map((type, index) => (
            <button
              key={type}
              onClick={() => {
                setChartType(type)
              }}
              className={twMerge(
                clsx(
                  "px-2 py-0.5 text-[9px] rounded transition-colors",
                  chartType === type
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                ),
              )}
            >
              {isFocused && (
                <span className="text-[8px] opacity-60 mr-0.5">
                  {index + 1}
                </span>
              )}
              {type === "equity"
                ? "Equity"
                : type === "drawdown"
                  ? "Drawdown"
                  : "Distribution"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {isFocused && (
            <span className="text-[8px] text-muted-foreground self-center mr-0.5">
              ←→
            </span>
          )}
          {PERIODS.map(p => (
            <button
              key={p}
              onClick={() => {
                setPeriod(p)
              }}
              className={twMerge(
                clsx(
                  "px-1.5 py-0.5 text-[9px] rounded transition-colors",
                  period === p
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                ),
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div ref={chartRef} className="flex-1 min-h-[120px]" />

      <div className="grid grid-cols-7 gap-x-2 gap-y-1 p-2 border-t border-border/50 shrink-0">
        <div>
          <div className="text-muted-foreground text-[9px]">Return</div>
          <div
            className={twMerge(
              clsx(
                "font-mono text-[11px]",
                displayStats.totalReturn >= 0
                  ? "text-green-500"
                  : "text-red-500",
              ),
            )}
          >
            {formatPct(displayStats.totalReturn)}
            {comparisonMode === "compare" && (
              <span className="text-[8px] text-green-400 ml-0.5">
                +
                {(
                  (targetStats.totalReturn - performanceStats.totalReturn) *
                  100
                ).toFixed(1)}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[9px]">Sharpe</div>
          <div className="font-mono text-[11px]">
            {displayStats.sharpeRatio.toFixed(2)}
            {comparisonMode === "compare" && (
              <span className="text-[8px] text-green-400 ml-0.5">
                +
                {(
                  targetStats.sharpeRatio - performanceStats.sharpeRatio
                ).toFixed(2)}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[9px]">Sortino</div>
          <div className="font-mono text-[11px]">
            {displayStats.sortinoRatio.toFixed(2)}
            {comparisonMode === "compare" && (
              <span className="text-[8px] text-green-400 ml-0.5">
                +
                {(
                  targetStats.sortinoRatio - performanceStats.sortinoRatio
                ).toFixed(2)}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[9px]">Max DD</div>
          <div className="font-mono text-[11px] text-red-400">
            {formatPct(displayStats.maxDrawdown)}
            {comparisonMode === "compare" && (
              <span className="text-[8px] text-green-400 ml-0.5">
                {(
                  (targetStats.maxDrawdown - performanceStats.maxDrawdown) *
                  100
                ).toFixed(1)}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[9px]">Win Rate</div>
          <div className="font-mono text-[11px]">
            {(displayStats.winRate * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[9px]">Profit</div>
          <div className="font-mono text-[11px]">
            {displayStats.profitFactor.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-[9px]">Calmar</div>
          <div className="font-mono text-[11px]">{calmar.toFixed(2)}</div>
        </div>
      </div>

      {hasStagedTrades && (
        <div className="flex gap-1 px-2 py-1 border-t border-border/50 shrink-0">
          {isFocused && (
            <span className="text-[8px] text-muted-foreground self-center mr-0.5">
              c
            </span>
          )}
          {COMPARISON_MODES.map(mode => (
            <button
              key={mode}
              onClick={() => {
                setComparisonMode(mode)
              }}
              className={twMerge(
                clsx(
                  "px-2 py-0.5 text-[9px] rounded transition-colors capitalize",
                  comparisonMode === mode
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                ),
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
