import { useEffect, useRef, useState, useMemo } from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { createChart, LineSeries, type Time } from "lightweight-charts"
import type {
  FactorExposure,
  FactorHistoricalReturn,
  FactorAttribution,
} from "../mockData"

type ViewMode = "exposures" | "performance" | "attribution"

interface FactorsTabProps {
  factorExposures: FactorExposure[]
  factorHistoricalReturns: FactorHistoricalReturn[]
  factorAttribution: FactorAttribution[]
}

const FACTOR_COLORS: Record<string, string> = {
  "Market Beta": "#3b82f6",
  "Momentum": "#22c55e",
  "Carry": "#f59e0b",
  "Volatility": "#ef4444",
  "Size": "#8b5cf6",
}

export const FactorsTab = ({
  factorExposures,
  factorHistoricalReturns,
  factorAttribution,
}: FactorsTabProps) => {
  const chartRef = useRef<HTMLDivElement>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("exposures")
  const [selectedFactors, setSelectedFactors] = useState<string[]>([
    "Momentum",
    "Market Beta",
  ])
  const [simulationFactor, setSimulationFactor] = useState<string | null>(null)
  const simulationAmount = 10

  const availableFactors = useMemo(
    () => Array.from(new Set(factorHistoricalReturns.map(r => r.factor))),
    [factorHistoricalReturns],
  )

  const toggleFactor = (factor: string) => {
    setSelectedFactors(prev => {
      if (prev.includes(factor)) {
        return prev.filter(f => f !== factor)
      }
      if (prev.length >= 2) {
        return [prev[1], factor]
      }
      return [...prev, factor]
    })
  }

  // useEffect justified: LightweightCharts requires imperative DOM manipulation
  // and cleanup. No React wrapper exists that provides equivalent functionality.
  useEffect(() => {
    const container = chartRef.current
    if (!container || viewMode !== "performance") return

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { color: "transparent" }, textColor: "#888" },
      grid: { vertLines: { color: "#222" }, horzLines: { color: "#222" } },
      timeScale: { borderColor: "#333", timeVisible: false },
      rightPriceScale: { borderColor: "#333" },
      crosshair: { mode: 0 },
    })

    for (const factor of selectedFactors) {
      const factorData = factorHistoricalReturns.filter(
        r => r.factor === factor,
      )
      const series = chart.addSeries(LineSeries, {
        color: FACTOR_COLORS[factor] ?? "#888",
        lineWidth: 2,
        title: factor,
      })
      series.setData(
        factorData.map(d => ({ time: d.date as Time, value: d.value })),
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
  }, [factorHistoricalReturns, selectedFactors, viewMode])

  const totalContribution = factorAttribution.reduce(
    (sum, f) => sum + f.contribution,
    0,
  )

  const simulatedExposures = useMemo(() => {
    if (!simulationFactor) return factorExposures
    return factorExposures.map(f => ({
      ...f,
      value:
        f.name === simulationFactor
          ? f.value + simulationAmount / 100
          : f.value,
    }))
  }, [factorExposures, simulationFactor, simulationAmount])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/50 shrink-0">
        <div className="flex gap-1">
          {(["exposures", "performance", "attribution"] as const).map(mode => (
            <button
              key={mode}
              onClick={() => {
                setViewMode(mode)
              }}
              className={twMerge(
                clsx(
                  "px-2 py-0.5 text-[9px] rounded transition-colors capitalize",
                  viewMode === mode
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                ),
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        {viewMode === "exposures" && (
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-muted-foreground">Simulate:</span>
            <select
              value={simulationFactor ?? ""}
              onChange={e => {
                setSimulationFactor(e.target.value || null)
              }}
              className="text-[9px] bg-muted border border-border rounded px-1 py-0.5"
            >
              <option value="">None</option>
              {availableFactors.map(f => (
                <option key={f} value={f}>
                  +{simulationAmount}% {f}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {viewMode === "exposures" && (
        <div className="flex-1 overflow-auto p-2">
          <div className="space-y-2">
            {simulatedExposures.map(f => {
              const original = factorExposures.find(e => e.name === f.name)
              const delta = original ? f.value - original.value : 0
              return (
                <div key={f.name} className="flex items-center gap-2">
                  <span className="w-20 text-[10px] text-muted-foreground truncate">
                    {f.name}
                  </span>
                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden relative">
                    <div className="absolute left-1/2 w-px h-full bg-border" />
                    <div
                      className={twMerge(
                        clsx(
                          "absolute h-full rounded-full transition-all",
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
                  <span className="w-12 text-right font-mono text-[10px]">
                    {f.value >= 0 ? "+" : ""}
                    {f.value.toFixed(2)}
                  </span>
                  {delta !== 0 && (
                    <span className="w-10 text-right font-mono text-[9px] text-blue-400">
                      ({delta >= 0 ? "+" : ""}
                      {delta.toFixed(2)})
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          {simulationFactor && (
            <div className="mt-3 p-2 bg-muted/30 rounded border border-border/50">
              <div className="text-[9px] text-muted-foreground mb-1">
                Projected Impact
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div>
                  <span className="text-muted-foreground">Δ Sharpe:</span>
                  <span className="text-green-400 ml-1">+0.08</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Δ Return:</span>
                  <span className="text-green-400 ml-1">+1.2%</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Δ Vol:</span>
                  <span className="text-red-400 ml-1">+0.5%</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {viewMode === "performance" && (
        <div className="flex-1 flex flex-col">
          <div className="flex gap-1 px-2 py-1 border-b border-border/30 flex-wrap">
            {availableFactors.map(factor => (
              <button
                key={factor}
                onClick={() => {
                  toggleFactor(factor)
                }}
                className={twMerge(
                  clsx(
                    "px-1.5 py-0.5 text-[9px] rounded transition-colors",
                    selectedFactors.includes(factor)
                      ? "text-white"
                      : "text-muted-foreground hover:bg-muted",
                  ),
                )}
                style={{
                  backgroundColor: selectedFactors.includes(factor)
                    ? FACTOR_COLORS[factor]
                    : undefined,
                }}
              >
                {factor.replace("Market ", "")}
              </button>
            ))}
          </div>
          <div ref={chartRef} className="flex-1 min-h-[120px]" />
        </div>
      )}

      {viewMode === "attribution" && (
        <div className="flex-1 overflow-auto p-2">
          <div className="space-y-1.5">
            {factorAttribution.map(f => {
              const pctOfTotal = (f.contribution / totalContribution) * 100
              return (
                <div key={f.factor} className="flex items-center gap-2">
                  <span className="w-24 text-[10px] text-muted-foreground truncate">
                    {f.factor}
                  </span>
                  <div className="flex-1 h-3 bg-muted rounded overflow-hidden">
                    <div
                      className="h-full rounded transition-all"
                      style={{
                        width: `${Math.abs(pctOfTotal)}%`,
                        backgroundColor: f.color,
                        opacity: f.contribution >= 0 ? 1 : 0.5,
                      }}
                    />
                  </div>
                  <span
                    className={twMerge(
                      clsx(
                        "w-14 text-right font-mono text-[10px]",
                        f.contribution >= 0 ? "text-green-500" : "text-red-500",
                      ),
                    )}
                  >
                    {f.contribution >= 0 ? "+" : ""}
                    {(f.contribution * 100).toFixed(1)}%
                  </span>
                </div>
              )
            })}
          </div>
          <div className="mt-3 pt-2 border-t border-border/50 flex justify-between text-[10px]">
            <span className="text-muted-foreground">
              Total Return Explained
            </span>
            <span className="font-mono text-green-500">
              +{(totalContribution * 100).toFixed(1)}%
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
