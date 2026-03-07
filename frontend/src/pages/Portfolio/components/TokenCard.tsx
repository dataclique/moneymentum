import { createSignal, createEffect, Show, untrack } from "solid-js"
import Decimal from "decimal.js"
import { Trash2, Undo2, CircleAlert } from "lucide-solid"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { OrderSide } from "@/hooks/useTrading"
import {
  type TokenAllocation,
  MIN_CHANGE_DELTA,
  MIN_USD,
} from "../hooks/usePortfolioState"

const getSideColor = (side: OrderSide) =>
  side === "buy" ? "rgba(34, 197, 94, 0.8)" : "rgba(239, 68, 68, 0.8)"

interface TokenCardProps {
  token: TokenAllocation
  displayNotional: number
  maxLeverage: number | undefined
  isRebalancing: boolean
  isPrecise: boolean
  onRemove: (symbol: string) => void
  onUndoRemove: (symbol: string) => void
  onSideChange: (symbol: string, side: OrderSide) => void
  onLeverageChange: (symbol: string, leverage: number) => void
  onNotionalChange: (symbol: string, notional: number) => void
  onWeightChange: (symbol: string, percentage: number) => void
}

export const TokenCard = (props: TokenCardProps) => {
  const sideColor = () => getSideColor(props.token.side)
  const borderColor = () =>
    props.token.status === "deleted"
      ? sideColor().replace("0.8", "0.2")
      : sideColor()
  const showProgressAnimation = () =>
    props.token.status === "working" ||
    (props.token.status === "deleted" && props.isRebalancing)
  const cardStyle = () => ({
    "border-left-color": borderColor(),
  })
  const isLong = () => props.token.side === "buy"
  // Always show target notional based on percentage and displayNotional
  const usdAmount = () =>
    props.displayNotional > 0
      ? new Decimal(props.token.percentage)
          .div(100)
          .mul(props.displayNotional)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toFixed(2)
      : "0.00"

  // Local state for notional input to allow empty field while typing
  const [notionalInput, setNotionalInput] = createSignal(
    untrack(() => (props.token.notional ?? parseFloat(usdAmount())).toFixed(2)),
  )

  // Local state for weight input to allow empty field while typing
  const [weightInput, setWeightInput] = createSignal(
    untrack(() => String(props.token.percentage)),
  )

  // Sync local state when token.notional changes from outside
  const externalNotional = () => props.token.notional ?? parseFloat(usdAmount())
  let prevExternalNotional = untrack(externalNotional)
  createEffect(() => {
    const current = externalNotional()
    if (prevExternalNotional !== current) {
      prevExternalNotional = current
      setNotionalInput(current.toFixed(2))
    }
  })

  // Sync local weight state when token.percentage changes from outside
  let prevPercentage = untrack(() => props.token.percentage)
  createEffect(() => {
    const current = props.token.percentage
    if (prevPercentage !== current) {
      prevPercentage = current
      setWeightInput(String(current))
    }
  })

  return (
    <Card
      class={twMerge(
        clsx(
          "card-border relative overflow-hidden",
          props.token.status === "idle" && "border-l-4",
          props.token.status === "filled" && "border-l-4 border-emerald-500",
          props.token.status === "working" && "border-l-4",
          props.token.status === "failed" && "border-l-4 border-rose-500",
          props.token.status === "untouched" && "border-l-4 border-blue-500/50",
          props.token.status === "modified" && "border-l-4 border-transparent",
          props.token.status === "deleted" && "border-l-4",
        ),
      )}
      style={cardStyle()}
    >
      <Show when={showProgressAnimation()}>
        <svg
          class="card-border-svg"
          height="100%"
          width="100%"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect
            rx="14"
            ry="14"
            class="card-border-line"
            height="100%"
            width="100%"
            fill="transparent"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </Show>
      <div class="relative z-[2]">
        <div class="grid grid-cols-[8rem_7rem_7rem_6rem_4rem] items-center gap-2 px-3">
          {/* Coin Name and Leverage */}
          <div
            class={twMerge(
              clsx(
                "flex items-center gap-2",
                props.token.status === "deleted" && "opacity-50",
              ),
            )}
          >
            <span class="font-semibold" style={{ color: sideColor() }}>
              {props.token.symbol.split("/")[0]}
            </span>
            <Dialog>
              <DialogTrigger
                as={Button}
                variant="ghost"
                size="sm"
                class="h-auto px-2 py-1 text-xs border border-border rounded-md"
                style={{ color: sideColor() }}
                disabled={props.token.status === "deleted"}
              >
                {props.token.leverage}x
              </DialogTrigger>
              <DialogContent class="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>
                    Set Leverage for {props.token.symbol}
                  </DialogTitle>
                  <DialogDescription>
                    Adjust the leverage for this position. Max leverage is{" "}
                    {props.maxLeverage?.toFixed(1)}x.
                  </DialogDescription>
                </DialogHeader>
                <div class="grid gap-4 py-4">
                  <div class="flex items-center justify-between">
                    <span>{props.token.leverage}x</span>
                    <Slider
                      value={[props.token.leverage]}
                      onChange={([leverage]) => {
                        props.onLeverageChange(props.token.symbol, leverage)
                      }}
                      minValue={1}
                      maxValue={props.maxLeverage}
                      step={1}
                      class="w-[80%]"
                    />
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Weight - percentage of total notional */}
          <div
            class={twMerge(
              clsx(
                "flex items-center justify-center gap-1",
                props.token.status === "deleted" && "opacity-50",
              ),
            )}
          >
            <input
              type="number"
              value={weightInput()}
              onInput={event => {
                const rawValue = event.currentTarget.value
                setWeightInput(rawValue)
                if (rawValue !== "") {
                  const value = parseFloat(rawValue)
                  if (!Number.isNaN(value)) {
                    props.onWeightChange(props.token.symbol, value)
                  }
                }
              }}
              disabled={props.token.status === "deleted"}
              step={0.5}
              min={0}
              max={100}
              class="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span class="text-sm text-muted-foreground">%</span>
          </div>

          {/* Position Notional */}
          <div
            class={twMerge(
              clsx(
                "flex items-center justify-center gap-1",
                props.token.status === "deleted" && "opacity-50",
              ),
            )}
          >
            <span class="text-sm text-muted-foreground">$</span>
            <input
              type="number"
              value={notionalInput()}
              onInput={event => {
                const rawValue = event.currentTarget.value
                setNotionalInput(rawValue)
                if (rawValue !== "") {
                  const value = parseFloat(rawValue)
                  if (!Number.isNaN(value)) {
                    props.onNotionalChange(props.token.symbol, value)
                  }
                }
              }}
              disabled={props.token.status === "deleted"}
              step={1}
              min={0}
              class="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            {(() => {
              const tv = () =>
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
                tv() > 0 &&
                tv() < MIN_USD
              const showWarning = () =>
                showDeltaWarning() || showSmallPositionWarning()
              return (
                <Show when={showWarning()}>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger class="ml-[2px]" aria-label="Warning">
                        <CircleAlert
                          class="h-3.5 w-3.5 text-amber-500"
                          aria-hidden="true"
                        />
                      </TooltipTrigger>
                      <TooltipContent class="space-y-2">
                        <Show when={showDeltaWarning()}>
                          <p class="text-[16px]">
                            Delta $
                            {Math.abs(
                              (props.token.targetNotional ?? 0) -
                                (props.token.currentNotional ?? 0),
                            ).toFixed(2)}{" "}
                            is below ${MIN_CHANGE_DELTA} minimum.
                          </p>
                        </Show>
                        <Show when={showSmallPositionWarning()}>
                          <p class="text-[16px] mb-[0px]">
                            Position value ${tv().toFixed(2)} is below $
                            {MIN_USD} minimum.
                          </p>
                        </Show>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Show>
              )
            })()}
          </div>

          {/* Long/Short Select */}
          <div
            class={twMerge(
              clsx(props.token.status === "deleted" && "opacity-50"),
            )}
          >
            <select
              value={props.token.side}
              onChange={event => {
                props.onSideChange(
                  props.token.symbol,
                  event.currentTarget.value as OrderSide,
                )
              }}
              disabled={props.token.status === "deleted"}
              class={twMerge(
                clsx(
                  "w-full rounded-md border bg-transparent px-2 py-1 text-sm font-medium",
                  isLong()
                    ? "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400"
                    : "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400",
                ),
              )}
            >
              <option value="buy">Long</option>
              <option value="sell">Short</option>
            </select>
          </div>

          {/* Remove Button */}
          <div class="flex items-center justify-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (props.token.status === "deleted") {
                  props.onUndoRemove(props.token.symbol)
                } else {
                  props.onRemove(props.token.symbol)
                }
              }}
              class="h-8 w-8"
              aria-label={
                props.token.status === "deleted"
                  ? `Undo remove ${props.token.symbol}`
                  : `Remove ${props.token.symbol}`
              }
            >
              <Show
                when={props.token.status === "deleted"}
                fallback={<Trash2 class="h-4 w-4" />}
              >
                <Undo2 class="h-4 w-4" />
              </Show>
            </Button>
          </div>
        </div>

        <Show
          when={
            props.token.message &&
            (props.token.status === "failed" ||
              props.token.status === "idle" ||
              props.token.status === "modified")
          }
        >
          <div class="border-t border-border bg-rose-500/10 px-3 py-2 text-xs text-rose-500">
            <p>{props.token.message}</p>
          </div>
        </Show>
      </div>
    </Card>
  )
}
