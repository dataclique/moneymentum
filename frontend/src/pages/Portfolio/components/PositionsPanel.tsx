import { createSignal, createEffect, Show, For, untrack } from "solid-js"
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
import {
  type TokenAllocation,
  MIN_CHANGE_DELTA,
  MIN_USD,
} from "../hooks/usePortfolioState"
import { useWallet } from "@/hooks/useWallet"
import { WalletHeader } from "@/components/wallet-header"

interface PositionsPanelProps {
  tokens: TokenAllocation[]
  isLoading: boolean
  displayNotional: number
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
}

const getSideBadgeClass = (side: OrderSide) =>
  side === "buy"
    ? "bg-green-500/20 text-green-500"
    : "bg-red-500/20 text-red-500"

const PositionsTableRow = (props: {
  token: TokenAllocation
  displayNotional: number
  maxLeverage: number | undefined
  isPrecise: boolean
  onRemove: (symbol: string) => void
  onUndoRemove: (symbol: string) => void
  onSideChange: (symbol: string, side: OrderSide) => void
  onLeverageChange: (symbol: string, leverage: number) => void
  onNotionalChange: (symbol: string, notional: number) => void
  onWeightChange: (symbol: string, percentage: number) => void
  fundingRate?: number
}): JSX.Element => {
  const usdAmount = () =>
    props.displayNotional > 0
      ? new Decimal(props.token.percentage)
          .div(100)
          .mul(props.displayNotional)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toFixed(2)
      : "0.00"
  const [weightInput, setWeightInput] = createSignal(
    untrack(() => String(props.token.percentage)),
  )
  const [notionalInput, setNotionalInput] = createSignal(
    untrack(() => (props.token.notional ?? parseFloat(usdAmount())).toFixed(2)),
  )
  const [isWeightFocused, setIsWeightFocused] = createSignal(false)
  const [isNotionalFocused, setIsNotionalFocused] = createSignal(false)
  const externalNotional = () => props.token.notional ?? parseFloat(usdAmount())
  let prevNotional = untrack(externalNotional)
  let prevPercentage = untrack(() => props.token.percentage)

  // Sync external notional into controlled input state
  createEffect(() => {
    const current = externalNotional()
    if (!isNotionalFocused() && prevNotional !== current) {
      prevNotional = current
      setNotionalInput(current.toFixed(2))
    }
  })

  // Sync external percentage into controlled weight input state
  createEffect(() => {
    const current = props.token.percentage
    if (!isWeightFocused() && prevPercentage !== current) {
      prevPercentage = current
      setWeightInput(String(current))
    }
  })

  const targetValue = () =>
    props.token.targetNotional ??
    props.token.notional ??
    parseFloat(usdAmount())
  const showDeltaWarning = () =>
    !props.isPrecise &&
    props.token.deltaInsufficient === true &&
    props.token.status === "modified"
  const showSmallPositionWarning = () =>
    props.token.status !== "untouched" &&
    props.token.status !== "deleted" &&
    targetValue() > 0 &&
    new Decimal(targetValue()).plus(0.01).lt(MIN_USD)

  // fundingRate we got from hyperliquid API is 1 hour rate
  // to get annualized rate, we multiply by 24 (hours) and 365 (days)
  const annualizedFundingRate = () =>
    props.fundingRate === undefined ? null : props.fundingRate * 24 * 365
  const positionAdjustedFundingRate = () => {
    const rate = annualizedFundingRate()
    if (rate === null) return null
    return props.token.side === "buy" ? -rate : rate
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

  const showWarning = () => showDeltaWarning() || showSmallPositionWarning()

  const sliderMaxLeverage = () =>
    typeof props.maxLeverage === "number" ? props.maxLeverage : 1

  return (
    <tr
      class={cn(
        "border-b border-border/30 hover:bg-muted/20",
        props.token.status === "deleted" && "opacity-50",
      )}
    >
      <td class="px-2 py-1 font-medium flex flex-row gap-[4px]">
        <span class="font-medium">{props.token.symbol.split("/")[0]}</span>
        <Dialog>
          <DialogTrigger
            as={Button}
            variant="ghost"
            size="sm"
            class="h-auto px-1.5 py-0 text-[10px] font-mono border border-border rounded"
            disabled={props.token.status === "deleted"}
          >
            {props.token.leverage}x
          </DialogTrigger>
          <DialogContent class="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Leverage {props.token.symbol}</DialogTitle>
              <DialogDescription>
                Max leverage{" "}
                {props.maxLeverage !== undefined
                  ? props.maxLeverage.toFixed(1)
                  : "1.0"}
                x
              </DialogDescription>
            </DialogHeader>
            <div class="grid gap-4 py-4">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px]">{props.token.leverage}x</span>
                <Slider
                  value={[props.token.leverage]}
                  onChange={([leverage]) => {
                    props.onLeverageChange(props.token.symbol, leverage)
                  }}
                  minValue={1}
                  maxValue={sliderMaxLeverage()}
                  step={1}
                  class="w-[80%]"
                />
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </td>
      <td class="px-2 py-1">
        <select
          value={props.token.side}
          onChange={event => {
            props.onSideChange(
              props.token.symbol,
              event.currentTarget.value as OrderSide,
            )
          }}
          disabled={props.token.status === "deleted"}
          class={cn(
            "text-[10px] font-medium px-1.5 py-0.5 rounded border-0 bg-transparent cursor-pointer",
            getSideBadgeClass(props.token.side),
          )}
        >
          <option value="buy">LONG</option>
          <option value="sell">SHORT</option>
        </select>
      </td>
      <td class="px-2 py-1 text-right">
        <input
          type="number"
          value={weightInput()}
          onInput={inputEvent => {
            const raw = inputEvent.currentTarget.value
            setWeightInput(raw)
            const parsed = raw === "" ? 0 : Number.parseFloat(raw)
            if (!Number.isNaN(parsed) && parsed >= 0) {
              props.onWeightChange(props.token.symbol, parsed)
            }
          }}
          onFocus={() => {
            setIsWeightFocused(true)
          }}
          onBlur={blurEvent => {
            setIsWeightFocused(false)
            const raw = blurEvent.currentTarget.value
            if (raw.trim() === "") {
              // Treat empty input as 0 when leaving the field
              props.onWeightChange(props.token.symbol, 0)
              setWeightInput("0")
              return
            }
            const parsed = Number.parseFloat(raw)
            if (Number.isNaN(parsed) || parsed < 0) {
              setWeightInput(String(props.token.percentage))
              return
            }
            const clamped = Math.min(100, parsed)
            props.onWeightChange(props.token.symbol, clamped)
            setWeightInput(String(clamped))
          }}
          disabled={props.token.status === "deleted"}
          step={0.5}
          min={0}
          max={100}
          class="w-12 text-right font-mono text-[11px] rounded border border-border bg-transparent px-1 py-0.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="text-muted-foreground text-[10px] ml-0.5">%</span>
      </td>
      <td class="px-2 py-1 text-right">
        <span class="text-muted-foreground text-[10px]">$</span>
        <input
          type="number"
          value={notionalInput()}
          onInput={inputEvent => {
            const raw = inputEvent.currentTarget.value
            setNotionalInput(raw)
            const parsed = raw === "" ? 0 : Number.parseFloat(raw)
            if (!Number.isNaN(parsed) && parsed >= 0) {
              props.onNotionalChange(props.token.symbol, parsed)
            }
          }}
          onFocus={() => {
            setIsNotionalFocused(true)
          }}
          onBlur={blurEvent => {
            setIsNotionalFocused(false)
            const raw = blurEvent.currentTarget.value
            if (raw.trim() === "") {
              // Treat empty input as 0 when leaving the field
              props.onNotionalChange(props.token.symbol, 0)
              setNotionalInput("0.00")
              return
            }
            const parsed = Number.parseFloat(raw)
            if (Number.isNaN(parsed) || parsed < 0) {
              const fallback = props.token.notional ?? parseFloat(usdAmount())
              setNotionalInput(fallback.toFixed(2))
              return
            }
            props.onNotionalChange(props.token.symbol, parsed)
            setNotionalInput(parsed.toFixed(2))
          }}
          disabled={props.token.status === "deleted"}
          step={1}
          min={0}
          class="w-16 text-right font-mono text-[11px] rounded border border-border bg-transparent px-1 py-0.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <TooltipProvider>
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
        </TooltipProvider>
      </td>
      <td
        class={cn(
          "px-2 py-1 text-right font-mono text-[11px] w-[11ch]",
          fundingClassName(),
        )}
      >
        {fundingDisplay()}
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
            if (props.token.status === "deleted") {
              props.onUndoRemove(props.token.symbol)
            } else {
              props.onRemove(props.token.symbol)
            }
          }}
        >
          <Show
            when={props.token.status === "deleted"}
            fallback={<Trash2 class="h-3 w-3" />}
          >
            <Undo2 class="h-3 w-3" />
          </Show>
        </Button>
      </td>
    </tr>
  )
}

