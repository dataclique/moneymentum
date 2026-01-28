import { useState, useEffect, useCallback } from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { X } from "lucide-react"

interface Instrument {
  symbol: string
  type: "perp" | "spot" | "call" | "put"
  rate: number
  rateLabel: string
}

interface AddPositionModalProps {
  isOpen: boolean
  underlying: string
  instruments: Instrument[]
  nav: number
  currentLeverage: number
  onClose: () => void
  onAddPosition: (params: {
    symbol: string
    direction: "long" | "short"
    weight: number
  }) => void
}

type Step = "instrument" | "configure"
type Direction = "long" | "short"
type SizeMode = "weight" | "notional"

export const AddPositionModal = ({
  isOpen,
  underlying,
  instruments,
  nav,
  currentLeverage,
  onClose,
  onAddPosition,
}: AddPositionModalProps) => {
  const [step, setStep] = useState<Step>("instrument")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedInstrument, setSelectedInstrument] =
    useState<Instrument | null>(null)
  const [direction, setDirection] = useState<Direction>("long")
  const [sizeMode, setSizeMode] = useState<SizeMode>("notional")
  const [sizeValue, setSizeValue] = useState("5000")

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep("instrument")
      setSelectedIndex(0)
      setSelectedInstrument(null)
      setDirection("long")
      setSizeMode("notional")
      setSizeValue("5000")
    }
  }, [isOpen])

  const handleSelectInstrument = useCallback(() => {
    if (instruments[selectedIndex]) {
      setSelectedInstrument(instruments[selectedIndex])
      setStep("configure")
    }
  }, [instruments, selectedIndex])

  const handleBack = useCallback(() => {
    setStep("instrument")
    setSelectedInstrument(null)
  }, [])

  const handleConfirm = useCallback(() => {
    if (!selectedInstrument) return

    const numericValue = parseFloat(sizeValue) || 0
    const weight =
      sizeMode === "weight"
        ? numericValue / 100
        : numericValue / (nav * currentLeverage)

    onAddPosition({
      symbol: selectedInstrument.symbol,
      direction,
      weight: Math.max(0, Math.min(1, weight)),
    })
    onClose()
  }, [
    selectedInstrument,
    sizeMode,
    sizeValue,
    nav,
    currentLeverage,
    direction,
    onAddPosition,
    onClose,
  ])

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        if (step === "configure") {
          handleBack()
        } else {
          onClose()
        }
        return
      }

      if (step === "instrument") {
        if (event.key === "j" || event.key === "ArrowDown") {
          event.preventDefault()
          setSelectedIndex(prev => Math.min(prev + 1, instruments.length - 1))
        } else if (event.key === "k" || event.key === "ArrowUp") {
          event.preventDefault()
          setSelectedIndex(prev => Math.max(prev - 1, 0))
        } else if (event.key === "Enter") {
          event.preventDefault()
          handleSelectInstrument()
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [
    isOpen,
    step,
    instruments.length,
    handleSelectInstrument,
    handleBack,
    handleConfirm,
    onClose,
  ])

  if (!isOpen) return null

  const computedWeight =
    sizeMode === "weight"
      ? (parseFloat(sizeValue) || 0) / 100
      : (parseFloat(sizeValue) || 0) / (nav * currentLeverage)

  const computedNotional =
    sizeMode === "notional"
      ? parseFloat(sizeValue) || 0
      : ((parseFloat(sizeValue) || 0) / 100) * nav * currentLeverage

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        onKeyDown={event => {
          if (event.key === "Escape") onClose()
        }}
        role="button"
        tabIndex={-1}
      />
      <div className="relative bg-background border border-border rounded-lg shadow-xl w-[400px] max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <span className="font-medium">
            {step === "instrument"
              ? `Add ${underlying} Position`
              : `Configure: ${selectedInstrument?.symbol}`}
          </span>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4">
          {step === "instrument" ? (
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground mb-3">
                Select instrument:
              </div>
              {instruments.map((inst, index) => (
                <div
                  key={inst.symbol}
                  onClick={() => {
                    setSelectedIndex(index)
                    handleSelectInstrument()
                  }}
                  onKeyDown={event => {
                    if (event.key === "Enter") {
                      setSelectedIndex(index)
                      handleSelectInstrument()
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className={twMerge(
                    clsx(
                      "p-3 rounded border cursor-pointer transition-colors",
                      selectedIndex === index
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-muted-foreground",
                    ),
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div
                        className={twMerge(
                          clsx(
                            "w-2 h-2 rounded-full",
                            selectedIndex === index
                              ? "bg-primary"
                              : "bg-muted-foreground/30",
                          ),
                        )}
                      />
                      <span className="font-medium">{inst.symbol}</span>
                      <span className="text-xs text-muted-foreground uppercase">
                        ({inst.type})
                      </span>
                    </div>
                    <span
                      className={twMerge(
                        clsx(
                          "font-mono text-sm",
                          inst.rate > 0
                            ? "text-green-500"
                            : inst.rate < 0
                              ? "text-red-500"
                              : "text-muted-foreground",
                        ),
                      )}
                    >
                      {inst.rate > 0 ? "+" : ""}
                      {(inst.rate * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 ml-4">
                    {inst.rateLabel}
                  </div>
                </div>
              ))}
              <div className="text-xs text-muted-foreground mt-4 pt-2 border-t border-border">
                <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">
                  j
                </kbd>
                /
                <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">
                  k
                </kbd>{" "}
                to navigate,{" "}
                <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">
                  Enter
                </kbd>{" "}
                to select
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Direction */}
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Direction
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setDirection("long")
                    }}
                    className={twMerge(
                      clsx(
                        "flex-1 py-2 rounded font-medium transition-colors",
                        direction === "long"
                          ? "bg-green-500/20 text-green-500 border border-green-500"
                          : "bg-muted text-muted-foreground border border-border hover:border-muted-foreground",
                      ),
                    )}
                  >
                    LONG
                  </button>
                  <button
                    onClick={() => {
                      setDirection("short")
                    }}
                    className={twMerge(
                      clsx(
                        "flex-1 py-2 rounded font-medium transition-colors",
                        direction === "short"
                          ? "bg-red-500/20 text-red-500 border border-red-500"
                          : "bg-muted text-muted-foreground border border-border hover:border-muted-foreground",
                      ),
                    )}
                  >
                    SHORT
                  </button>
                </div>
              </div>

              {/* Size */}
              <div>
                <div className="text-sm text-muted-foreground mb-2">Size</div>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => {
                      setSizeMode("weight")
                    }}
                    className={twMerge(
                      clsx(
                        "px-3 py-1 rounded text-sm transition-colors",
                        sizeMode === "weight"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      ),
                    )}
                  >
                    Weight %
                  </button>
                  <button
                    onClick={() => {
                      setSizeMode("notional")
                    }}
                    className={twMerge(
                      clsx(
                        "px-3 py-1 rounded text-sm transition-colors",
                        sizeMode === "notional"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      ),
                    )}
                  >
                    Notional $
                  </button>
                </div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    {sizeMode === "weight" ? "%" : "$"}
                  </span>
                  <input
                    type="text"
                    value={sizeValue}
                    onChange={event => {
                      setSizeValue(event.target.value)
                    }}
                    className="w-full pl-8 pr-3 py-2 bg-muted border border-border rounded focus:outline-none focus:border-primary font-mono"
                    placeholder={sizeMode === "weight" ? "2.0" : "5000"}
                  />
                </div>
              </div>

              {/* Preview */}
              <div className="p-3 bg-muted/50 rounded border border-border">
                <div className="text-sm text-muted-foreground mb-2">
                  Preview
                </div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Portfolio weight
                    </span>
                    <span className="font-mono">
                      0% → {(computedWeight * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Notional</span>
                    <span className="font-mono">
                      ${computedNotional.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Rate ({selectedInstrument?.rateLabel})
                    </span>
                    <span
                      className={twMerge(
                        clsx(
                          "font-mono",
                          (selectedInstrument?.rate ?? 0) > 0
                            ? "text-green-500"
                            : (selectedInstrument?.rate ?? 0) < 0
                              ? "text-red-500"
                              : "",
                        ),
                      )}
                    >
                      {(selectedInstrument?.rate ?? 0) > 0 ? "+" : ""}
                      {((selectedInstrument?.rate ?? 0) * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleBack}
                  className="flex-1 py-2 bg-muted text-muted-foreground rounded hover:text-foreground transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleConfirm}
                  className="flex-1 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors font-medium"
                >
                  Add Position
                </button>
              </div>

              <div className="text-xs text-muted-foreground pt-2 border-t border-border">
                <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">
                  Tab
                </kbd>{" "}
                to switch fields,{" "}
                <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">
                  Enter
                </kbd>{" "}
                to confirm,{" "}
                <kbd className="px-1 py-0.5 bg-muted rounded text-[10px]">
                  Esc
                </kbd>{" "}
                to go back
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
