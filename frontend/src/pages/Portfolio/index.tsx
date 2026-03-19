import { createSignal, createEffect, createMemo, Show } from "solid-js"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { ChevronUp } from "lucide-solid"
import { cn } from "@/lib/cn"
import { useNetwork } from "@/hooks/useNetwork"
import { WalletHeader } from "@/components/wallet-header"
import { ModeToggle } from "@/components/ui/mode-toggle"

import { usePortfolioState } from "./hooks/usePortfolioState"
import { useBeta } from "./hooks/useBeta"
import {
  useHyperliquidTickers,
  useHyperliquidFundingRates,
} from "@/hooks/useTrading"
import { ScreenerPanel } from "@/pages/Portfolio/components/ScreenerPanel"
import { PositionsPanel } from "@/pages/Portfolio/components/PositionsPanel/PositionsPanel"
import { PerformancePanel } from "@/pages/Portfolio/components/PerformancePanel"
import { StagedChangesPanel } from "@/pages/Portfolio/components/StagedChangesPanel"
import { FactorsPanel } from "@/pages/Portfolio/components/FactorsPanel"
import { RiskPanel } from "@/pages/Portfolio/components/RiskPanel"

const PRECISE_TOGGLE_STORAGE_KEY = "portfolio-precise-toggle"
const WEIGHT_REDISTRIBUTION_STORAGE_KEY = "portfolio-weight-redistribution"

const LEVERAGE_MIN = 0.001
const LEVERAGE_MAX = 5
const LEVERAGE_STEP = 0.1

