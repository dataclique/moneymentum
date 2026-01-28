import { useCallback, useEffect, useState } from "react"
import { ChevronDown, Check } from "lucide-react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { METRIC_OPTIONS, WINDOW_OPTIONS } from "../metrics/registry"

interface MetricSelectorProps {
  selectedMetricIds: string[]
  selectedWindowId: string
  onMetricToggle: (metricId: string) => void
  onWindowChange: (windowId: string) => void
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
  isFocused?: boolean
}

export const MetricSelector = ({
  selectedMetricIds,
  selectedWindowId,
  onMetricToggle,
  onWindowChange,
  isOpen,
  onOpenChange,
  isFocused = false,
}: MetricSelectorProps) => {
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  // Reset highlighted index when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setHighlightedIndex(0)
    }
  }, [isOpen])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isFocused) return

      // When dropdown is open, handle navigation within it
      if (isOpen) {
        if (event.key === "ArrowDown" || event.key === "j") {
          event.preventDefault()
          setHighlightedIndex(prev =>
            prev < METRIC_OPTIONS.length - 1 ? prev + 1 : prev,
          )
          return
        }
        if (event.key === "ArrowUp" || event.key === "k") {
          event.preventDefault()
          setHighlightedIndex(prev => (prev > 0 ? prev - 1 : prev))
          return
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          const metric = METRIC_OPTIONS[highlightedIndex]
          onMetricToggle(metric.id)
          return
        }
        if (event.key === "Escape") {
          event.preventDefault()
          onOpenChange?.(false)
          return
        }
      }

      // m key toggles metric selector
      if (event.key === "m") {
        event.preventDefault()
        onOpenChange?.(!isOpen)
        return
      }

      // When dropdown is closed, arrow keys for window selection
      if (!isOpen) {
        const currentIndex = WINDOW_OPTIONS.findIndex(
          w => w.id === selectedWindowId,
        )
        if (event.key === "ArrowLeft" || event.key === "h") {
          if (currentIndex > 0) {
            onWindowChange(WINDOW_OPTIONS[currentIndex - 1].id)
          }
          return
        }
        if (event.key === "ArrowRight" || event.key === "l") {
          if (currentIndex < WINDOW_OPTIONS.length - 1) {
            onWindowChange(WINDOW_OPTIONS[currentIndex + 1].id)
          }
          return
        }

        // Number keys 1-5 for direct window selection
        if (event.key >= "1" && event.key <= String(WINDOW_OPTIONS.length)) {
          const index = parseInt(event.key) - 1
          if (index < WINDOW_OPTIONS.length) {
            onWindowChange(WINDOW_OPTIONS[index].id)
          }
          return
        }
      }
    },
    [
      isFocused,
      isOpen,
      onOpenChange,
      selectedWindowId,
      onWindowChange,
      highlightedIndex,
      onMetricToggle,
    ],
  )

  // useEffect justified: Global keyboard listener needed for keyboard navigation
  // when this component is focused. Cannot use onKeyDown since focus may be elsewhere.
  useEffect(() => {
    if (!isFocused) return
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isFocused, handleKeyDown])
  const needsWindow = selectedMetricIds.some(id =>
    ["sharpe", "sortino", "volatility"].includes(id),
  )

  const selectedNames = selectedMetricIds
    .map(id => METRIC_OPTIONS.find(m => m.id === id)?.name)
    .filter(Boolean)

  const displayText =
    selectedNames.length === 0
      ? "Select metrics"
      : selectedNames.length === 1
        ? selectedNames[0]
        : `${selectedNames.length} metrics`

  return (
    <div
      className={twMerge(
        clsx(
          "flex items-center gap-2 relative",
          isFocused && "ring-1 ring-primary/50 rounded px-1 -mx-1",
        ),
      )}
      data-testid="metric-selector"
    >
      <div className="relative">
        <button
          className="flex items-center gap-1 bg-muted/50 border border-border rounded px-2 py-0.5 text-[10px] hover:bg-muted/70"
          onClick={() => onOpenChange?.(!isOpen)}
        >
          {isFocused && <span className="text-[8px] opacity-60">m</span>}
          <span className="truncate max-w-[100px]">{displayText}</span>
          <ChevronDown
            className={twMerge(
              clsx("h-3 w-3 transition-transform", isOpen && "rotate-180"),
            )}
          />
        </button>
        {isOpen && (
          <div className="absolute top-full left-0 mt-1 z-50 bg-popover border border-border rounded-md shadow-md min-w-[140px] py-1">
            {METRIC_OPTIONS.map((metric, index) => {
              const isSelected = selectedMetricIds.includes(metric.id)
              const isHighlighted = highlightedIndex === index
              return (
                <button
                  key={metric.id}
                  onClick={() => {
                    onMetricToggle(metric.id)
                  }}
                  className={twMerge(
                    clsx(
                      "w-full flex items-center gap-2 px-2 py-1 text-[10px] text-left hover:bg-muted/50",
                      isHighlighted && "bg-muted/70",
                    ),
                  )}
                >
                  <span
                    className={twMerge(
                      clsx(
                        "w-3.5 h-3.5 rounded-sm border border-border flex items-center justify-center",
                        isSelected && "bg-primary border-primary",
                      ),
                    )}
                  >
                    {isSelected && (
                      <Check className="h-2.5 w-2.5 text-primary-foreground" />
                    )}
                  </span>
                  {metric.name}
                </button>
              )
            })}
            {isFocused && (
              <div className="border-t border-border mt-1 pt-1 px-2 text-[8px] text-muted-foreground">
                <kbd className="px-0.5 bg-muted rounded">j</kbd>/
                <kbd className="px-0.5 bg-muted rounded">k</kbd> navigate,{" "}
                <kbd className="px-0.5 bg-muted rounded">Enter</kbd> toggle
              </div>
            )}
          </div>
        )}
      </div>

      {needsWindow && (
        <div className="flex items-center gap-0.5">
          {isFocused && (
            <span className="text-[8px] text-muted-foreground mr-0.5">←→</span>
          )}
          {WINDOW_OPTIONS.map((window, index) => (
            <button
              key={window.id}
              onClick={() => {
                onWindowChange(window.id)
              }}
              className={twMerge(
                clsx(
                  "px-1 py-0.5 text-[9px] rounded transition-colors",
                  selectedWindowId === window.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                ),
              )}
            >
              {isFocused && (
                <span className="text-[8px] opacity-60 mr-0.5">
                  {index + 1}
                </span>
              )}
              {window.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
