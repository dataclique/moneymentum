import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatUsd, formatPct } from "../../Prototype/utils/formatters"

type Side = "buy" | "sell"

interface MockStagedTrade {
  id: string
  underlying: string
  side: Side
  notional: number
  previousWeight?: number
  newWeight?: number
  source: "weight_edit" | "leverage_change" | "manual"
}

const SOURCE_BADGE_CONFIG = {
  weight_edit: { label: "weight", className: "bg-blue-500/20 text-blue-400" },
  leverage_change: {
    label: "leverage",
    className: "bg-purple-500/20 text-purple-400",
  },
  manual: { label: "manual", className: "bg-gray-500/20 text-gray-400" },
} as const

const MOCK_TRADES: MockStagedTrade[] = [
  {
    id: "1",
    underlying: "BTC/USDC",
    side: "buy",
    notional: 2500,
    previousWeight: 0.25,
    newWeight: 0.3,
    source: "weight_edit",
  },
  {
    id: "2",
    underlying: "ETH/USDC",
    side: "sell",
    notional: 1500,
    previousWeight: 0.2,
    newWeight: 0.15,
    source: "leverage_change",
  },
  {
    id: "3",
    underlying: "SOL/USDC",
    side: "buy",
    notional: 800,
    source: "manual",
  },
]

export const StagedChangesPanel = () => {
  const stagedTrades = MOCK_TRADES
  const hasStaged = stagedTrades.length > 0

  return (
    <div className="flex-1 border border-border rounded flex flex-col min-w-0">
      <div className="px-2 py-1.5 bg-muted/30 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <span className="font-medium">STAGED CHANGES</span>
          <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
            4
          </kbd>
        </div>
        {hasStaged && (
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive text-[10px]"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Header / leverage summary */}
      <div className="px-2 py-1.5 border-b border-border flex items-center justify-between text-[10px]">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Leverage</span>
          <span className="font-mono">TODO 1.25x → 1.40x</span>
        </div>
        <Button size="sm" className="h-6 px-2 text-[10px] gap-1">
          <Send className="h-3 w-3" />
          Rebalance
        </Button>
      </div>

      {!hasStaged ? (
        <div className="px-2 py-3 text-muted-foreground text-center text-[10px]">
          No pending trades. Edit weights or adjust leverage to stage trades.
        </div>
      ) : (
        <div className="max-h-[180px] overflow-auto scrollbar-hide">
          {stagedTrades.map(stagedTrade => {
            const sourceConfig = SOURCE_BADGE_CONFIG[stagedTrade.source]
            return (
              <div
                key={stagedTrade.id}
                className="flex items-center px-2 py-1.5 border-b border-border/30"
              >
                <span
                  className={twMerge(
                    clsx(
                      "text-[10px] font-medium px-1.5 py-0.5 rounded",
                      stagedTrade.side === "buy"
                        ? "bg-green-500/20 text-green-500"
                        : "bg-red-500/20 text-red-500",
                    ),
                  )}
                >
                  {stagedTrade.side === "buy" ? "BUY" : "SELL"}
                </span>
                <span className="flex-1 px-2 truncate font-medium text-[11px]">
                  {stagedTrade.underlying}
                </span>
                {stagedTrade.previousWeight !== undefined &&
                  stagedTrade.newWeight !== undefined && (
                    <span className="text-[9px] text-muted-foreground font-mono mr-2">
                      {formatPct(stagedTrade.previousWeight)} →{" "}
                      {formatPct(stagedTrade.newWeight)}
                    </span>
                  )}
                <span className="text-muted-foreground font-mono text-[10px]">
                  {formatUsd(stagedTrade.notional)}
                </span>
                <span
                  className={twMerge(
                    "text-[9px] font-medium ml-2 px-1.5 py-0.5 rounded",
                    sourceConfig.className,
                  )}
                >
                  {sourceConfig.label}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Simple impact preview */}
      <div className="px-2 py-1.5 border-t border-border/30 bg-muted/20">
        <div className="text-[10px] text-muted-foreground font-medium mb-1">
          IMPACT PREVIEW
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Notional</span>
            <span className="font-mono">
              TODO $50,000 → <span className="text-green-500">$52,300</span>
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Leverage</span>
            <span className="font-mono">
              TODO 1.25x → <span className="text-yellow-500">1.40x</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
