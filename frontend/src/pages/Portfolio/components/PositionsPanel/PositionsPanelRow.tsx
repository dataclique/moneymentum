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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import type { OrderSide } from "@/hooks/useTrading"
import { MIN_CHANGE_DELTA, MIN_USD } from "../../hooks/usePortfolioState"
import { useWallet } from "@/hooks/useWallet"
import { WalletHeader } from "@/components/wallet-header"
import { LeverageDialog } from "./LeverageDialog"

import { type TargetPortfolioInterface } from "../../hooks/usePortfolioState"

interface PositionsPanelProps {
  positions: Record<string, TargetPortfolioInterface>
  isLoading: boolean
  fundingIsLoading: boolean
  leverageLimitsMap: Record<string, number | undefined>
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
}

const getSideBadgeClass = (side: OrderSide) =>
  side === "buy"
    ? "bg-green-500/20 text-green-500"
    : "bg-red-500/20 text-red-500"

// TODO: move to separate component
export const PositionsPanelRow = (props: {
  symbol: string
  position: any
  status: "new" | "unchanged" | "changed" | "closing"
  maxLeverage: number
  isPrecise: boolean
  fundingIsLoading: boolean
  onRemove: (symbol: string) => void
  onUndoRemove: (symbol: string) => void
  onSideChange: (symbol: string, side: OrderSide) => void
  onLeverageChange: (symbol: string, leverage: number) => void
  onNotionalChange: (symbol: string, notional: number) => void
  onWeightChange: (symbol: string, percentage: number) => void
  fundingRatesByBaseSymbol?: Record<string, number>
  totalNotional: number
}): JSX.Element => {
  const notional = () => props.position().notional
  const weight = createMemo(() => {
    return new Decimal(notional()).div(props.totalNotional).mul(100).toFixed(2)
  })

  const isClosing = () => props.status === "closing"

  const isNew = () => props.status === "new"
  const isChanged = () => props.status === "changed"

  const baseSymbol = () =>
    props.position().symbol.split("/")[0] ?? props.position().symbol
  const fundingRate = () => props.fundingRatesByBaseSymbol?.[baseSymbol()]

  // const targetValue = () =>
  //   props.token.targetNotional ??
  //   notional() ??
  //   parseFloat(notional())
  // const showDeltaWarning = () =>
  //   !props.isPrecise &&
  //   props.token.deltaInsufficient === true

  // fundingRate we got from hyperliquid API is 1 hour rate
  // to get annualized rate, we multiply by 24 (hours) and 365 (days)
  const annualizedFundingRate = () =>
    fundingRate() === undefined ? null : fundingRate()! * 24 * 365
  const positionAdjustedFundingRate = () => {
    const rate = annualizedFundingRate()
    if (rate === null) return null
    return props.position().side === "buy" ? -rate : rate
  }
  const fundingDisplay = () => {
    const rate = positionAdjustedFundingRate()
    return rate === null ? "--" : `${(rate * 100).toFixed(2)}%`
  }
  const fundingClassName = () => {
    const rate = positionAdjustedFundingRate()
    if (rate === null || rate === 0) return "text-muted-foreground"
    return rate > 0 ? "text-emerald-500" : "text-rose-500"
  }

  // const showWarning = () => showDeltaWarning() || showSmallPositionWarning()

  return (
    <tr
      class={cn(
        "border-b border-border/30 position-row transition-opacity",
        isClosing() && "opacity-50 bg-red-500/5",
        isNew() && "bg-green-500/5",
      )}
    >
      <td class="px-2 py-1 font-medium flex flex-row gap-[4px] pointer-events-auto">
        <span class="font-medium">{baseSymbol()}</span>
        <LeverageDialog
          symbol={props.position().symbol}
          leverage={props.position().leverage}
          maxLeverage={props.maxLeverage}
          disabled={isClosing()}
          onLeverageChange={props.onLeverageChange}
        />
      </td>
      <td class="px-2 py-1 pointer-events-auto">
        <select
          value={props.position().side}
          onChange={event => {
            props.onSideChange(
              props.position().symbol,
              event.currentTarget.value as OrderSide,
            )
          }}
          disabled={isClosing()}
          class={cn(
            "text-[10px] font-medium px-1.5 py-0.5 rounded border-0 bg-transparent",
            !isClosing() && "cursor-pointer",
            getSideBadgeClass(props.position().side),
            isClosing() && "grayscale opacity-50",
          )}
        >
          <option value="buy">LONG</option>
          <option value="sell">SHORT</option>
        </select>
      </td>
      <td class="px-2 py-1 text-right pointer-events-auto">
        <Show
          when={!isClosing()}
          fallback={<span class="text-rose-500 text-[10px]">→ 0%</span>}
        >
          <input
            type="number"
            value={weight()}
            onInput={inputEvent => {
              const raw = inputEvent.currentTarget.value
              const parsed = raw === "" ? 0 : Number.parseFloat(raw)
              props.onWeightChange(props.position().symbol, parsed)
            }}
            step={0.5}
            min={0}
            max={100}
            class="w-12 text-right font-mono text-[11px] rounded border border-border bg-transparent px-1 py-0.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span class="text-muted-foreground text-[10px] ml-0.5">%</span>
        </Show>
      </td>
      <td class="px-2 py-1 text-right pointer-events-auto">
        <span class="text-muted-foreground text-[10px]">$</span>
        <input
          type="number"
          value={notional().toFixed(2)}
          onInput={inputEvent => {
            const raw = inputEvent.currentTarget.value
            const parsed = raw === "" ? 0 : Number.parseFloat(raw)
            props.onNotionalChange(props.position().symbol, parsed)
          }}
          disabled={isClosing()}
          step={1}
          min={0}
          class="w-16 text-right font-mono text-[11px] rounded border border-border bg-transparent px-1 py-0.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {/* <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              class={cn(
                "inline-block ml-0.5 align-middle",
                !showWarning() && "pointer-events-none opacity-0",
              )}
            >
              <CircleAlert class="h-3 w-3 text-amber-500" />
            </TooltipTrigger>
            <TooltipContent class="text-xs">
              <Show when={showDeltaWarning()}>
                <p>
                  Delta $
                  {Math.abs(
                    (props.token.targetNotional ?? 0) -
                      (props.token.currentNotional ?? 0),
                  ).toFixed(2)}{" "}
                  below ${MIN_CHANGE_DELTA} minimum.
                </p>
              </Show>
              <Show when={showSmallPositionWarning()}>
                <p>
                  Position ${targetValue().toFixed(2)} below ${MIN_USD} minimum.
                </p>
              </Show>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider> */}
      </td>
      <td
        class={cn(
          "px-2 py-1 text-right font-mono text-[11px] w-[11ch]",
          fundingClassName(),
        )}
      >
        <Show
          when={!props.fundingIsLoading}
          fallback={<Skeleton class="h-3 w-[64px] inline-block align-middle" />}
        >
          {fundingDisplay()}
        </Show>
      </td>
      <td class="px-2 py-1 text-right font-mono text-[11px] text-muted-foreground">
        0
      </td>
      <td class="px-2 py-1 text-right font-mono text-[11px] text-muted-foreground">
        0
      </td>
      <td class="px-2 py-1 text-right font-mono text-[11px] text-muted-foreground">
        0
      </td>
      <td class="px-2 py-1 text-right">
        <Button
          variant="ghost"
          size="icon"
          class="h-6 w-6"
          onClick={() => {
            if (isClosing()) {
              props.onUndoRemove(props.position().symbol)
            } else {
              props.onRemove(props.position().symbol)
            }
          }}
        >
          <Show when={isClosing()} fallback={<Trash2 class="h-3 w-3" />}>
            <Undo2 class="h-3 w-3" />
          </Show>
        </Button>
      </td>
    </tr>
  )
}
