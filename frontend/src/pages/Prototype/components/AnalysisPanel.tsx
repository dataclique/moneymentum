import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { PerformanceTab } from "./PerformanceTab"
import { FactorsTab } from "./FactorsTab"
import { RiskTab } from "./RiskTab"
import type {
  BacktestPoint,
  DrawdownPoint,
  ReturnDistributionBucket,
  PerformanceStats,
  FactorExposure,
  FactorHistoricalReturn,
  FactorAttribution,
  RiskMetricsData,
  StressTest,
  MonteCarloDistribution,
  ConcentrationMetric,
  CorrelationEntry,
} from "../mockData"

export type AnalysisTab = "performance" | "factors" | "risk"

interface AnalysisPanelProps {
  backtestData: BacktestPoint[]
  drawdownData: DrawdownPoint[]
  returnDistribution: ReturnDistributionBucket[]
  performanceStats: PerformanceStats
  factorExposures: FactorExposure[]
  factorHistoricalReturns: FactorHistoricalReturn[]
  factorAttribution: FactorAttribution[]
  riskMetrics: RiskMetricsData
  stressTests: StressTest[]
  monteCarloData: MonteCarloDistribution[]
  concentrationMetrics: ConcentrationMetric[]
  correlationMatrix: CorrelationEntry[]
  correlationAssets: string[]
  hasStagedTrades: boolean
  activeTab: AnalysisTab
  onTabChange: (tab: AnalysisTab) => void
}

export const AnalysisPanel = ({
  backtestData,
  drawdownData,
  returnDistribution,
  performanceStats,
  factorExposures,
  factorHistoricalReturns,
  factorAttribution,
  riskMetrics,
  stressTests,
  monteCarloData,
  concentrationMetrics,
  correlationMatrix,
  correlationAssets,
  hasStagedTrades,
  activeTab,
  onTabChange,
}: AnalysisPanelProps) => {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0 bg-muted/30">
        {(["performance", "factors", "risk"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => {
              onTabChange(tab)
            }}
            className={twMerge(
              clsx(
                "px-3 py-1 text-[10px] font-medium rounded transition-colors capitalize",
                activeTab === tab
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              ),
            )}
          >
            {tab}
          </button>
        ))}
        <div className="flex-1" />
        <div className="text-[9px] text-muted-foreground">
          <kbd className="px-1 py-px bg-muted rounded font-mono">P</kbd>{" "}
          Performance{" "}
          <kbd className="px-1 py-px bg-muted rounded font-mono ml-1">F</kbd>{" "}
          Factors{" "}
          <kbd className="px-1 py-px bg-muted rounded font-mono ml-1">R</kbd>{" "}
          Risk
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "performance" && (
          <PerformanceTab
            backtestData={backtestData}
            drawdownData={drawdownData}
            returnDistribution={returnDistribution}
            performanceStats={performanceStats}
            hasStagedTrades={hasStagedTrades}
          />
        )}
        {activeTab === "factors" && (
          <FactorsTab
            factorExposures={factorExposures}
            factorHistoricalReturns={factorHistoricalReturns}
            factorAttribution={factorAttribution}
          />
        )}
        {activeTab === "risk" && (
          <RiskTab
            riskMetrics={riskMetrics}
            stressTests={stressTests}
            monteCarloData={monteCarloData}
            concentrationMetrics={concentrationMetrics}
            correlationMatrix={correlationMatrix}
            correlationAssets={correlationAssets}
          />
        )}
      </div>
    </div>
  )
}
