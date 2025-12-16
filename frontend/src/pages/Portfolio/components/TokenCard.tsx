import { Trash2, Undo2 } from "lucide-react"
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
import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"
import type { OrderSide } from "@/hooks/useApi"
import { type TokenAllocation, MIN_USD } from "../hooks/usePortfolioState"

const getSideColor = (side: OrderSide) =>
  side === "buy" ? "rgba(34, 197, 94, 0.8)" : "rgba(239, 68, 68, 0.8)"

const getTokenUsdAllocation = (
  token: TokenAllocation,
  currentBudget: number,
) => {
  if (token.notional !== undefined && token.notional > 0) return token.notional
  if (token.lockedUsd !== undefined) return token.lockedUsd
  if (currentBudget > 0) return (token.percentage / 100) * currentBudget
  return 0
}

interface TokenCardProps {
  token: TokenAllocation
  budgetForUi: number
  activeTokens: TokenAllocation[]
  maxLeverage: number | undefined
  onRemove: (symbol: string) => void
  onUndoRemove: (symbol: string) => void
  onSliderChange: (symbol: string, usdValue: number) => void
  onSideChange: (symbol: string, side: OrderSide) => void
  onLeverageChange: (symbol: string, leverage: number) => void
}

export function TokenCard({
  token,
  budgetForUi,
  activeTokens,
  maxLeverage,
  onRemove,
  onUndoRemove,
  onSliderChange,
  onSideChange,
  onLeverageChange,
}: TokenCardProps) {
  const tokenUsdValue = getTokenUsdAllocation(token, budgetForUi)
  const effectivePercent =
    budgetForUi > 0 ? (tokenUsdValue / budgetForUi) * 100 : token.percentage
  const sideColor = getSideColor(token.side)
  const isLong = token.side === "buy"
  const usdAmount = Number.isFinite(tokenUsdValue)
    ? tokenUsdValue.toFixed(2)
    : "0.00"
  const sliderMaxValue =
    budgetForUi > 0 ? budgetForUi : Math.max(tokenUsdValue, MIN_USD)
  const sliderMinValue = Math.min(MIN_USD, sliderMaxValue)
  const sliderValue = Math.min(
    sliderMaxValue,
    Math.max(tokenUsdValue, sliderMinValue),
  )

  const otherTokensAllocatedUsd = activeTokens.reduce((acc, t) => {
    if (t.symbol === token.symbol) {
      return acc
    }
    return acc + getTokenUsdAllocation(t, budgetForUi)
  }, 0)
  const maxUsdForToken = Math.max(0, budgetForUi - otherTokensAllocatedUsd)

  return (
    <Card
      className={cn(
        "overflow-hidden",
        token.status === "idle" && "border-l-4",
        token.status === "filled" && "border-2 border-emerald-500",
        token.status === "working" && "border-animated-gradient",
        token.status === "failed" && "border-2 border-rose-500",
        token.status === "untouched" && "border-l-4 border-blue-500/50",
      )}
      style={{
        borderLeftColor:
          token.status === "idle" || token.status === "untouched"
            ? sideColor
            : "transparent",
      }}
    >
      <div
        className={cn(
          token.status === "working" ? "rounded-[--radius] bg-background" : "",
        )}
      >
        <div className="flex items-center gap-2 px-3">
          {/* Coin Name and Leverage */}
          <div
            className={cn(
              "flex w-32 items-center gap-2",
              token.status === "deleted" && "opacity-50",
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
                      onValueChange={([value]: number[]) =>
                        onLeverageChange(token.symbol, value)
                      }
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
            className={cn(
              "w-24 text-center",
              token.status === "deleted" && "opacity-50",
            )}
          >
            <span className="text-sm">{effectivePercent.toFixed(2)}%</span>
          </div>

          {/* Position Value */}
          <div
            className={cn(
              "w-24 text-center",
              token.status === "deleted" && "opacity-50",
            )}
          >
            <span className="text-sm">${usdAmount}</span>
          </div>

          {/* Long/Short Select */}
          <div
            className={cn("w-24", token.status === "deleted" && "opacity-50")}
          >
            <select
              value={token.side}
              onChange={event =>
                onSideChange(token.symbol, event.target.value as OrderSide)
              }
              disabled={token.status === "deleted"}
              className={cn(
                "w-full rounded-md border bg-transparent px-2 py-1 text-sm font-medium",
                isLong
                  ? "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400"
                  : "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400",
              )}
            >
              <option value="buy">Long</option>
              <option value="sell">Short</option>
            </select>
          </div>

          {/* Slider */}
          <div
            className={cn(
              "flex-1 px-2",
              token.status === "deleted" && "opacity-50",
            )}
          >
            <Slider
              value={[sliderValue]}
              onValueChange={([value]) => onSliderChange(token.symbol, value)}
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
              onClick={() =>
                token.status === "deleted"
                  ? onUndoRemove(token.symbol)
                  : onRemove(token.symbol)
              }
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
