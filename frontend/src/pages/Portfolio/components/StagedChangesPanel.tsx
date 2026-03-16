import { For, Show } from "solid-js"
import { cn } from "@/lib/cn"
import { Send } from "lucide-solid"
import { Button } from "@/components/ui/button"
import type { AllocationStatus } from "../hooks/usePortfolioState"

type Side = "buy" | "sell"

export interface StagedTrade {
  // id: string
  underlying: string
  side: Side
  notional: number
  previousWeight?: number
  newWeight?: number
  // status: AllocationStatus
  // message: string | null
}

interface StagedChangesPanelProps {
  stagedTrades?: StagedTrade[]
  currentTotalNotional: number
  targetTotalNotional: number
  currentCrossAccountLeverage: number
  targetCrossAccountLeverage: number
  onRebalance?: () => void
  isRebalancing?: boolean
  disableSubmit: boolean
  onClearAll?: () => void
}

// Grid template for staged-change rows:
// [0] Side badge (6ch) | [1] Symbol (~JELLYJELLY width + padding) | [2] Weight change (auto) | [3] Notional (= "$2000.00")
const STAGED_ROW_GRID_TEMPLATE =
  "grid grid-cols-[6ch_13ch_auto_8ch] items-center px-2 py-1.5 border-b border-border/30 text-[10px]"

const formatUnsignedPct = (weightFraction: number): string =>
  `${(weightFraction * 100).toFixed(2)}%`

const formatUsdPrecise = (value: number): string => `$${value.toFixed(2)}`

// Minimum notional change to show an arrow in the notional preview.
// Difference between initial and target notional arises because
// initial total notional is rounded to 2 decimal places while target
// is computed from accountValue * leverage separately.
const NOTIONAL_EPSILON_USD = 0.1

