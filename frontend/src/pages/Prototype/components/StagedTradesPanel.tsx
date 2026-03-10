import { useMemo } from "react"
import { twMerge } from "tailwind-merge"
import { clsx } from "clsx"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LeverageControl } from "./LeverageControl"
import { formatUsd, formatPct } from "../utils/formatters"
import { computeProjectedExposures } from "../utils/portfolio"
import type { ComputedTrade } from "../mockData"
import type { PositionsByUnderlying } from "../hooks/usePrototypeData"

interface AssetFactors {
  ticker: string
  beta: number
  momentum?: number
  volatility?: number
  spyBeta?: number
  carry?: number
}

interface StagedTradesPanelProps {
  stagedTrades: ComputedTrade[]
  leverage: number
  effectiveLeverage: number
  nav: number
  positions: PositionsByUnderlying[]
  assetFactors: AssetFactors[]
  isFocused?: boolean
  onLeverageChange: (value: number) => void
  onRemoveTrade?: (id: string) => void
  onClearAll: () => void
  onExecute: () => void
}

export const StagedTradesPanel = ({
  stagedTrades,
  leverage,
  effectiveLeverage,
  nav,
  positions,
  assetFactors,
  isFocused,
  onLeverageChange,
  onClearAll,
  onExecute,
}: StagedTradesPanelProps) => {
  const hasStaged = stagedTrades.length > 0

  // Convert ComputedTrade to StagedTrade format for computeProjectedExposures
  const legacyStagedTrades = useMemo(
    () =>
      stagedTrades.map(t => ({
        id: t.id,
        symbol: t.underlying,
        side: t.side,
        notional: t.notional,
        leverage: 1,
      })),
    [stagedTrades],
  )

  const projected = useMemo(
    () =>
      computeProjectedExposures({
        positions,
        stagedTrades: legacyStagedTrades,
        nav,
        leverage,
        assetFactors,
      }),
    [positions, legacyStagedTrades, nav, leverage, assetFactors],
  )

  // Get significant weight changes (> 0.5% delta)
  const significantWeightChanges = useMemo(() => {
    return Object.entries(projected.weightChanges)
      .filter(
        ([, change]) => Math.abs(change.projected - change.current) > 0.005,
      )
      .sort(
        (a, b) =>
          Math.abs(b[1].projected - b[1].current) -
          Math.abs(a[1].projected - a[1].current),
      )
      .slice(0, 4)
  }, [projected.weightChanges])

  return (
    <div
      className={twMerge(
        clsx(
          "border-t border-border shrink-0",
          isFocused && "ring-1 ring-primary/50 bg-primary/5",
        ),
      )}
    >
      <div className="px-2 py-1.5 bg-muted/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">STAGED CHANGES</span>
          <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
            4
          </kbd>
        </div>
        {hasStaged && (
          <button
            className="text-muted-foreground hover:text-destructive"
            onClick={e => {
              e.stopPropagation()
              onClearAll()
            }}
          >
            Clear all
          </button>
        )}
      </div>

      <LeverageControl
        leverage={leverage}
        effectiveLeverage={effectiveLeverage}
        onLeverageChange={onLeverageChange}
        isActive={isFocused}
      />

      {!hasStaged ? (
        <div className="px-2 py-3 text-muted-foreground text-center text-[10px]">
          No pending trades. Edit weights or adjust leverage to stage trades.
        </div>
      ) : (
        <div className="max-h-[200px] overflow-auto scrollbar-hide">
          {stagedTrades.map(t => {
            return (
              <div
                key={t.id}
                className="flex items-center px-2 py-1.5 border-b border-border/30"
              >
                <span
                  className={twMerge(
                    clsx(
                      "text-[10px] font-medium px-1.5 py-0.5 rounded",
                      t.side === "buy"
                        ? "bg-green-500/20 text-green-500"
                        : "bg-red-500/20 text-red-500",
                    ),
                  )}
                >
                  {t.side === "buy" ? "BUY" : "SELL"}
                </span>
                <span className="flex-1 px-2 truncate font-medium">
                  {t.underlying}
                </span>
                {t.previousWeight !== undefined &&
                  t.newWeight !== undefined && (
                    <span className="text-[9px] text-muted-foreground font-mono mr-2">
                      {formatPct(t.previousWeight)} → {formatPct(t.newWeight)}
                    </span>
                  )}
                <span className="text-muted-foreground font-mono">
                  {formatUsd(t.notional)}
                </span>
              </div>
            )
          })}

          {/* Exposure Impact Preview */}
          <div className="px-2 py-1.5 border-b border-border/30 bg-muted/20">
            <div className="text-[10px] text-muted-foreground font-medium mb-1">
              IMPACT PREVIEW
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Notional</span>
                <span className="font-mono">
                  {formatUsd(projected.currentNotional)} →{" "}
                  <span
                    className={
                      projected.notionalChange >= 0
                        ? "text-green-500"
                        : "text-red-500"
                    }
                  >
                    {formatUsd(projected.projectedNotional)}
                  </span>
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Leverage</span>
                <span className="font-mono">
                  {projected.currentEffectiveLeverage.toFixed(2)}x →{" "}
                  <span
                    className={
                      projected.effectiveLeverageChange >= 0
                        ? "text-yellow-500"
                        : "text-blue-500"
                    }
                  >
                    {projected.projectedEffectiveLeverage.toFixed(2)}x
                  </span>
                </span>
              </div>
            </div>
            {/* Factor Exposures */}
            <div className="mt-1.5 pt-1 border-t border-border/20">
              <div className="text-[9px] text-muted-foreground mb-0.5">
                Factor Exposures
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">β BTC</span>
                  <span className="font-mono">
                    {projected.factorChanges.btcBeta.current.toFixed(2)} →{" "}
                    <span
                      className={
                        Math.abs(projected.factorChanges.btcBeta.delta) > 0.01
                          ? projected.factorChanges.btcBeta.delta > 0
                            ? "text-green-500"
                            : "text-red-500"
                          : "text-muted-foreground"
                      }
                    >
                      {projected.factorChanges.btcBeta.projected.toFixed(2)}
                    </span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">β SPY</span>
                  <span className="font-mono">
                    {projected.factorChanges.spyBeta.current.toFixed(2)} →{" "}
                    <span
                      className={
                        Math.abs(projected.factorChanges.spyBeta.delta) > 0.01
                          ? projected.factorChanges.spyBeta.delta > 0
                            ? "text-green-500"
                            : "text-red-500"
                          : "text-muted-foreground"
                      }
                    >
                      {projected.factorChanges.spyBeta.projected.toFixed(2)}
                    </span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Momentum</span>
                  <span className="font-mono">
                    {projected.factorChanges.momentum.current.toFixed(2)} →{" "}
                    <span
                      className={
                        Math.abs(projected.factorChanges.momentum.delta) > 0.01
                          ? projected.factorChanges.momentum.delta > 0
                            ? "text-green-500"
                            : "text-red-500"
                          : "text-muted-foreground"
                      }
                    >
                      {projected.factorChanges.momentum.projected.toFixed(2)}
                    </span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Volatility</span>
                  <span className="font-mono">
                    {projected.factorChanges.volatility.current.toFixed(2)} →{" "}
                    <span
                      className={
                        Math.abs(projected.factorChanges.volatility.delta) >
                        0.01
                          ? projected.factorChanges.volatility.delta > 0
                            ? "text-yellow-500"
                            : "text-blue-500"
                          : "text-muted-foreground"
                      }
                    >
                      {projected.factorChanges.volatility.projected.toFixed(2)}
                    </span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Carry</span>
                  <span className="font-mono">
                    {formatPct(projected.factorChanges.carry.current)} →{" "}
                    <span
                      className={
                        Math.abs(projected.factorChanges.carry.delta) > 0.001
                          ? projected.factorChanges.carry.delta > 0
                            ? "text-green-500"
                            : "text-red-500"
                          : "text-muted-foreground"
                      }
                    >
                      {formatPct(projected.factorChanges.carry.projected)}
                    </span>
                  </span>
                </div>
              </div>
            </div>
            {significantWeightChanges.length > 0 && (
              <div className="mt-1 pt-1 border-t border-border/20">
                <div className="text-[9px] text-muted-foreground mb-0.5">
                  Weight Δ
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[9px]">
                  {significantWeightChanges.map(([symbol, change]) => (
                    <span key={symbol} className="font-mono">
                      {symbol}{" "}
                      <span
                        className={
                          change.projected > change.current
                            ? "text-green-500"
                            : "text-red-500"
                        }
                      >
                        {formatPct(change.current)} →{" "}
                        {formatPct(change.projected)}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="p-2">
            <Button size="sm" className="w-full h-7" onClick={onExecute}>
              <Send className="h-3 w-3 mr-1.5" />
              Execute {stagedTrades.length} trade
              {stagedTrades.length > 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
