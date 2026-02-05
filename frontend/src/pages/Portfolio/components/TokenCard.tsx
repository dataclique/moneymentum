import { useState, useEffect, useRef } from "react"
import { Trash2, Undo2, AlertCircle } from "lucide-react"
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

export const TokenCard = ({
  token,
  displayNotional,
  maxLeverage,
  isRebalancing,
  isPrecise,
  onRemove,
  onUndoRemove,
  onSideChange,
  onLeverageChange,
  onNotionalChange,
  onWeightChange,
}: TokenCardProps) => {
  const sideColor = getSideColor(token.side)
  const borderColor =
    token.status === "deleted" ? sideColor.replace("0.8", "0.2") : sideColor
  const showProgressAnimation =
    token.status === "working" || (token.status === "deleted" && isRebalancing)
  const cardStyle = {
    borderLeftColor: borderColor,
  }
  const isLong = token.side === "buy"
  // Always show target notional based on percentage and displayNotional
  // When leverage changes, percentage stays fixed and notional is recalculated
  const usdAmount =
    displayNotional > 0
      ? ((token.percentage / 100) * displayNotional).toFixed(2)
      : "0.00"

  // Local state for notional input to allow empty field while typing
  const [notionalInput, setNotionalInput] = useState(() =>
    (token.notional ?? parseFloat(usdAmount)).toFixed(2),
  )

  // Local state for weight input to allow empty field while typing
  const [weightInput, setWeightInput] = useState(() => String(token.percentage))

  // Sync local state when token.notional changes from outside
  const externalNotional = token.notional ?? parseFloat(usdAmount)
  const prevExternalNotionalRef = useRef(externalNotional)
  const isWeightFocusedRef = useRef(false)
  const isNotionalFocusedRef = useRef(false)

  useEffect(() => {
    if (prevExternalNotionalRef.current !== externalNotional) {
      prevExternalNotionalRef.current = externalNotional
      if (!isNotionalFocusedRef.current) {
        setNotionalInput(externalNotional.toFixed(2))
      }
    }
  }, [externalNotional])

  // Sync local weight state when token.percentage changes from outside
  const prevPercentageRef = useRef(token.percentage)
  useEffect(() => {
    if (prevPercentageRef.current !== token.percentage) {
      prevPercentageRef.current = token.percentage
      if (!isWeightFocusedRef.current) {
        setWeightInput(String(token.percentage))
      }
    }
  }, [token.percentage])

  return (
    <Card
      className={twMerge(
        clsx(
          "card-border relative overflow-hidden",
          token.status === "idle" && "border-l-4",
          token.status === "filled" && "border-l-4 border-emerald-500",
          token.status === "working" && "border-l-4",
          token.status === "failed" && "border-l-4 border-rose-500",
          token.status === "untouched" && "border-l-4 border-blue-500/50",
          token.status === "modified" && "border-l-4 border-transparent",
          token.status === "deleted" && "border-l-4",
        ),
      )}
      style={cardStyle}
    >
      {showProgressAnimation && (
        <svg
          className="card-border-svg"
          height="100%"
          width="100%"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect
            rx="14"
            ry="14"
            className="card-border-line"
            height="100%"
            width="100%"
            fill="transparent"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      <div className="relative z-[2]">
        <div className="grid grid-cols-[8rem_7rem_7rem_6rem_4rem] items-center gap-2 px-3">
          {/* Coin Name and Leverage */}
          <div
            className={twMerge(
              clsx(
                "flex items-center gap-2",
                token.status === "deleted" && "opacity-50",
              ),
            )}
          >
            <span className="font-semibold" style={{ color: sideColor }}>
              {token.symbol.split("/")[0]}
            </span>
            <Dialog>
              <DialogTrigger asChild disabled={token.status === "deleted"}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto px-2 py-1 text-xs border border-border rounded-md"
                  style={{ color: sideColor }}
                  disabled={token.status === "deleted"}
                >
                  {token.leverage}x
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>Set Leverage for {token.symbol}</DialogTitle>
                  <DialogDescription>
                    Adjust the leverage for this position. Max leverage is{" "}
                    {maxLeverage?.toFixed(1)}x.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="flex items-center justify-between">
                    <span>{token.leverage}x</span>
                    <Slider
                      value={[token.leverage]}
                      onValueChange={([value]: number[]) => {
                        onLeverageChange(token.symbol, value)
                      }}
                      min={1}
                      max={maxLeverage}
                      step={1}
                      className="w-[80%]"
                    />
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Weight - percentage of total notional */}
          <div
            className={twMerge(
              clsx(
                "flex items-center justify-center gap-1",
                token.status === "deleted" && "opacity-50",
              ),
            )}
          >
            <input
              type="number"
              value={weightInput}
              onChange={event => {
                const rawValue = event.target.value
                setWeightInput(rawValue)
                const value = rawValue === "" ? 0 : parseFloat(rawValue)
                if (!Number.isNaN(value)) {
                  onWeightChange(token.symbol, value)
                }
              }}
              onFocus={() => {
                isWeightFocusedRef.current = true
              }}
              onBlur={() => {
                isWeightFocusedRef.current = false
              }}
              disabled={token.status === "deleted"}
              step={0.5}
              min={0}
              max={100}
              className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>

          {/* Position Notional */}
          <div
            className={twMerge(
              clsx(
                "flex items-center justify-center gap-1",
                token.status === "deleted" && "opacity-50",
              ),
            )}
          >
            <span className="text-sm text-muted-foreground">$</span>
            <input
              type="number"
              value={notionalInput}
              onChange={event => {
                const rawValue = event.target.value
                setNotionalInput(rawValue)
                const value = rawValue === "" ? 0 : parseFloat(rawValue)
                if (!Number.isNaN(value)) {
                  onNotionalChange(token.symbol, value)
                }
              }}
              onFocus={() => {
                isNotionalFocusedRef.current = true
              }}
              onBlur={() => {
                isNotionalFocusedRef.current = false
              }}
              disabled={token.status === "deleted"}
              step={1}
              min={0}
              className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            {(() => {
              const targetValue =
                token.targetNotional ?? token.notional ?? parseFloat(usdAmount)
              const showDeltaWarning =
                !isPrecise &&
                token.deltaInsufficient === true &&
                token.status === "modified"
              const showSmallPositionWarning =
                token.status !== "untouched" &&
                token.status !== "deleted" &&
                targetValue > 0 &&
                targetValue < MIN_USD
              const showWarning = showDeltaWarning || showSmallPositionWarning
              return (
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertCircle
                        className={twMerge(
                          "h-3.5 w-3.5 text-amber-500 ml-[2px]",
                          !showWarning && "pointer-events-none opacity-0",
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent className="space-y-2">
                      {showDeltaWarning && (
                        <p className="text-[16px]">
                          Delta $
                          {Math.abs(
                            (token.targetNotional ?? 0) -
                              (token.currentNotional ?? 0),
                          ).toFixed(2)}{" "}
                          is below ${MIN_CHANGE_DELTA} minimum.
                        </p>
                      )}
                      {showSmallPositionWarning && (
                        <p className="text-[16px] mb-[0px]">
                          Position value ${targetValue.toFixed(2)} is below $
                          {MIN_USD} minimum.
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            })()}
          </div>

          {/* Long/Short Select */}
          <div
            className={twMerge(
              clsx(token.status === "deleted" && "opacity-50"),
            )}
          >
            <select
              value={token.side}
              onChange={event => {
                onSideChange(token.symbol, event.target.value as OrderSide)
              }}
              disabled={token.status === "deleted"}
              className={twMerge(
                clsx(
                  "w-full rounded-md border bg-transparent px-2 py-1 text-sm font-medium",
                  isLong
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
          <div className="flex items-center justify-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (token.status === "deleted") {
                  onUndoRemove(token.symbol)
                } else {
                  onRemove(token.symbol)
                }
              }}
              className="h-8 w-8"
            >
              {token.status === "deleted" ? (
                <Undo2 className="h-4 w-4" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {token.message &&
          (token.status === "failed" ||
            token.status === "idle" ||
            token.status === "modified") && (
            <div className="border-t border-border bg-rose-500/10 px-3 py-2 text-xs text-rose-500">
              <p>{token.message}</p>
            </div>
          )}
      </div>
    </Card>
  )
}
