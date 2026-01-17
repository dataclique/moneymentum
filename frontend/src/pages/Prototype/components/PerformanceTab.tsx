import { useEffect, useRef, useState } from "react"
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

interface PerformanceTabProps {
  backtestData: BacktestPoint[]
  drawdownData: DrawdownPoint[]
  returnDistribution: ReturnDistributionBucket[]
  performanceStats: PerformanceStats
  hasStagedTrades: boolean
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
}: PerformanceTabProps) => {
  const chartRef = useRef<HTMLDivElement>(null)
  const [chartType, setChartType] = useState<ChartType>("equity")
  const [period, setPeriod] = useState<Period>("All")
  const [comparisonMode, setComparisonMode] =
    useState<ComparisonMode>("current")

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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/50 shrink-0">
        <div className="flex gap-1">
          {(["equity", "drawdown", "distribution"] as const).map(type => (
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
              {type === "equity"
                ? "Equity"
                : type === "drawdown"
                  ? "Drawdown"
                  : "Distribution"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["1M", "3M", "6M", "1Y", "All"] as const).map(p => (
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
          {(["current", "target", "compare"] as const).map(mode => (
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