const PortfolioPage = () => {
  const { isNetworkSwitching } = useNetwork()
  const [isPrecise, setIsPrecise] = createSignal(
    localStorage.getItem(PRECISE_TOGGLE_STORAGE_KEY) === "true",
  )
  const [isWeightRedistribution, setIsWeightRedistribution] = createSignal(
    localStorage.getItem(WEIGHT_REDISTRIBUTION_STORAGE_KEY) !== "false",
  )

  createEffect(() => {
    localStorage.setItem(PRECISE_TOGGLE_STORAGE_KEY, String(isPrecise()))
  })

  createEffect(() => {
    localStorage.setItem(
      WEIGHT_REDISTRIBUTION_STORAGE_KEY,
      String(isWeightRedistribution()),
    )
  })

  const portfolio = usePortfolioState(isPrecise, isWeightRedistribution)
  const activeSymbolsSet = createMemo(
    () => new Set(Object.keys(portfolio.targetPortfolio)),
  )

  const betaResult = useBeta(() => portfolio.targetPortfolio)

  const tickersQuery = useHyperliquidTickers()
  const fundingRatesQuery = useHyperliquidFundingRates()
  const screenerSymbols = () => tickersQuery.data ?? []
  const fundingRatesByBaseSymbol = () => fundingRatesQuery.data ?? {}

  const [leverageInput, setLeverageInput] = createSignal(
    portfolio.targetCrossAccountLeverage.toFixed(2),
  )

  const [isLeverageInputFocused, setIsLeverageInputFocused] =
    createSignal(false)
  createEffect(() => {
    if (!isLeverageInputFocused()) {
      setLeverageInput(portfolio.targetCrossAccountLeverage.toFixed(2))
    }
  })

  const applyLeverageInput = (raw: string) => {
    setLeverageInput(raw)
    if (raw === "") return
    const value = parseFloat(raw)
    if (!Number.isNaN(value)) {
      const clamped = Math.max(LEVERAGE_MIN, Math.min(LEVERAGE_MAX, value))
      portfolio.handleCrossAccountLeverageChange(clamped)
    }
  }

  return (
    <>
      <header class="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0 bg-muted/30">
        <div class="flex items-center gap-5">
          <span class="font-semibold">Moneymentum</span>
          <div class="h-4 border-l border-border" />
          <WalletHeader handleDisconnect={portfolio.handleDisconnect} />
          <div class="h-4 border-l border-border" />
          <div class="flex gap-1.5">
            <span class="text-muted-foreground">NAV</span>
            <span class="font-mono">${portfolio.accountValue.toFixed(2)}</span>
          </div>
          <div class="flex gap-1.5">
            <span class="text-muted-foreground">Notional</span>
            <span class="font-mono">
              ${portfolio.targetTotalNotional.toFixed(2)}
            </span>
          </div>
          <span class="text-muted-foreground">
            TODO: effectiveLeverage.toFixed(2)x
          </span>
        </div>
        <div class="flex items-center gap-4">
          <span class="text-muted-foreground">Δ</span>
          <span class="font-mono">TODO</span>
          <span class="text-muted-foreground">Γ</span>
          <span class="font-mono">TODO</span>
          <span class="text-muted-foreground">Θ</span>
          <span class="font-mono">TODO</span>
          <div class="h-4 border-l border-border" />
          <span class="text-muted-foreground">TODO Var</span>
          <span class="font-mono text-red-400">TODO</span>
          <ModeToggle />
          <kbd
            class="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded cursor-pointer hover:bg-muted/80"
            onClick={() => {
              alert("TODO: add help")
            }}
          >
            ?
          </kbd>
        </div>
      </header>
      <div
        class={cn(
          "flex flex-1 min-h-0 gap-1 p-1",
          isNetworkSwitching() && "pointer-events-none opacity-50",
        )}
      >
        <ScreenerPanel
          symbols={screenerSymbols()}
          activeSymbols={activeSymbolsSet()}
          fundingIsLoading={fundingRatesQuery.isLoading}
          onAddSymbol={portfolio.handleAddToken}
          fundingRatesByBaseSymbol={fundingRatesByBaseSymbol()}
        />
        <div class="flex-1 min-w-0 flex gap-1 overflow-hidden">
          {/* Center: Positions */}
          <div class="shrink-0 basis-[600px] flex flex-col overflow-hidden">
            <div class="flex gap-1 min-h-0 min-w-0 flex-1">
              <PositionsPanel
                currentPortfolio={portfolio.currentPortfolio}
                targetPortfolio={portfolio.targetPortfolio}
                deletedArchive={portfolio.deletedArchive}
                isLoading={portfolio.isPositionsLoading}
                fundingIsLoading={fundingRatesQuery.isLoading}
                leverageLimitsMap={portfolio.leverageLimitsMap}
                _isRebalancing={portfolio.isRebalancing}
                isPrecise={isPrecise()}
                onRemove={portfolio.handleRemoveToken}
                onUndoRemove={portfolio.handleUndoRemoveToken}
                onSideChange={portfolio.handleSideChange}
                onLeverageChange={portfolio.handleLeverageChange}
                onNotionalChange={portfolio.handleNotionalChange}
                onWeightChange={portfolio.handleWeightChange}
                fundingRatesByBaseSymbol={fundingRatesByBaseSymbol()}
                targetTotalNotional={portfolio.targetTotalNotional}
                symbolsBelowMinimum={portfolio.symbolsBelowMinimum}
                symbolsDeltaBelowMinimum={portfolio.symbolsDeltaBelowMinimum}
              />
            </div>
            {/* <Show when={portfolio.blockingReasons.length > 0}>
              <Card class="shrink-0">
                <CardContent class="space-y-2 text-sm text-rose-400 py-3">
                  <For each={portfolio.blockingReasons}>
                    {reason => <p>{reason}</p>}
                  </For>
                </CardContent>
              </Card>
            </Show> */}

            {/* Footer */}
            <div class="sticky bottom-0 bg-background/80 backdrop-blur mt-auto">
              <div class="text-[12px] border-t border-border pt-3 flex items-center">
                <div class="flex items-center gap-4 w-full">
                  {/* Cross Account Leverage Slider */}
                  <div class="flex items-center gap-3 flex-1">
                    <span class="font-semibold text-muted-foreground whitespace-nowrap">
                      Leverage
                    </span>
                    <Show
                      // TODO: we can make not isBalanceLoading logic
                      when={!portfolio.isBalanceLoading}
                      fallback={<Skeleton class="h-4 w-full" />}
                    >
                      <Slider
                        value={[portfolio.targetCrossAccountLeverage]}
                        onChange={([selectedLeverage]) => {
                          portfolio.handleCrossAccountLeverageChange(
                            selectedLeverage,
                          )
                        }}
                        minValue={LEVERAGE_MIN}
                        maxValue={LEVERAGE_MAX}
                        step={LEVERAGE_STEP}
                        class="flex-1"
                      />
                      <input
                        type="number"
                        value={leverageInput()}
                        onFocus={() => setIsLeverageInputFocused(true)}
                        onBlur={() => {
                          setIsLeverageInputFocused(false)
                          setLeverageInput(
                            portfolio.targetCrossAccountLeverage.toFixed(2),
                          )
                        }}
                        onInput={leverageInputChangeEvent => {
                          applyLeverageInput(
                            leverageInputChangeEvent.currentTarget.value,
                          )
                        }}
                        min={LEVERAGE_MIN}
                        max={LEVERAGE_MAX}
                        step={LEVERAGE_STEP}
                        class="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-center font-medium [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <span class="text-sm font-medium">x</span>
                    </Show>
                  </div>
                  <div class="flex items-center gap-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        as={Button}
                        variant="outline"
                        size="icon"
                        aria-label="Open portfolio settings menu"
                      >
                        <ChevronUp class="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          class="flex items-center justify-between gap-2"
                          closeOnSelect={false}
                        >
                          <span>Precise</span>
                          <Switch
                            checked={isPrecise()}
                            onChange={setIsPrecise}
                          />
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          class="flex items-center justify-between gap-2"
                          closeOnSelect={false}
                        >
                          <span>Redistribution of weights</span>
                          <Switch
                            checked={isWeightRedistribution()}
                            onChange={setIsWeightRedistribution}
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
          <div class="flex flex-col gap-1 min-h-0 w-full">
            <PerformancePanel />
            <div class="flex-1 flex gap-1 min-h-0">
              <div class="flex flex-[0_0_40%] min-w-0">
                <StagedChangesPanel
                  stagedTrades={portfolio.stagedTrades}
                  currentTotalNotional={portfolio.currentTotalNotional}
                  targetTotalNotional={portfolio.targetTotalNotional}
                  currentCrossAccountLeverage={
                    portfolio.currentCrossAccountLeverage
                  }
                  targetCrossAccountLeverage={
                    portfolio.targetCrossAccountLeverage
                  }
                  onRebalance={portfolio.handleRebalancePositions}
                  isRebalancing={portfolio.isRebalancing}
                  canSubmit={portfolio.canSubmit}
                  onClearAll={portfolio.handleResetToCurrent}
                />
              </div>
              <div class="flex-[0_0_25%] min-w-0">
                <FactorsPanel
                  beta={betaResult.beta}
                  isBetaLoading={betaResult.isLoading}
                />
              </div>
              <div class="flex-1 min-w-0">
                <RiskPanel />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default PortfolioPage
