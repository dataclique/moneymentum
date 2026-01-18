import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { Plus, Minus, X, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LeverageControl } from "./LeverageControl"
import { formatUsd } from "../utils/formatters"
import type { StagedTrade } from "../mockData"

interface StagedTradesPanelProps {
  stagedTrades: StagedTrade[]
  leverage: number
  effectiveLeverage: number
  onLeverageChange: (value: number) => void
  onRemoveTrade: (id: string) => void
  onClearAll: () => void
  onExecute: () => void
}

export const StagedTradesPanel = ({
  stagedTrades,
  leverage,
  effectiveLeverage,
  onLeverageChange,
  onRemoveTrade,
  onClearAll,
  onExecute,
}: StagedTradesPanelProps) => {
  const hasStaged = stagedTrades.length > 0

  return (
    <div className="border-t border-border shrink-0">
      <div className="px-2 py-1.5 bg-muted/30 flex items-center justify-between">
        <span className="font-medium">STAGED CHANGES</span>
        {hasStaged && (
          <button
            className="text-muted-foreground hover:text-destructive"
            onClick={e => {
              e.stopPropagation()
              onClearAll()
            }}
          >
            Clear all
          </button>
        )}
      </div>

      <LeverageControl
        leverage={leverage}
        effectiveLeverage={effectiveLeverage}
        onLeverageChange={onLeverageChange}
      />

      {!hasStaged ? (
        <div className="px-2 py-3 text-muted-foreground text-center">
          No pending trades. Click{" "}
          <Plus className="h-3 w-3 inline text-green-500" /> or{" "}
          <Minus className="h-3 w-3 inline text-red-500" /> to stage.
        </div>
      ) : (
        <div className="max-h-[140px] overflow-auto scrollbar-hide">
          {stagedTrades.map(t => (
            <div
              key={t.id}
              className="flex items-center px-2 py-1.5 border-b border-border/30"
            >
              <span
                className={twMerge(
                  clsx(
                    "text-[10px] font-medium px-1.5 py-0.5 rounded",
                    t.side === "buy"
                      ? "bg-green-500/20 text-green-500"
                      : "bg-red-500/20 text-red-500",
                  ),
                )}
              >
                {t.side === "buy" ? "BUY" : "SELL"}
              </span>
              <span className="flex-1 px-2 truncate font-medium">
                {t.symbol}
              </span>
              <span className="text-muted-foreground font-mono">
                {formatUsd(t.notional)}
              </span>
              <span className="text-[10px] text-muted-foreground font-mono ml-2 px-1.5 py-0.5 bg-muted rounded">
                {t.leverage}x
              </span>
              <button
                className="text-muted-foreground hover:text-destructive ml-2"
                onClick={e => {
                  e.stopPropagation()
                  onRemoveTrade(t.id)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="p-2">
            <Button size="sm" className="w-full h-7" onClick={onExecute}>
              <Send className="h-3 w-3 mr-1.5" />
              Execute {stagedTrades.length} trade
              {stagedTrades.length > 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
