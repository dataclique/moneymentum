import { useState, useRef, useEffect, useCallback } from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"

type CellFormat = "percent" | "currency" | "number"
type EditState = "editing" | "viewing"

interface EditableCellProps {
  value: number
  format: CellFormat
  onCommit: (newValue: number) => void
  isSelected?: boolean
  editKey?: string
  directEdit?: boolean // When true, typing numbers directly starts editing
  className?: string
}

const formatValue = (value: number, format: CellFormat): string => {
  switch (format) {
    case "percent":
      return `${(value * 100).toFixed(1)}%`
    case "currency":
      return value >= 1000
        ? `$${(value / 1000).toFixed(1)}k`
        : `$${value.toFixed(0)}`
    case "number":
      return value.toFixed(2)
  }
}

const parseInput = (input: string, format: CellFormat): number | null => {
  const cleaned = input.replace(/[$,%k]/gi, "").trim()
  const num = parseFloat(cleaned)
  if (isNaN(num)) return null

  switch (format) {
    case "percent":
      return num / 100
    case "currency":
      return input.toLowerCase().includes("k") ? num * 1000 : num
    case "number":
      return num
  }
}

export const EditableCell = ({
  value,
  format,
  onCommit,
  isSelected = false,
  editKey,
  directEdit = false,
  className,
}: EditableCellProps) => {
  const [editState, setEditState] = useState<EditState>("viewing")
  const [inputValue, setInputValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = useCallback(
    (initialValue?: string) => {
      if (initialValue !== undefined) {
        setInputValue(initialValue)
      } else {
        setInputValue(
          format === "percent"
            ? (value * 100).toFixed(1)
            : format === "currency"
              ? value.toFixed(0)
              : value.toFixed(2),
        )
      }
      setEditState("editing")
    },
    [value, format],
  )

  const commitEdit = useCallback(() => {
    const parsed = parseInput(inputValue, format)
    if (parsed !== null && parsed !== value) {
      onCommit(parsed)
    }
    setEditState("viewing")
  }, [inputValue, format, value, onCommit])

  const cancelEdit = useCallback(() => {
    setEditState("viewing")
  }, [])

  // useEffect justified: Focus management requires DOM manipulation.
  // React does not provide declarative focus control.
  useEffect(() => {
    if (editState === "editing" && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editState])

  // useEffect justified: Global keyboard shortcut to start editing when cell is selected.
  // Must listen at document level to capture keys regardless of current focus.
  useEffect(() => {
    if (!isSelected || editState === "editing") return
    if (!editKey && !directEdit) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      // editKey triggers editing with current value
      if (editKey && event.key.toLowerCase() === editKey.toLowerCase()) {
        event.preventDefault()
        startEditing()
        return
      }

      // directEdit: typing a number starts editing with that number
      // Exclude 1, 2, 3, 4 which are used for panel focus shortcuts
      if (
        directEdit &&
        /^[0-9.]$/.test(event.key) &&
        !["1", "2", "3", "4"].includes(event.key)
      ) {
        event.preventDefault()
        startEditing(event.key)
        return
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [isSelected, editKey, directEdit, editState, startEditing])

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault()
      commitEdit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      cancelEdit()
    }
  }

  if (editState === "editing") {
    return (
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={event => {
          setInputValue(event.target.value)
        }}
        onKeyDown={handleKeyDown}
        onBlur={commitEdit}
        className={twMerge(
          clsx(
            "w-full bg-muted border border-primary rounded px-1 py-0.5 text-right font-mono",
            "focus:outline-none focus:ring-1 focus:ring-primary",
          ),
          className,
        )}
      />
    )
  }

  return (
    <span
      onClick={event => {
        event.stopPropagation()
        startEditing()
      }}
      className={twMerge(
        clsx(
          "cursor-pointer hover:bg-muted/50 px-1 py-0.5 rounded inline-flex items-center gap-1",
          "border-b border-dashed border-muted-foreground/40 hover:border-primary/60",
          isSelected && "bg-primary/20 border-primary/60",
        ),
        className,
      )}
    >
      {formatValue(value, format)}
      {isSelected && editKey && (
        <kbd className="text-[8px] px-1 py-0.5 bg-muted/60 rounded font-mono text-muted-foreground">
          {editKey}
        </kbd>
      )}
    </span>
  )
}
