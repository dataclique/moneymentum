import { ArrowDown, ArrowUp, ArrowUpDown, RotateCcw } from "lucide-react"
import { twMerge } from "tailwind-merge"
import type React from "react"

export type SortColumn = "market" | "weight" | "notional" | "side"
export type SortDirection = "asc" | "desc"
export type SortState = { column: SortColumn; direction: SortDirection } | null

interface SortableHeaderButtonProps {
  label: string
  column: SortColumn
  sortState: SortState
  onHeaderClick: (column: SortColumn) => void
  className?: string
  needsResort?: boolean
  onResort?: (column: SortColumn) => void
}

export const SortableHeaderButton = ({
  label,
  column,
  sortState,
  onHeaderClick,
  className,
  needsResort,
  onResort,
}: SortableHeaderButtonProps) => {
  const isActive = sortState?.column === column

  const handleClick = () => {
    onHeaderClick(column)
  }

  const handleResortClick: React.MouseEventHandler<
    HTMLButtonElement
  > = event => {
    event.stopPropagation()
    if (onResort) {
      onResort(column)
    }
  }

  return (
    <div
      className={twMerge(
        "group flex items-center gap-1 text-xs font-semibold text-muted-foreground",
        className,
      )}
    >
      <button
        type="button"
        onClick={handleClick}
        className="flex items-center gap-1 hover:text-foreground cursor-pointer select-none"
      >
        <span>{label}</span>
        {isActive && !needsResort ? (
          sortState?.direction === "desc" ? (
            <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )
        ) : (
          !isActive && (
            <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-100" />
          )
        )}
      </button>
      {isActive && needsResort && (
        <button
          type="button"
          onClick={handleResortClick}
          className="flex items-center hover:text-foreground cursor-pointer select-none"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
