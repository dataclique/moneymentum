import { useState, useRef, useEffect } from "react"
import { ChevronDown, Check } from "lucide-react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { METRIC_OPTIONS, WINDOW_OPTIONS } from "../metrics/registry"

interface MetricSelectorProps {
  selectedMetricIds: string[]
  selectedWindowId: string
  onMetricToggle: (metricId: string) => void
  onWindowChange: (windowId: string) => void
}

export const MetricSelector = ({
  selectedMetricIds,
  selectedWindowId,
  onMetricToggle,
  onWindowChange,
}: MetricSelectorProps) => {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  return (
    <div className="flex items-center gap-2">
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => {
            setIsOpen(!isOpen)
          }}
          className="flex items-center gap-1 bg-muted/50 border border-border rounded px-2 py-0.5 text-[10px] hover:bg-muted/70"
        >
          <span className="truncate max-w-[100px]">{displayText}</span>
          <ChevronDown
            className={twMerge(
              "h-3 w-3 transition-transform",
              isOpen && "rotate-180",
            )}
          />
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded shadow-lg z-50 min-w-[140px]">
            {METRIC_OPTIONS.map(metric => {
              const isSelected = selectedMetricIds.includes(metric.id)
              return (
                <button
                  key={metric.id}
                  onClick={() => {
                    onMetricToggle(metric.id)
                  }}
                  className={twMerge(
                    clsx(
                      "w-full flex items-center gap-2 px-2 py-1 text-[10px] text-left hover:bg-muted/50",
                      isSelected && "bg-muted/30",
                    ),
                  )}
                >
                  <div
                    className={twMerge(
                      "w-3 h-3 border rounded flex items-center justify-center",
                      isSelected
                        ? "bg-primary border-primary"
                        : "border-border",
                    )}
                  >
                    {isSelected && (
                      <Check className="h-2 w-2 text-primary-foreground" />
                    )}
                  </div>
                  {metric.name}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {needsWindow && (
        <div className="flex items-center gap-0.5">
          {WINDOW_OPTIONS.map(window => (
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
              {window.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
