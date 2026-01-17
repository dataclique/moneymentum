import * as React from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { Maximize2, Minimize2 } from "lucide-react"
import type { PanelId } from "../hooks/useKeyboardNavigation"

interface PanelProps {
  id: PanelId
  title: string
  shortcut?: string
  isFocused: boolean
  isExpanded: boolean
  onFocus: () => void
  onToggleExpand: () => void
  children: React.ReactNode
  className?: string
}

export const Panel = ({
  title,
  shortcut,
  isFocused,
  isExpanded,
  onFocus,
  onToggleExpand,
  children,
  className,
}: PanelProps) => {
  return (
    <div
      className={twMerge(
        clsx(
          "border rounded overflow-hidden flex flex-col min-h-0 transition-all duration-150",
          isFocused ? "border-primary ring-1 ring-primary/50" : "border-border",
          isExpanded && "fixed inset-2 z-50 bg-background",
          className,
        ),
      )}
      onClick={onFocus}
    >
      <div
        className={twMerge(
          clsx(
            "px-2 py-1 text-xs font-medium border-b flex items-center justify-between gap-2",
            isFocused
              ? "bg-primary/10 text-primary border-primary/30"
              : "bg-muted/50 text-muted-foreground border-border",
          ),
        )}
      >
        <div className="flex items-center gap-2">
          {shortcut && (
            <kbd
              className={twMerge(
                clsx(
                  "px-1 py-0.5 text-[9px] font-mono rounded",
                  isFocused
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground",
                ),
              )}
            >
              {shortcut}
            </kbd>
          )}
          <span>{title}</span>
        </div>
        <div className="flex items-center gap-1">
          {isFocused && (
            <span className="text-[9px] text-muted-foreground mr-1">
              [f] expand
            </span>
          )}
          <button
            className="hover:text-foreground p-0.5"
            onClick={e => {
              e.stopPropagation()
              onToggleExpand()
            }}
          >
            {isExpanded ? (
              <Minimize2 className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto min-h-0">{children}</div>
    </div>
  )
}