export const StagedChangesPanel = (props: StagedChangesPanelProps) => {
  const stagedTrades = () => props.stagedTrades ?? []
  const hasStaged = () => stagedTrades().length > 0

  console.log(stagedTrades())

  const isRebalancing = () => props.isRebalancing ?? false
  const disableSubmit = () => props.disableSubmit ?? false

  const shouldShowNotionalArrow = () =>
    props.currentTotalNotional &&
    props.targetTotalNotional &&
    Math.abs(props.targetTotalNotional - props.currentTotalNotional) >=
      NOTIONAL_EPSILON_USD

  const currentLeverage = () => props.currentCrossAccountLeverage
  const targetLeverage = () => props.targetCrossAccountLeverage
  const shouldShowLeverageArrow = () =>
    currentLeverage() &&
    targetLeverage() &&
    currentLeverage() !== targetLeverage()

  return (
    <div class="flex-1 border border-border rounded flex flex-col min-w-0">
      <div class="px-2 py-1.5 bg-muted/30 flex items-center justify-between border-b border-border">
        <div class="flex items-center gap-2">
          <span class="font-medium">STAGED CHANGES</span>
        </div>
        <Show when={hasStaged() && props.onClearAll}>
          <button
            type="button"
            class="text-muted-foreground hover:text-destructive text-[10px]"
            onClick={() => {
              props.onClearAll?.()
            }}
          >
            Clear all
          </button>
        </Show>
      </div>

      <Show
        when={hasStaged()}
        fallback={
          <div class="px-2 py-3 text-muted-foreground text-center text-[10px] h-full">
            No pending trades. Edit weights or adjust leverage to stage trades.
          </div>
        }
      >
        <div class="overflow-auto scrollbar-hide h-full">
          <For each={stagedTrades()}>
            {stagedTrade => {
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
                  class={cn(
                    STAGED_ROW_GRID_TEMPLATE,
                    // (stagedTrade.status === "working" ||
                    //   stagedTrade.status === "deleted") &&
                    //   isRebalancing() &&
                    //   "bg-yellow-500/10 border-yellow-500/40",
                    // stagedTrade.status === "failed" &&
                    //   "bg-red-500/5 border-red-500/40",
                  )}
                >
                  <span
                    class={cn(
                      "text-[10px] font-medium px-1 py-0.5 rounded w-[5ch] text-center",
                      stagedTrade.side === "buy"
                        ? "bg-green-500/20 text-green-500"
                        : "bg-red-500/20 text-red-500",
                    )}
                  >
                    {stagedTrade.side === "buy" ? "BUY" : "SELL"}
                  </span>
                  <span class="px-1 truncate font-medium text-[11px] text-left">
                    {baseSymbol}
                  </span>
                  <div
                    class={cn(
                      "font-mono mr-2 justify-self-center grid grid-cols-[max-content_2ch_max-content] items-baseline gap-x-1",
                      deltaClass,
                    )}
                  >
                    <span class="w-[6ch] text-right">
                      {formatUnsignedPct(prevWeight)}
                    </span>
                    <span class="w-[2ch] text-center">{arrow}</span>
                    <span class="w-[6ch] text-right">
                      {formatUnsignedPct(nextWeight)}
                    </span>
                  </div>
                  <span class="font-mono text-muted-foreground justify-self-end w-full text-right">
                    {formatUsdPrecise(stagedTrade.notional)}
                  </span>
                  {/* <Show
                    when={
                      stagedTrade.status === "failed" &&
                      stagedTrade.message !== null
                    }
                  >
                    <span class="ml-2 text-[9px] text-red-400 truncate max-w-[140px]">
                      {stagedTrade.message}
                    </span>
                  </Show> */}
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      {/* Impact preview + primary rebalance action pinned to bottom */}
      <div class="px-2 py-1.5 border-t border-border/30 bg-muted/20 space-y-2">
        <div>
          <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
            <div class="flex justify-between flex-col">
              <span class="text-muted-foreground">Notional</span>
              <span class="font-mono">
                <Show
                  when={props.currentTotalNotional && props.targetTotalNotional}
                  fallback="--"
                >
                  <Show
                    when={shouldShowNotionalArrow()}
                    fallback={formatUsdPrecise(props.targetTotalNotional)}
                  >
                    {formatUsdPrecise(props.currentTotalNotional)}{" "}
                    <span class="text-muted-foreground">→</span>{" "}
                    <span
                      class={
                        props.targetTotalNotional >= props.currentTotalNotional
                          ? "text-green-500"
                          : "text-red-500"
                      }
                    >
                      {formatUsdPrecise(props.targetTotalNotional)}
                    </span>
                  </Show>
                </Show>
              </span>
            </div>
            <div class="flex justify-between flex-col">
              <span class="text-muted-foreground">Leverage</span>
              <span class="font-mono">
                <Show when={props.targetCrossAccountLeverage} fallback="--">
                  <Show
                    when={shouldShowLeverageArrow()}
                    fallback={`${props.targetCrossAccountLeverage.toFixed(2)}x`}
                  >
                    {currentLeverage()?.toFixed(2)}x{" "}
                    <span class="text-muted-foreground">→</span>{" "}
                    <span class="text-yellow-500">
                      {(targetLeverage() ?? 0).toFixed(2)}x
                    </span>
                  </Show>
                </Show>
              </span>
            </div>
          </div>
        </div>
        <Button
          size="sm"
          class="w-full h-8 text-[11px] gap-1"
          onClick={() => {
            if (
              !props.onRebalance ||
              !hasStaged() ||
              disableSubmit() ||
              isRebalancing()
            ) {
              return
            }
            props.onRebalance()
          }}
          disabled={
            // !props.onRebalance ||
            disableSubmit()
            // ||
            // isRebalancing() ||
            // !hasStaged()
          }
          aria-disabled={
            // !props.onRebalance ||
            disableSubmit()
            // ||
            // isRebalancing() ||
            // !hasStaged()
          }
        >
          <Send class="h-3 w-3" />
          {isRebalancing() ? "Sending..." : "Rebalance"}
        </Button>
      </div>
    </div>
  )
}
