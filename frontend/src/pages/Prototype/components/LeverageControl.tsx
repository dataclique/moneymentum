import { useState, useRef, useEffect } from "react"
import { getDirection } from "../utils/keys"

type EditState = "editing" | "viewing"

interface LeverageControlProps {
  leverage: number
  effectiveLeverage: number
  onLeverageChange: (value: number) => void
  isActive?: boolean
}

const MIN_LEVERAGE = 0.1
const MAX_LEVERAGE = 5
const SMALL_STEP = 0.1
const LARGE_STEP = 0.5

export const LeverageControl = ({
  leverage,
  effectiveLeverage,
  onLeverageChange,
  isActive,
}: LeverageControlProps) => {
  const [editState, setEditState] = useState<EditState>("viewing")
  const [editValue, setEditValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editState === "editing" && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editState])

  const startEdit = () => {
    setEditValue(leverage.toFixed(1))
    setEditState("editing")
  }

  const commitEdit = () => {
    const parsed = parseFloat(editValue)
    if (!isNaN(parsed)) {
      const clamped = Math.max(MIN_LEVERAGE, Math.min(MAX_LEVERAGE, parsed))
      const rounded = Math.round(clamped * 10) / 10
      onLeverageChange(rounded)
    }
    setEditState("viewing")
  }

  const cancelEdit = () => {
    setEditState("viewing")
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (isActive === false) return
    if (editState === "editing") return

    const step = event.shiftKey ? LARGE_STEP : SMALL_STEP
    const direction = getDirection(event.key)

    // h/l/arrows or [/] for leverage adjustment
    if (direction === "right" || event.key === "]") {
      event.preventDefault()
      event.stopPropagation()
      const newValue = Math.min(
        MAX_LEVERAGE,
        Math.round((leverage + step) * 10) / 10,
      )
      onLeverageChange(newValue)
      return
    }

    if (direction === "left" || event.key === "[") {
      event.preventDefault()
      event.stopPropagation()
      const newValue = Math.max(
        MIN_LEVERAGE,
        Math.round((leverage - step) * 10) / 10,
      )
      onLeverageChange(newValue)
      return
    }

    if (event.key === "Enter" || event.key === "e") {
      event.preventDefault()
      startEdit()
      return
    }
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      commitEdit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      cancelEdit()
    }
  }

  return (
    <div
      data-testid="leverage-control"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex items-center gap-2 px-2 py-1.5 border-b border-border/30 focus:outline-none focus:ring-1 focus:ring-primary/50"
    >
      <span className="text-muted-foreground">Leverage</span>
      <input
        type="range"
        min="0.1"
        max="5"
        step="0.1"
        value={leverage}
        onChange={e => {
          onLeverageChange(parseFloat(e.target.value))
        }}
        className="flex-1 h-1 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
        tabIndex={-1}
      />
      {editState === "editing" ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={e => {
            setEditValue(e.target.value)
          }}
          onKeyDown={handleInputKeyDown}
          onBlur={commitEdit}
          className="font-mono w-12 text-right bg-muted border border-primary rounded px-1 focus:outline-none"
          data-testid="leverage-input"
        />
      ) : (
        <span
          className="font-mono w-12 text-right cursor-pointer hover:text-primary"
          onClick={startEdit}
          data-testid="leverage-display"
        >
          {effectiveLeverage.toFixed(2)}x
        </span>
      )}
    </div>
  )
}
