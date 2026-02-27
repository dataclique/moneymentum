import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { ChevronUp } from "lucide-react"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { useState, useEffect, useCallback, useMemo } from "react"
import { useNetwork } from "@/hooks/useNetwork"

import { usePortfolioState } from "./hooks/usePortfolioState"
import { useBeta } from "./hooks/useBeta"
import {
  useHyperliquidTickers,
  useHyperliquidFundingRates,
} from "@/hooks/useTrading"
import { ScreenerPanel } from "@/pages/Portfolio/components/ScreenerPanel"
import { PositionsPanel } from "@/pages/Portfolio/components/PositionsPanel"
import { PerformancePanel } from "@/pages/Portfolio/components/PerformancePanel"
import { StagedChangesPanel } from "@/pages/Portfolio/components/StagedChangesPanel"
import { FactorsPanel } from "@/pages/Portfolio/components/FactorsPanel"
import { RiskPanel } from "@/pages/Portfolio/components/RiskPanel"

const PRECISE_TOGGLE_STORAGE_KEY = "portfolio-precise-toggle"
const WEIGHT_REDISTRIBUTION_STORAGE_KEY = "portfolio-weight-redistribution"

const LEVERAGE_MIN = 0.001
const LEVERAGE_MAX = 5
const LEVERAGE_STEP = 0.1
const DEFAULT_LEVERAGE = 1

