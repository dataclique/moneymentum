import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { AllocationStatus } from "../hooks/usePortfolioState"

type Side = "buy" | "sell"

export interface StagedTrade {
  id: string
  underlying: string
  side: Side
  notional: number
  previousWeight?: number
  newWeight?: number
  status: AllocationStatus
  message: string | null
}

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

// Grid template for staged-change rows:
// [0] Side badge (6ch) | [1] Symbol (~JELLYJELLY width + padding) | [2] Weight change (auto) | [3] Notional (≈ "$2000.00")
const STAGED_ROW_GRID_TEMPLATE =
  "grid grid-cols-[6ch_13ch_auto_8ch] items-center px-2 py-1.5 border-b border-border/30 text-[10px]"

const formatUnsignedPct = (weightFraction: number): string =>
  `${(weightFraction * 100).toFixed(2)}%`

const formatUsdPrecise = (value: number): string => `$${value.toFixed(2)}`

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
        {hasStaged && onClearAll && (
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive text-[10px]"
            onClick={() => {
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
            const baseSymbol =
              stagedTrade.underlying.split("/")[0] ?? stagedTrade.underlying

            const prevWeight = stagedTrade.previousWeight ?? 0
            const nextWeight = stagedTrade.newWeight ?? prevWeight
            const weightDelta = nextWeight - prevWeight

            const arrow = weightDelta > 0 ? "↑" : weightDelta < 0 ? "↓" : "→"
            const deltaClass =
              weightDelta > 0
                ? "text-emerald-500"
                : weightDelta < 0
                  ? "text-rose-500"
                  : "text-muted-foreground"

            return (
              <div
                key={stagedTrade.id}
                className={twMerge(
                  STAGED_ROW_GRID_TEMPLATE,
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
                      "text-[10px] font-medium px-1 py-0.5 rounded w-[5ch] text-center",
                      stagedTrade.side === "buy"
                        ? "bg-green-500/20 text-green-500"
                        : "bg-red-500/20 text-red-500",
                    ),
                  )}
                >
                  {stagedTrade.side === "buy" ? "BUY" : "SELL"}
                </span>
                <span className="px-1 truncate font-medium text-[11px] text-left">
                  {baseSymbol}
                </span>
                <div
                  className={twMerge(
                    "font-mono mr-2 justify-self-center grid grid-cols-[max-content_2ch_max-content] items-baseline gap-x-1",
                    deltaClass,
                  )}
                >
                  <span className="w-[6ch] text-right">
                    {formatUnsignedPct(prevWeight)}
                  </span>
                  <span className="w-[2ch] text-center">{arrow}</span>
                  <span className="w-[6ch] text-right">
                    {formatUnsignedPct(nextWeight)}
                  </span>
                </div>
                <span className="font-mono text-muted-foreground justify-self-end w-full text-right">
                  {formatUsdPrecise(stagedTrade.notional)}
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
                    {formatUsdPrecise(initialTotalNotional)}{" "}
                    <span className="text-muted-foreground">→</span>{" "}
                    <span
                      className={
                        targetNotional >= initialTotalNotional
                          ? "text-green-500"
                          : "text-red-500"
                      }
                    >
                      {formatUsdPrecise(targetNotional)}
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
          disabled={
            !onRebalance || disableSubmit || isRebalancing || !hasStaged
          }
          aria-disabled={
            !onRebalance || disableSubmit || isRebalancing || !hasStaged
          }
        >
          <Send className="h-3 w-3" />
          {isRebalancing ? "Sending..." : "Rebalance"}
        </Button>
      </div>
    </div>
  )
}
