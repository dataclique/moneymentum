import { useState } from "react"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { MetricSelector } from "../../Prototype/components/MetricSelector"

export const PerformancePanel = () => {
  const [selectedMetricIds, setSelectedMetricIds] = useState<string[]>([])
  const [selectedWindowId, setSelectedWindowId] = useState<string>("1m")
  const [isMetricSelectorOpen, setIsMetricSelectorOpen] = useState(false)

  return (
    <div
      className="border border-border rounded flex flex-col"
      style={{ height: "45%" }}
    >
      <div className="px-2 py-1 border-b border-border bg-muted/30 font-medium flex justify-between items-center">
        <span>PERFORMANCE</span>
        <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
          3
        </kbd>
      </div>
      <div className="flex-1 flex min-h-0">
        {/* Metrics column */}
        <div className="w-[180px] shrink-0 border-r border-border/30 p-3 overflow-auto scrollbar-hide flex flex-col gap-2">
          <MetricSelector
            selectedMetricIds={selectedMetricIds}
            selectedWindowId={selectedWindowId}
            onMetricToggle={id => {
              setSelectedMetricIds(prev =>
                prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id],
              )
            }}
            onWindowChange={setSelectedWindowId}
            isOpen={isMetricSelectorOpen}
            onOpenChange={setIsMetricSelectorOpen}
            isFocused={false}
          />
          <div className="flex justify-between pb-2 border-b border-border/30">
            <span className="text-muted-foreground">Total Return</span>
            <span className="font-mono text-muted-foreground">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Sharpe</span>
            <span className="font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Sortino</span>
            <span className="font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Calmar</span>
            <span className="font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Max Drawdown</span>
            <span className="text-red-400 font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Win Rate</span>
            <span className="font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Profit Factor</span>
            <span className="font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Volatility</span>
            <span className="font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Beta</span>
            <span className="font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">VaR 95%</span>
            <span className="text-red-400 font-mono">TODO</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">VaR 99%</span>
            <span className="text-red-400 font-mono">TODO</span>
          </div>
        </div>
        {/* Chart placeholder */}
        <div className="flex-1 min-w-0 p-2">
          <div className="w-full h-full border border-dashed border-border/50 rounded flex items-center justify-center text-[10px] text-muted-foreground">
            TODO: performance chart
          </div>
        </div>
      </div>
    </div>
  )
}
