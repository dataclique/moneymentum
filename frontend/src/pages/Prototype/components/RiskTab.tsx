import { useState } from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import type {
  RiskMetricsData,
  StressTest,
  MonteCarloDistribution,
  ConcentrationMetric,
  CorrelationEntry,
} from "../mockData"

type ViewMode =
  | "var"
  | "stress"
  | "concentration"
  | "correlation"
  | "montecarlo"

interface RiskTabProps {
  riskMetrics: RiskMetricsData
  stressTests: StressTest[]
  monteCarloData: MonteCarloDistribution[]
  concentrationMetrics: ConcentrationMetric[]
  correlationMatrix: CorrelationEntry[]
  correlationAssets: string[]
}

const formatPct = (n: number): string =>
  `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`

export const RiskTab = ({
  riskMetrics,
  stressTests,
  monteCarloData,
  concentrationMetrics,
  correlationMatrix,
  correlationAssets,
}: RiskTabProps) => {
  const [viewMode, setViewMode] = useState<ViewMode>("var")
  const [mcSimulations, setMcSimulations] = useState(1000)
  const [mcHorizon, setMcHorizon] = useState(252)

  const maxFreq = Math.max(...monteCarloData.map(d => d.frequency))

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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 py-1 border-b border-border/50 shrink-0">
        <div className="flex gap-1">
          {(
            [
              "var",
              "stress",
              "concentration",
              "correlation",
              "montecarlo",
            ] as const
          ).map(mode => (
            <button
              key={mode}
              onClick={() => {
                setViewMode(mode)
              }}
              className={twMerge(
                clsx(
                  "px-2 py-0.5 text-[9px] rounded transition-colors",
                  viewMode === mode
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                ),
              )}
            >
              {mode === "var"
                ? "VaR"
                : mode === "montecarlo"
                  ? "Monte Carlo"
                  : mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {viewMode === "var" && (
        <div className="flex-1 overflow-auto p-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-2 bg-muted/30 rounded border border-border/50">
              <div className="text-[9px] text-muted-foreground">
                Value at Risk (95%)
              </div>
              <div className="text-lg font-mono text-red-400">
                {formatPct(riskMetrics.var95)}
              </div>
              <div className="text-[9px] text-muted-foreground mt-1">
                95% confidence daily loss limit
              </div>
            </div>
            <div className="p-2 bg-muted/30 rounded border border-border/50">
              <div className="text-[9px] text-muted-foreground">
                Value at Risk (99%)
              </div>
              <div className="text-lg font-mono text-red-400">
                {formatPct(riskMetrics.var99)}
              </div>
              <div className="text-[9px] text-muted-foreground mt-1">
                99% confidence daily loss limit
              </div>
            </div>
            <div className="p-2 bg-muted/30 rounded border border-border/50">
              <div className="text-[9px] text-muted-foreground">
                Diversification Ratio
              </div>
              <div className="text-lg font-mono">
                {riskMetrics.diversificationRatio.toFixed(2)}x
              </div>
              <div className="text-[9px] text-muted-foreground mt-1">
                Portfolio vol / weighted avg vol
              </div>
            </div>
            <div className="p-2 bg-muted/30 rounded border border-border/50">
              <div className="text-[9px] text-muted-foreground">
                Effective Bets
              </div>
              <div className="text-lg font-mono">
                {riskMetrics.effectiveBets.toFixed(1)}
              </div>
              <div className="text-[9px] text-muted-foreground mt-1">
                Independent risk sources
              </div>
            </div>
          </div>
        </div>
      )}

      {viewMode === "stress" && (
        <div className="flex-1 overflow-auto p-2">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-muted-foreground border-b border-border/50">
                <th className="text-left py-1 font-medium">Scenario</th>
                <th className="text-right py-1 font-medium">Portfolio</th>
                <th className="text-right py-1 font-medium">BTC</th>
                <th className="text-right py-1 font-medium">ETH</th>
              </tr>
            </thead>
            <tbody>
              {stressTests.map(test => (
                <tr key={test.scenario} className="border-b border-border/30">
                  <td className="py-1.5 text-muted-foreground">
                    {test.scenario}
                  </td>
                  <td
                    className={twMerge(
                      clsx(
                        "py-1.5 text-right font-mono",
                        test.portfolioImpact < 0
                          ? "text-red-400"
                          : "text-green-400",
                      ),
                    )}
                  >
                    {formatPct(test.portfolioImpact)}
                  </td>
                  <td
                    className={twMerge(
                      clsx(
                        "py-1.5 text-right font-mono",
                        test.btcImpact < 0 ? "text-red-400" : "text-green-400",
                      ),
                    )}
                  >
                    {formatPct(test.btcImpact)}
                  </td>
                  <td
                    className={twMerge(
                      clsx(
                        "py-1.5 text-right font-mono",
                        test.ethImpact < 0 ? "text-red-400" : "text-green-400",
                      ),
                    )}
                  >
                    {formatPct(test.ethImpact)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewMode === "concentration" && (
        <div className="flex-1 overflow-auto p-2">
          <div className="space-y-2">
            {concentrationMetrics.map(metric => (
              <div
                key={metric.metric}
                className="flex items-center justify-between p-2 bg-muted/30 rounded border border-border/50"
              >
                <div>
                  <div className="text-[10px] font-medium">{metric.metric}</div>
                  <div className="text-[9px] text-muted-foreground">
                    {metric.description}
                  </div>
                </div>
                <div className="text-right font-mono text-[11px]">
                  {typeof metric.value === "number" && metric.value <= 1
                    ? `${(metric.value * 100).toFixed(1)}%`
                    : metric.value.toFixed(1)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewMode === "correlation" && (
        <div className="flex-1 overflow-auto p-2">
          <div className="overflow-auto">
            <table className="text-[9px]">
              <thead>
                <tr>
                  <th className="p-1"></th>
                  {correlationAssets.map(asset => (
                    <th
                      key={asset}
                      className="p-1 text-muted-foreground font-medium"
                    >
                      {asset}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {correlationAssets.map(asset1 => (
                  <tr key={asset1}>
                    <td className="p-1 text-muted-foreground font-medium">
                      {asset1}
                    </td>
                    {correlationAssets.map(asset2 => {
                      const corr = getCorrelation(asset1, asset2)
                      return (
                        <td key={asset2} className="p-0.5">
                          <div
                            className={twMerge(
                              clsx(
                                "w-8 h-6 flex items-center justify-center rounded text-[8px] font-mono",
                                getCorrelationColor(corr),
                                asset1 === asset2 ? "opacity-50" : "",
                              ),
                            )}
                          >
                            {corr.toFixed(2)}
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
      )}

      {viewMode === "montecarlo" && (
        <div className="flex-1 flex flex-col">
          <div className="flex items-center gap-3 px-2 py-1 border-b border-border/30">
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-muted-foreground">Sims:</span>
              <select
                value={mcSimulations}
                onChange={e => {
                  setMcSimulations(Number(e.target.value))
                }}
                className="text-[9px] bg-muted border border-border rounded px-1 py-0.5"
              >
                <option value={100}>100</option>
                <option value={1000}>1,000</option>
                <option value={10000}>10,000</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-muted-foreground">Horizon:</span>
              <select
                value={mcHorizon}
                onChange={e => {
                  setMcHorizon(Number(e.target.value))
                }}
                className="text-[9px] bg-muted border border-border rounded px-1 py-0.5"
              >
                <option value={21}>1M</option>
                <option value={63}>3M</option>
                <option value={126}>6M</option>
                <option value={252}>1Y</option>
              </select>
            </div>
          </div>
          <div className="flex-1 p-2 flex flex-col">
            <div className="flex-1 flex items-end gap-px min-h-[80px]">
              {monteCarloData.map(d => (
                <div
                  key={d.bucket}
                  className="flex-1 transition-all"
                  style={{
                    height: `${(d.frequency / maxFreq) * 100}%`,
                    backgroundColor: d.bucket >= 0 ? "#22c55e" : "#ef4444",
                  }}
                />
              ))}
            </div>
            <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
              <span>-40%</span>
              <span>0</span>
              <span>+40%</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
              <div className="text-center">
                <div className="text-muted-foreground">5th %ile</div>
                <div className="font-mono text-red-400">-22.5%</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">Median</div>
                <div className="font-mono text-green-400">+8.2%</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">95th %ile</div>
                <div className="font-mono text-green-400">+38.5%</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
