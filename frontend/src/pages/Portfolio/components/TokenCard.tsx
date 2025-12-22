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
  MIN_USD,
  MIN_ORDER_SIZE,
} from "../hooks/usePortfolioState"

const getSideColor = (side: OrderSide) =>
  side === "buy" ? "rgba(34, 197, 94, 0.8)" : "rgba(239, 68, 68, 0.8)"

const MAX_CROSS_ACCOUNT_LEVERAGE = 5

const getTokenUsdAllocation = (token: TokenAllocation) => {
  if (token.lockedUsd !== undefined && token.lockedUsd > 0)
    return token.lockedUsd
  if (token.notional !== undefined && token.notional > 0) return token.notional
  return 0
}

interface TokenCardProps {
  token: TokenAllocation
  budgetForUi: number
  accountValue: number
  activeTokens: TokenAllocation[]
  maxLeverage: number | undefined
  onRemove: (symbol: string) => void
  onUndoRemove: (symbol: string) => void
  onSliderChange: (symbol: string, usdValue: number) => void
  onSideChange: (symbol: string, side: OrderSide) => void
  onLeverageChange: (symbol: string, leverage: number) => void
}

export const TokenCard = ({
  token,
  budgetForUi,
  accountValue,
  activeTokens,
  maxLeverage,
  onRemove,
  onUndoRemove,
  onSliderChange,
  onSideChange,
  onLeverageChange,
}: TokenCardProps) => {
  const tokenUsdValue = getTokenUsdAllocation(token)
  const effectivePercent =
    budgetForUi > 0 ? (tokenUsdValue / budgetForUi) * 100 : token.percentage
  const sideColor = getSideColor(token.side)
  const isLong = token.side === "buy"
  const usdAmount = Number.isFinite(tokenUsdValue)
    ? tokenUsdValue.toFixed(2)
    : "0.00"

  // Max total notional is 5x account value (max leverage constraint)
  const maxTotalNotional = accountValue * MAX_CROSS_ACCOUNT_LEVERAGE
  const sliderMaxValue = Math.max(maxTotalNotional, MIN_USD)
  const sliderMinValue = MIN_USD
  const sliderValue = Math.max(tokenUsdValue, sliderMinValue)

  // Sum of other tokens' allocations
  const otherTokensAllocatedUsd = activeTokens.reduce((acc, t) => {
    if (t.symbol === token.symbol) {
      return acc
    }
    return acc + getTokenUsdAllocation(t)
  }, 0)
  // Max for this token is what's left under the 5x limit
  const maxUsdForToken = Math.max(
    MIN_USD,
    maxTotalNotional - otherTokensAllocatedUsd,
  )

  return (
    <Card
      className={twMerge(
        clsx(
          "overflow-hidden",
          token.status === "idle" && "border-l-4",
          token.status === "filled" && "border-2 border-emerald-500",
          token.status === "working" && "border-animated-gradient",
          token.status === "failed" && "border-2 border-rose-500",
          token.status === "untouched" && "border-l-4 border-blue-500/50",
        ),
      )}
      style={{
        borderLeftColor:
          token.status === "idle" || token.status === "untouched"
            ? sideColor
            : "transparent",
      }}
    >
      <div
        className={twMerge(
          clsx(
            token.status === "working"
              ? "rounded-[--radius] bg-background"
              : "",
          ),
        )}
      >
        <div className="flex items-center gap-2 px-3">
          {/* Coin Name and Leverage */}
          <div
            className={twMerge(
              clsx(
                "flex w-32 items-center gap-2",
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

          {/* Percentage */}
          <div
            className={twMerge(
              clsx(
                "w-24 text-center",
                token.status === "deleted" && "opacity-50",
              ),
            )}
          >
            <span className="text-sm">{effectivePercent.toFixed(2)}%</span>
          </div>

          {/* Position Value */}
          <div
            className={twMerge(
              clsx(
                "w-24 text-center flex items-center justify-center gap-1",
                token.status === "deleted" && "opacity-50",
              ),
            )}
          >
            <span className="text-sm">${usdAmount}</span>
            {token.deltaInsufficient && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">
                      Delta $
                      {Math.abs(
                        (token.targetNotional ?? 0) -
                          (token.currentNotional ?? 0),
                      ).toFixed(2)}{" "}
                      is below ${MIN_ORDER_SIZE} minimum.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      This position won&apos;t be adjusted.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {/* Long/Short Select */}
          <div
            className={twMerge(
              clsx("w-24", token.status === "deleted" && "opacity-50"),
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

          {/* Slider */}
          <div
            className={twMerge(
              clsx("flex-1 px-2", token.status === "deleted" && "opacity-50"),
            )}
          >
            <Slider
              value={[sliderValue]}
              onValueChange={([value]) => {
                onSliderChange(token.symbol, value)
              }}
              min={sliderMinValue}
              max={sliderMaxValue}
              step={0.01}
              limitValue={maxUsdForToken}
              disabled={token.status === "deleted"}
            />
          </div>

          {/* Remove Button */}
          <div className="flex w-16 items-center justify-end gap-2">
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

        {token.status === "failed" && token.message && (
          <div className="border-t border-border bg-rose-500/10 px-3 py-2 text-xs text-rose-500">
            <p>{token.message}</p>
          </div>
        )}
      </div>
    </Card>
  )
}