const PortfolioPage = () => {
  const { isNetworkSwitching } = useNetwork()
  const [isPrecise, setIsPrecise] = useState(() => {
    const stored = localStorage.getItem(PRECISE_TOGGLE_STORAGE_KEY)
    return stored === "true"
  })
  const [isWeightRedistribution, setIsWeightRedistribution] = useState(() => {
    const stored = localStorage.getItem(WEIGHT_REDISTRIBUTION_STORAGE_KEY)
    return stored !== "false"
  })

  useEffect(() => {
    localStorage.setItem(PRECISE_TOGGLE_STORAGE_KEY, String(isPrecise))
  }, [isPrecise])
  useEffect(() => {
    localStorage.setItem(
      WEIGHT_REDISTRIBUTION_STORAGE_KEY,
      String(isWeightRedistribution),
    )
  }, [isWeightRedistribution])

  const {
    accountValue,
    crossAccountLeverage,
    initialCrossAccountLeverage,
    initialTotalNotional,
    targetNotional,
    selectedTokens,
    activeTokens,
    displayNotional,
    blockingReasons,
    leverageLimitsMap,
    stagedTrades,
    disableSubmit,
    isRebalancing,
    isBalanceLoading,
    isPositionsLoading,
    handleAddToken,
    handleRemoveToken,
    handleUndoRemoveToken,
    handleSideChange,
    handleLeverageChange,
    handleNotionalChange,
    handleWeightChange,
    handleCrossAccountLeverageChange,
    handleOpenPositions,
    handleResetToInitial,
  } = usePortfolioState(isPrecise, isWeightRedistribution)

  const { beta, isLoading: isBetaLoading } = useBeta(activeTokens)

  const { data: tickersData, isLoading: isTickersLoading } =
    useHyperliquidTickers()
  const { data: fundingRatesData } = useHyperliquidFundingRates()
  const screenerSymbols = tickersData ?? []
  const selectedSymbolsSet = useMemo(
    () => new Set(selectedTokens.map(token => token.symbol)),
    [selectedTokens],
  )
  const fundingRatesByBaseSymbol = fundingRatesData ?? {}

  const [leverageInput, setLeverageInput] = useState(() =>
    crossAccountLeverage.toFixed(2),
  )
  const [isLeverageInputFocused, setIsLeverageInputFocused] = useState(false)

  useEffect(() => {
    if (!isLeverageInputFocused) {
      setLeverageInput(crossAccountLeverage.toFixed(2))
    }
  }, [crossAccountLeverage, isLeverageInputFocused])

  const applyLeverageInput = useCallback(
    (raw: string) => {
      setLeverageInput(raw)
      if (raw === "") {
        const emptyValue = initialCrossAccountLeverage ?? DEFAULT_LEVERAGE
        handleCrossAccountLeverageChange(emptyValue)
        return
      }
      const value = parseFloat(raw)
      if (!Number.isNaN(value)) {
        const clamped = Math.max(LEVERAGE_MIN, Math.min(LEVERAGE_MAX, value))
        handleCrossAccountLeverageChange(clamped)
      }
    },
    [handleCrossAccountLeverageChange, initialCrossAccountLeverage],
  )

  return (
    <>
      <header className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0 bg-muted/30">
        <div className="flex items-center gap-4">
          <span className="font-semibold">Moneymentum</span>
          <div className="h-4 border-l border-border" />
          <span className="text-muted-foreground">NAV</span>
          <span className="font-mono">${accountValue.toFixed(2)}</span>
          <span className="text-muted-foreground">Notional</span>
          <span className="font-mono">${targetNotional.toFixed(2)}</span>
          <span className="text-muted-foreground">
            TODO: effectiveLeverage.toFixed(2)x
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-muted-foreground">Δ</span>
          <span className="font-mono">TODO</span>
          <span className="text-muted-foreground">Γ</span>
          <span className="font-mono">TODO</span>
          <span className="text-muted-foreground">Θ</span>
          <span className="font-mono">TODO</span>
          <div className="h-4 border-l border-border" />
          <span className="text-muted-foreground">TODO Var</span>
          <span className="font-mono text-red-400">TODO</span>
          <kbd
            className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded cursor-pointer hover:bg-muted/80"
            onClick={() => {
              alert("TODO: add help")
            }}
          >
            ?
          </kbd>
        </div>
      </header>
      <div
        className={twMerge(
          clsx(
            "flex flex-1 min-h-0 gap-1 p-1",
            isNetworkSwitching && "pointer-events-none opacity-50",
          ),
        )}
      >
        <ScreenerPanel
          symbols={screenerSymbols}
          isLoading={isTickersLoading}
          selectedSymbols={selectedSymbolsSet}
          onAddSymbol={handleAddToken}
          fundingRatesByBaseSymbol={fundingRatesByBaseSymbol}
        />
        <div className="flex-1 min-w-0 flex gap-1 overflow-hidden">
          {/* Center: Positions */}
          <div className="shrink-0 basis-[600px] flex flex-col overflow-hidden">
            <div className="flex gap-1 min-h-0 min-w-0 flex-1">
              <PositionsPanel
                tokens={selectedTokens}
                isLoading={isPositionsLoading}
                displayNotional={displayNotional}
                leverageLimitsMap={leverageLimitsMap}
                _isRebalancing={isRebalancing}
                isPrecise={isPrecise}
                onRemove={handleRemoveToken}
                onUndoRemove={handleUndoRemoveToken}
                onSideChange={handleSideChange}
                onLeverageChange={handleLeverageChange}
                onNotionalChange={handleNotionalChange}
                onWeightChange={handleWeightChange}
                fundingRatesByBaseSymbol={fundingRatesByBaseSymbol}
              />
            </div>
            {blockingReasons.length > 0 && (
              <Card className="shrink-0">
                <CardContent className="space-y-2 text-sm text-rose-400 py-3">
                  {blockingReasons.map((reason, index) => (
                    <p key={`${reason}-${index}`}>{reason}</p>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Footer */}
            <div className="sticky bottom-0 bg-background/80 backdrop-blur mt-auto">
              <div className=" text-[12px] flex flex-wrap items-center justify-start gap-3 border-t border-border pt-3">
                <div className="font-semibold text-muted-foreground">
                  <span>Beta (vs BTC) </span>
                  {isBetaLoading ? (
                    <Skeleton className="inline-block h-4 w-16 align-middle" />
                  ) : beta !== null ? (
                    <span
                      className={twMerge(
                        clsx(
                          beta > 0 && "text-green-500",
                          beta < 0 && "text-red-500",
                        ),
                      )}
                    >
                      {beta.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  {/* Cross Account Leverage Slider */}
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-muted-foreground whitespace-nowrap">
                      Leverage:
                    </span>
                    {isBalanceLoading ? (
                      <Skeleton className="h-4 w-32" />
                    ) : (
                      <>
                        <Slider
                          value={[crossAccountLeverage]}
                          onValueChange={([selectedLeverage]) => {
                            handleCrossAccountLeverageChange(selectedLeverage)
                          }}
                          min={LEVERAGE_MIN}
                          max={LEVERAGE_MAX}
                          step={LEVERAGE_STEP}
                          className="w-32"
                        />
                        <input
                          type="number"
                          value={leverageInput}
                          onChange={leverageInputChangeEvent => {
                            applyLeverageInput(
                              leverageInputChangeEvent.target.value,
                            )
                          }}
                          onBlur={() => {
                            setIsLeverageInputFocused(false)
                          }}
                          onFocus={() => {
                            setIsLeverageInputFocused(true)
                          }}
                          min={LEVERAGE_MIN}
                          max={LEVERAGE_MAX}
                          step={LEVERAGE_STEP}
                          className="w-14 rounded-md border border-border bg-transparent px-2 py-1 text-center font-medium [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                        <span className="text-sm font-medium">x</span>
                      </>
                    )}
                  </div>
                  <div className="flex gap-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Open portfolio settings menu"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="flex items-center justify-between gap-2"
                          onSelect={dropdownSelectEvent => {
                            dropdownSelectEvent.preventDefault()
                          }}
                        >
                          <span>Precise</span>
                          <Switch
                            checked={isPrecise}
                            onCheckedChange={setIsPrecise}
                          />
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="flex items-center justify-between gap-2"
                          onSelect={dropdownSelectEvent => {
                            dropdownSelectEvent.preventDefault()
                          }}
                        >
                          <span>Redistribution of weights</span>
                          <Switch
                            checked={isWeightRedistribution}
                            onCheckedChange={setIsWeightRedistribution}
                          />
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Analysis panels (PERFORMANCE, STAGED, FACTORS, RISK) */}
          <div className="flex flex-col gap-1 min-h-0 w-full">
            <PerformancePanel />
            <div className="flex-1 flex gap-1 min-h-0">
              <StagedChangesPanel
                stagedTrades={stagedTrades}
                initialTotalNotional={initialTotalNotional}
                targetNotional={targetNotional}
                initialCrossAccountLeverage={initialCrossAccountLeverage}
                crossAccountLeverage={crossAccountLeverage}
                onRebalance={handleOpenPositions}
                isRebalancing={isRebalancing}
                disableSubmit={disableSubmit}
                onClearAll={handleResetToInitial}
              />
              <FactorsPanel />
              <RiskPanel />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default PortfolioPage
