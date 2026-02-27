import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatUsd, formatPct } from "../../Prototype/utils/formatters"
import type { AllocationStatus } from "../hooks/usePortfolioState"

type Side = "buy" | "sell"

export interface StagedTrade {
  id: string
  underlying: string
  side: Side
  notional: number
  previousWeight?: number
  newWeight?: number
  source: "weight_edit" | "leverage_change" | "manual"
  status: AllocationStatus
  message: string | null
}

const SOURCE_BADGE_CONFIG = {
  weight_edit: { label: "weight", className: "bg-blue-500/20 text-blue-400" },
  leverage_change: {
    label: "leverage",
    className: "bg-purple-500/20 text-purple-400",
  },
  manual: { label: "manual", className: "bg-gray-500/20 text-gray-400" },
} as const

interface StagedChangesPanelProps {
  stagedTrades?: StagedTrade[]
  initialTotalNotional?: number
  targetNotional?: number
  initialCrossAccountLeverage?: number | null
  crossAccountLeverage?: number
  onRebalance?: () => void
  isRebalancing?: boolean
  disableSubmit?: boolean
  onClearAll?: () => void
}

export const StagedChangesPanel = ({
  stagedTrades: stagedTradesProp,
  initialTotalNotional,
  targetNotional,
  initialCrossAccountLeverage,
  crossAccountLeverage,
  onRebalance,
  isRebalancing = false,
  disableSubmit = false,
  onClearAll,
}: StagedChangesPanelProps) => {
  const stagedTrades = stagedTradesProp ?? []
  const hasStaged = stagedTrades.length > 0

  return (
    <div className="flex-1 border border-border rounded flex flex-col min-w-0">
      <div className="px-2 py-1.5 bg-muted/30 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <span className="font-medium">STAGED CHANGES</span>
        </div>
        {hasStaged && (
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive text-[10px]"
            onClick={() => {
              if (!onClearAll) return
              onClearAll()
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {!hasStaged ? (
        <div className="px-2 py-3 text-muted-foreground text-center text-[10px] h-full">
          No pending trades. Edit weights or adjust leverage to stage trades.
        </div>
      ) : (
        <div className="overflow-auto scrollbar-hide h-full">
          {stagedTrades.map(stagedTrade => {
            const sourceConfig = SOURCE_BADGE_CONFIG[stagedTrade.source]
            return (
              <div
                key={stagedTrade.id}
                className={twMerge(
                  "flex items-center px-2 py-1.5 border-b border-border/30",
                  (stagedTrade.status === "working" ||
                    stagedTrade.status === "deleted") &&
                    isRebalancing &&
                    "bg-yellow-500/10 border-yellow-500/40",
                  stagedTrade.status === "failed" &&
                    "bg-red-500/5 border-red-500/40",
                )}
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
                {stagedTrade.status === "failed" &&
                  stagedTrade.message !== null && (
                    <span className="ml-2 text-[9px] text-red-400 truncate max-w-[140px]">
                      {stagedTrade.message}
                    </span>
                  )}
              </div>
            )
          })}
        </div>
      )}

      {/* Impact preview + primary rebalance action pinned to bottom */}
      <div className="px-2 py-1.5 border-t border-border/30 bg-muted/20 space-y-2">
        <div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
            <div className="flex justify-between flex-col">
              <span className="text-muted-foreground">Notional</span>
              <span className="font-mono">
                {initialTotalNotional !== undefined &&
                targetNotional !== undefined ? (
                  <>
                    {formatUsd(initialTotalNotional)}{" "}
                    <span className="text-muted-foreground">→</span>{" "}
                    <span
                      className={
                        targetNotional >= initialTotalNotional
                          ? "text-green-500"
                          : "text-red-500"
                      }
                    >
                      {formatUsd(targetNotional)}
                    </span>
                  </>
                ) : (
                  "TODO"
                )}
              </span>
            </div>
            <div className="flex justify-between flex-col">
              <span className="text-muted-foreground">Leverage</span>
              <span className="font-mono">
                {crossAccountLeverage !== undefined ? (
                  <>
                    {(
                      initialCrossAccountLeverage ?? crossAccountLeverage
                    ).toFixed(2)}
                    x <span className="text-muted-foreground">→</span>{" "}
                    <span className="text-yellow-500">
                      {crossAccountLeverage.toFixed(2)}x
                    </span>
                  </>
                ) : (
                  "TODO"
                )}
              </span>
            </div>
          </div>
        </div>
        <Button
          size="sm"
          className="w-full h-8 text-[11px] gap-1"
          onClick={() => {
            if (!onRebalance || !hasStaged || disableSubmit || isRebalancing) {
              return
            }
            onRebalance()
          }}
          disabled={disableSubmit || isRebalancing || !hasStaged}
        >
          <Send className="h-3 w-3" />
          {isRebalancing ? "Sending..." : "Rebalance"}
        </Button>
      </div>
    </div>
  )
}
