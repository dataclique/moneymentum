import {
  createSignal,
  createEffect,
  Show,
  For,
  untrack,
  createMemo,
} from "solid-js"
import type { JSX } from "solid-js"
import Decimal from "decimal.js"
import { Trash2, Undo2, CircleAlert } from "lucide-solid"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Slider } from "@/components/ui/slider"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import type { OrderSide } from "@/hooks/useTrading"
import { useWallet } from "@/hooks/useWallet"
import { WalletHeader } from "@/components/wallet-header"

import { type PortfolioInterface } from "../../hooks/usePortfolioState"
import { PositionsPanelRow } from "./PositionsPanelRow"

interface PositionsPanelProps {
  currentPortfolio: Record<string, PortfolioInterface>
  targetPortfolio: Record<string, PortfolioInterface>
  deletedArchive: Record<string, PortfolioInterface>
  isLoading: boolean
  fundingIsLoading: boolean
  leverageLimitsMap: Record<string, number>
  _isRebalancing?: boolean
  isPrecise: boolean
  onRemove: (symbol: string) => void
  onUndoRemove: (symbol: string) => void
  onSideChange: (symbol: string, side: OrderSide) => void
  onLeverageChange: (symbol: string, leverage: number) => void
  onNotionalChange: (symbol: string, notional: number) => void
  onWeightChange: (symbol: string, percentage: number) => void
  fundingRatesByBaseSymbol?: Record<string, number>
  targetTotalNotional: number
  symbolsBelowMinimum: string[]
  symbolsDeltaBelowMinimum: string[]
}

export const PositionsPanel = (props: PositionsPanelProps): JSX.Element => {
  const { isConnected } = useWallet()
  const positionsCount = createMemo(
    () =>
      Object.keys(props.targetPortfolio).length +
      Object.keys(props.deletedArchive).length,
  )

  const allSymbols = createMemo(() => {
    return [
      ...new Set([
        ...Object.keys(props.currentPortfolio),
        ...Object.keys(props.targetPortfolio),
      ]),
    ]
  })

  return (
    <div class="flex flex-col rounded border border-border min-h-0 max-h-[calc(100vh-4rem)] w-full max-w-[600px] shrink-0">
      <div class="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between shrink-0">
        <div class="flex items-center gap-2">
          <span class="font-medium">POSITIONS</span>
          <span class="text-muted-foreground text-[11px]">
            {positionsCount()} position
            {positionsCount() !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-auto scrollbar-hide">
        <Show
          when={!props.isLoading}
          fallback={
            <div class="p-2 space-y-1">
              <For each={Array.from({ length: 8 })}>
                {() => <Skeleton class="h-5 w-full" />}
              </For>
            </div>
          }
        >
          <Show
            when={isConnected()}
            fallback={
              <div class="h-full flex flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground text-[11px]">
                <p class="max-w-[260px]">
                  Connect your wallet to view and rebalance positions.
                </p>
                <WalletHeader />
              </div>
            }
          >
            <Show
              when={positionsCount() > 0}
              fallback={
                <div class="p-4 text-center text-muted-foreground text-[11px]">
                  Add positions from the screener.
                </div>
              }
            >
              <table class="w-full">
                <thead class="sticky top-0 bg-muted/90 z-10">
                  <tr class="text-muted-foreground text-[10px]">
                    <th class="px-2 py-1 text-left font-medium">Asset</th>
                    <th class="px-2 py-1 text-left font-medium">Side</th>
                    <th class="px-2 py-1 text-right font-medium">Weight</th>
                    <th class="px-2 py-1 text-right font-medium">Notional</th>
                    <th
                      class="px-2 py-1 text-right font-medium w-[11ch]"
                      title="Annualized funding rate (signed by position direction)"
                    >
                      Rate
                    </th>
                    <th class="px-2 py-1 text-right font-medium">D</th>
                    <th class="px-2 py-1 text-right font-medium">G</th>
                    <th class="px-2 py-1 text-right font-medium">T</th>
                    <th class="px-2 py-1 text-right font-medium w-10" />
                  </tr>
                </thead>
                <tbody>
                  <For each={allSymbols()}>
                    {symbol => {
                      //TODO: do we actually need changed, unchanged, new, closing statuses?
                      // maybe only closing for view logic?

                      const status = createMemo(() => {
                        const target = props.targetPortfolio[symbol]
                        const current = props.currentPortfolio[symbol]

                        if (!current && target) return "new"
                        if (current && !target) return "closing"
                        if (current && target) {
                          const isChanged =
                            current.notional !== target.notional ||
                            current.side !== target.side ||
                            current.leverage !== target.leverage
                          return isChanged ? "changed" : "unchanged"
                        }
                        return "unchanged"
                      })

                      const delta = createMemo(() => {
                        return Math.abs(
                          (props.targetPortfolio[symbol]?.notional ?? 0) -
                            (props.currentPortfolio[symbol]?.notional ?? 0),
                        )
                      })

                      const displayPosition = createMemo(() => {
                        // 1. Если позиция есть в таргете — берем её
                        if (props.targetPortfolio[symbol]) {
                          return props.targetPortfolio[symbol]
                        }

                        // 2. Если позиции нет в таргете, но она есть в архиве (нажали X) — берем из архива
                        if (props.deletedArchive[symbol]) {
                          return props.deletedArchive[symbol]
                        }

                        // 3. Если нет ни там, ни там (но есть в current) — берем из current
                        return { ...props.currentPortfolio[symbol] }
                      })

                      return (
                        <PositionsPanelRow
                          symbol={symbol}
                          position={displayPosition}
                          status={status()}
                          maxLeverage={props.leverageLimitsMap[symbol]} //TODO: check for new reactivity and fetching logic
                          isPrecise={props.isPrecise}
                          fundingIsLoading={props.fundingIsLoading}
                          onRemove={props.onRemove}
                          onUndoRemove={props.onUndoRemove}
                          onSideChange={props.onSideChange}
                          onLeverageChange={props.onLeverageChange}
                          onNotionalChange={props.onNotionalChange}
                          onWeightChange={props.onWeightChange}
                          fundingRatesByBaseSymbol={
                            props.fundingRatesByBaseSymbol
                          }
                          totalNotional={props.targetTotalNotional}
                          symbolsBelowMinimum={props.symbolsBelowMinimum}
                          symbolsDeltaBelowMinimum={
                            props.symbolsDeltaBelowMinimum
                          }
                          symbolDelta={delta()}
                        />
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
