import { useState, useEffect, useCallback } from "react"
import { X } from "lucide-react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
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
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focusMode, setFocusMode] = useState<"factors" | "benchmarks">(
    "factors",
  )

  const handleRemove = useCallback((index: number) => {
    setEditedFactors(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleAdd = useCallback((benchmark: string) => {
    setEditedFactors(prev => {
      const newFactor: FactorExposure = {
        name: `β to ${benchmark}`,
        value: 0,
        color: `hsl(var(--chart-${(prev.length % 5) + 1}))`,
      }
      return [...prev, newFactor]
    })
  }, [])

  const handleSave = useCallback(() => {
    onSave(editedFactors)
    onClose()
  }, [editedFactors, onSave, onClose])

  const existingBenchmarks = editedFactors
    .filter(f => f.name.startsWith("β to "))
    .map(f => f.name.replace("β to ", ""))

  const availableBenchmarks = DEFAULT_BENCHMARKS.filter(
    b => !existingBenchmarks.includes(b),
  )

  const toggleBenchmark = useCallback((benchmark: string) => {
    setEditedFactors(prev => {
      const existing = prev.find(f => f.name === `β to ${benchmark}`)
      if (existing) {
        // Remove it
        return prev.filter(f => f.name !== `β to ${benchmark}`)
      } else {
        // Add it
        const newFactor: FactorExposure = {
          name: `β to ${benchmark}`,
          value: 0,
          color: `hsl(var(--chart-${(prev.length % 5) + 1}))`,
        }
        return [...prev, newFactor]
      }
    })
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()

      if (key === "escape" || key === "f") {
        event.preventDefault()
        handleSave() // Auto-save on close
        return
      }

      if (key === "enter") {
        event.preventDefault()
        if (focusMode === "factors" && editedFactors.length > 0) {
          handleSave()
        } else if (
          focusMode === "benchmarks" &&
          availableBenchmarks.length > 0
        ) {
          handleAdd(availableBenchmarks[selectedIndex])
          setFocusMode("factors")
          setSelectedIndex(editedFactors.length)
        }
        return
      }

      // Number keys 1-6 to quickly toggle benchmarks
      const numKey = parseInt(event.key)
      if (numKey >= 1 && numKey <= DEFAULT_BENCHMARKS.length) {
        event.preventDefault()
        toggleBenchmark(DEFAULT_BENCHMARKS[numKey - 1])
        return
      }

      if (key === "j" || key === "arrowdown") {
        event.preventDefault()
        const maxIndex =
          focusMode === "factors"
            ? editedFactors.length - 1
            : availableBenchmarks.length - 1
        setSelectedIndex(prev => Math.min(prev + 1, maxIndex))
        return
      }

      if (key === "k" || key === "arrowup") {
        event.preventDefault()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
        return
      }

      if (key === "d" || key === "backspace") {
        event.preventDefault()
        if (focusMode === "factors" && editedFactors.length > 0) {
          handleRemove(selectedIndex)
          if (selectedIndex >= editedFactors.length - 1) {
            setSelectedIndex(Math.max(0, editedFactors.length - 2))
          }
        }
        return
      }

      if (key === "tab") {
        event.preventDefault()
        if (focusMode === "factors" && availableBenchmarks.length > 0) {
          setFocusMode("benchmarks")
          setSelectedIndex(0)
        } else if (focusMode === "benchmarks") {
          setFocusMode("factors")
          setSelectedIndex(0)
        }
        return
      }
    },
    [
      editedFactors,
      availableBenchmarks,
      selectedIndex,
      focusMode,
      handleRemove,
      handleAdd,
      handleSave,
      toggleBenchmark,
    ],
  )

  // useEffect justified: panel-specific keyboard shortcuts need to capture events
  // when the panel is open. Cannot use component-level onKeyDown as panel is not focusable.
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [handleKeyDown])

  // Reset selection when factors change
  useEffect(() => {
    if (selectedIndex >= editedFactors.length && editedFactors.length > 0) {
      setSelectedIndex(editedFactors.length - 1)
    }
  }, [editedFactors.length, selectedIndex])

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
            className={twMerge(
              clsx(
                "flex items-center justify-between px-2 py-1 rounded",
                focusMode === "factors" && selectedIndex === index
                  ? "bg-primary/20 ring-1 ring-primary/50"
                  : "bg-muted/30",
              ),
            )}
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

        <div className="text-[10px] text-muted-foreground font-medium mt-3 mb-1">
          Quick Toggle Benchmarks
        </div>
        <div className="flex flex-wrap gap-1">
          {DEFAULT_BENCHMARKS.map((benchmark, index) => {
            const isActive = existingBenchmarks.includes(benchmark)
            return (
              <button
                key={benchmark}
                onClick={() => {
                  toggleBenchmark(benchmark)
                }}
                className={twMerge(
                  clsx(
                    "flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border transition-colors",
                    isActive
                      ? "bg-primary/20 border-primary/50 text-primary"
                      : "bg-muted/50 border-transparent hover:bg-muted",
                  ),
                )}
              >
                <span className="text-[8px] opacity-60">{index + 1}</span>
                {benchmark}
                {isActive && <span className="text-[8px]">✓</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
        <span className="text-[9px] text-muted-foreground">
          <kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">1-6</kbd>{" "}
          toggle
          {" · "}
          <kbd className="px-1 py-0.5 bg-muted rounded text-[8px]">f</kbd> close
        </span>
        <button
          onClick={handleSave}
          className="px-3 py-1 text-[10px] bg-primary text-primary-foreground hover:bg-primary/90 rounded"
        >
          Done
        </button>
      </div>
    </div>
  )
}
