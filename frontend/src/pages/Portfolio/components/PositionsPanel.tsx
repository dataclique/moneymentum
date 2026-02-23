import { useState, useEffect, useRef } from "react"
import Decimal from "decimal.js"
import { Trash2, Undo2, AlertCircle } from "lucide-react"
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
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { OrderSide } from "@/hooks/useTrading"
import {
  type TokenAllocation,
  MIN_CHANGE_DELTA,
  MIN_USD,
} from "../hooks/usePortfolioState"

interface PositionsPanelProps {
  tokens: TokenAllocation[]
  isLoading: boolean
  displayNotional: number
  leverageLimitsMap: Record<string, number | undefined>
  isRebalancing: boolean
  isPrecise: boolean
  onRemove: (symbol: string) => void
  onUndoRemove: (symbol: string) => void
  onSideChange: (symbol: string, side: OrderSide) => void
  onLeverageChange: (symbol: string, leverage: number) => void
  onNotionalChange: (symbol: string, notional: number) => void
  onWeightChange: (symbol: string, percentage: number) => void
}

const getSideBadgeClass = (side: OrderSide) =>
  side === "buy"
    ? "bg-green-500/20 text-green-500"
    : "bg-red-500/20 text-red-500"

function PositionsTableRow({
  token,
  displayNotional,
  maxLeverage,
  isPrecise,
  onRemove,
  onUndoRemove,
  onSideChange,
  onLeverageChange,
  onNotionalChange,
  onWeightChange,
}: {
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
}) {
  const usdAmount =
    displayNotional > 0
      ? new Decimal(token.percentage)
          .div(100)
          .mul(displayNotional)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toFixed(2)
      : "0.00"
  const [weightInput, setWeightInput] = useState(() => String(token.percentage))
  const [notionalInput, setNotionalInput] = useState(() =>
    (token.notional ?? parseFloat(usdAmount)).toFixed(2),
  )
  const externalNotional = token.notional ?? parseFloat(usdAmount)
  const prevNotionalRef = useRef(externalNotional)
  const prevPercentageRef = useRef(token.percentage)

  useEffect(() => {
    if (prevNotionalRef.current !== externalNotional) {
      console.log(token.symbol)
      console.log(externalNotional)
      prevNotionalRef.current = externalNotional
      setNotionalInput(externalNotional.toFixed(2))
    }
  }, [externalNotional])
  useEffect(() => {
    if (prevPercentageRef.current !== token.percentage) {
      prevPercentageRef.current = token.percentage
      setWeightInput(String(token.percentage))
    }
  }, [token.percentage])

  const isLong = token.side === "buy"
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
    new Decimal(targetValue).plus(0.01).lt(MIN_USD)

  console.log(token.symbol, targetValue, token.status)
  const showWarning = showDeltaWarning || showSmallPositionWarning

  return (
    <tr
      className={twMerge(
        clsx(
          "border-b border-border/30 hover:bg-muted/20",
          token.status === "deleted" && "opacity-50",
        ),
      )}
    >
      <td className="px-2 py-1 font-medium">
        <span className="font-medium">{token.symbol.split("/")[0]}</span>
        <Dialog>
          <DialogTrigger asChild disabled={token.status === "deleted"}>
            <Button
              variant="ghost"
              size="sm"
              className="ml-1 h-auto px-1.5 py-0 text-[10px] font-mono border border-border rounded"
              disabled={token.status === "deleted"}
            >
              {token.leverage}x
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Leverage {token.symbol}</DialogTitle>
              <DialogDescription>
                Max leverage {maxLeverage?.toFixed(1)}x
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px]">{token.leverage}x</span>
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
      </td>
      <td className="px-2 py-1">
        <select
          value={token.side}
          onChange={e =>
            onSideChange(token.symbol, e.target.value as OrderSide)
          }
          disabled={token.status === "deleted"}
          className={twMerge(
            "text-[10px] font-medium px-1.5 py-0.5 rounded border-0 bg-transparent cursor-pointer",
            getSideBadgeClass(token.side),
          )}
        >
          <option value="buy">LONG</option>
          <option value="sell">SHORT</option>
        </select>
      </td>
      <td className="px-2 py-1 text-right">
        <input
          type="number"
          value={weightInput}
          onChange={e => {
            const raw = e.target.value
            setWeightInput(raw)
            const value = raw === "" ? 0 : parseFloat(raw)
            if (!Number.isNaN(value)) onWeightChange(token.symbol, value)
          }}
          disabled={token.status === "deleted"}
          step={0.5}
          min={0}
          max={100}
          className="w-12 text-right font-mono text-[11px] rounded border border-border bg-transparent px-1 py-0.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="text-muted-foreground text-[10px] ml-0.5">%</span>
      </td>
      <td className="px-2 py-1 text-right">
        <span className="text-muted-foreground text-[10px]">$</span>
        <input
          type="number"
          value={notionalInput}
          onChange={e => {
            const raw = e.target.value
            setNotionalInput(raw)
            const value = raw === "" ? 0 : parseFloat(raw)
            if (!Number.isNaN(value)) onNotionalChange(token.symbol, value)
          }}
          disabled={token.status === "deleted"}
          step={1}
          min={0}
          className="w-16 text-right font-mono text-[11px] rounded border border-border bg-transparent px-1 py-0.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertCircle
                className={twMerge(
                  "inline-block h-3 w-3 text-amber-500 ml-0.5 align-middle",
                  !showWarning && "pointer-events-none opacity-0",
                )}
              />
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              {showDeltaWarning && (
                <p>
                  Delta $
                  {Math.abs(
                    (token.targetNotional ?? 0) - (token.currentNotional ?? 0),
                  ).toFixed(2)}{" "}
                  below ${MIN_CHANGE_DELTA} minimum.
                </p>
              )}
              {showSmallPositionWarning && (
                <p>
                  Position ${targetValue.toFixed(2)} below ${MIN_USD} minimum.
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </td>
      <td className="px-2 py-1 text-right font-mono text-[11px] text-muted-foreground">
        0%
      </td>
      <td className="px-2 py-1 text-right font-mono text-[11px] text-muted-foreground">
        0
      </td>
      <td className="px-2 py-1 text-right font-mono text-[11px] text-muted-foreground">
        0
      </td>
      <td className="px-2 py-1 text-right font-mono text-[11px] text-muted-foreground">
        0
      </td>
      <td className="px-2 py-1 text-right">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() =>
            token.status === "deleted"
              ? onUndoRemove(token.symbol)
              : onRemove(token.symbol)
          }
        >
          {token.status === "deleted" ? (
            <Undo2 className="h-3 w-3" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
      </td>
    </tr>
  )
}

export const PositionsPanel = ({
  tokens,
  isLoading,
  displayNotional,
  leverageLimitsMap,
  isRebalancing,
  isPrecise,
  onRemove,
  onUndoRemove,
  onSideChange,
  onLeverageChange,
  onNotionalChange,
  onWeightChange,
}: PositionsPanelProps) => {
  return (
    <div className="flex flex-col rounded border border-border min-h-0 max-h-[calc(100vh-4rem)] w-full max-w-[540px] shrink-0">
      <div className="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">POSITIONS</span>
          <span className="text-muted-foreground text-[11px]">
            {tokens.length} position{tokens.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto scrollbar-hide">
        {isLoading ? (
          <div className="p-2 space-y-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : tokens.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-[11px]">
            Add positions from the screener.
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-muted/90 z-10">
              <tr className="text-muted-foreground text-[10px]">
                <th className="px-2 py-1 text-left font-medium">Asset</th>
                <th className="px-2 py-1 text-left font-medium">Side</th>
                <th className="px-2 py-1 text-right font-medium">Weight</th>
                <th className="px-2 py-1 text-right font-medium">Notional</th>
                <th className="px-2 py-1 text-right font-medium">Rate</th>
                <th className="px-2 py-1 text-right font-medium">Δ</th>
                <th className="px-2 py-1 text-right font-medium">Γ</th>
                <th className="px-2 py-1 text-right font-medium">Θ</th>
                <th className="px-2 py-1 text-right font-medium w-10"></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map(token => (
                <PositionsTableRow
                  key={token.symbol}
                  token={token}
                  displayNotional={displayNotional}
                  maxLeverage={leverageLimitsMap[token.symbol]}
                  isPrecise={isPrecise}
                  onRemove={onRemove}
                  onUndoRemove={onUndoRemove}
                  onSideChange={onSideChange}
                  onLeverageChange={onLeverageChange}
                  onNotionalChange={onNotionalChange}
                  onWeightChange={onWeightChange}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