export const PositionsPanel = (props: PositionsPanelProps): JSX.Element => {
  const { isConnected } = useWallet()

  return (
    <div class="flex flex-col rounded border border-border min-h-0 max-h-[calc(100vh-4rem)] w-full max-w-[600px] shrink-0">
      <div class="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between shrink-0">
        <div class="flex items-center gap-2">
          <span class="font-medium">POSITIONS</span>
          <span class="text-muted-foreground text-[11px]">
            {props.tokens.length} position
            {props.tokens.length !== 1 ? "s" : ""}
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
              when={props.tokens.length > 0}
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
                  <For each={props.tokens}>
                    {token => {
                      const baseSymbol =
                        token.symbol.split("/")[0] ?? token.symbol
                      const fundingRate =
                        props.fundingRatesByBaseSymbol?.[baseSymbol]

                      return (
                        <PositionsTableRow
                          token={token}
                          displayNotional={props.displayNotional}
                          maxLeverage={props.leverageLimitsMap[token.symbol]}
                          isPrecise={props.isPrecise}
                          onRemove={props.onRemove}
                          onUndoRemove={props.onUndoRemove}
                          onSideChange={props.onSideChange}
                          onLeverageChange={props.onLeverageChange}
                          onNotionalChange={props.onNotionalChange}
                          onWeightChange={props.onWeightChange}
                          fundingRate={fundingRate}
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
