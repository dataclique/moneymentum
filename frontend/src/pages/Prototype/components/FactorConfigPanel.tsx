import { useState } from "react"
import { X, Plus } from "lucide-react"
import type { FactorExposure } from "../mockData"

interface FactorConfigPanelProps {
  factors: FactorExposure[]
  onClose: () => void
  onSave: (factors: FactorExposure[]) => void
}

const DEFAULT_BENCHMARKS = ["BTC", "ETH", "SPY", "QQQ", "DXY", "Gold"]

export const FactorConfigPanel = ({
  factors,
  onClose,
  onSave,
}: FactorConfigPanelProps) => {
  const [editedFactors, setEditedFactors] = useState<FactorExposure[]>(factors)

  const handleRemove = (index: number) => {
    setEditedFactors(prev => prev.filter((_, i) => i !== index))
  }

  const handleAdd = (benchmark: string) => {
    const newFactor: FactorExposure = {
      name: `β to ${benchmark}`,
      value: 0,
      color: `hsl(var(--chart-${(editedFactors.length % 5) + 1}))`,
    }
    setEditedFactors(prev => [...prev, newFactor])
  }

  const handleSave = () => {
    onSave(editedFactors)
    onClose()
  }

  const existingBenchmarks = editedFactors
    .filter(f => f.name.startsWith("β to "))
    .map(f => f.name.replace("β to ", ""))

  const availableBenchmarks = DEFAULT_BENCHMARKS.filter(
    b => !existingBenchmarks.includes(b),
  )

  return (
    <div className="absolute inset-0 bg-background/95 z-10 flex flex-col p-2">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium">Configure Factors</span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto space-y-1.5">
        <div className="text-[10px] text-muted-foreground font-medium mb-1">
          Active Factors
        </div>
        {editedFactors.map((factor, index) => (
          <div
            key={factor.name}
            className="flex items-center justify-between px-2 py-1 bg-muted/30 rounded"
          >
            <span className="text-[11px]">{factor.name}</span>
            <button
              onClick={() => {
                handleRemove(index)
              }}
              className="text-muted-foreground hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}

        {availableBenchmarks.length > 0 && (
          <>
            <div className="text-[10px] text-muted-foreground font-medium mt-3 mb-1">
              Add Beta Exposure
            </div>
            <div className="flex flex-wrap gap-1">
              {availableBenchmarks.map(benchmark => (
                <button
                  key={benchmark}
                  onClick={() => {
                    handleAdd(benchmark)
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-muted/50 hover:bg-muted rounded"
                >
                  <Plus className="h-2.5 w-2.5" />
                  {benchmark}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex gap-2 mt-2 pt-2 border-t border-border/50">
        <button
          onClick={onClose}
          className="flex-1 px-2 py-1 text-[10px] bg-muted/50 hover:bg-muted rounded"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="flex-1 px-2 py-1 text-[10px] bg-primary text-primary-foreground hover:bg-primary/90 rounded"
        >
          Save
        </button>
      </div>
    </div>
  )
}
