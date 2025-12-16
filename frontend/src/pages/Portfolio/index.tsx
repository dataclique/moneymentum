import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { useNetwork } from "@/hooks/useNetwork"

import { usePortfolioState, MIN_USD } from "./hooks/usePortfolioState"
import { AllocationBar } from "./components/AllocationBar"
import { TokenCard } from "./components/TokenCard"
import { TokenPickerDialog } from "./components/TokenPickerDialog"

const PortfolioPage = () => {
  const { isNetworkSwitching } = useNetwork()

  const {
    budgetInput,
    budgetError,
    selectedTokens,
    activeTokens,
    budgetForUi,
    maxBudget,
    remainingPercent,
    blockingReasons,
    leverageLimitsMap,
    netExposure,
    disableSubmit,
    isRebalancing,
    handleAddToken,
    handleRemoveToken,
    handleUndoRemoveToken,
    handleSliderChange,
    handleSideChange,
    handleLeverageChange,
    handleBudgetInputChange,
    handleBudgetInputBlur,
    handleOpenPositions,
  } = usePortfolioState()

  return (
    <>
      <div
        className={cn(
          "container mx-auto flex max-w-5xl flex-col gap-4 py-4 pl-28 min-h-screen",
          isNetworkSwitching && "pointer-events-none opacity-50",
        )}
      >
        <div className="flex flex-col gap-4">
          {/* Budget Controls */}
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-semibold text-muted-foreground">
                  Total Budget:
                </span>
                <div className="w-40">
                  <input
                    type="number"
                    min={MIN_USD}
                    max={maxBudget}
                    value={budgetInput}
                    onChange={e => {
                      handleBudgetInputChange(e.target.value)
                    }}
                    onBlur={handleBudgetInputBlur}
                    className={cn(
                      "w-full rounded-md border border-border bg-background px-3 py-2 text-sm",
                      budgetError && "border-rose-500",
                    )}
                  />
                </div>
                <span className="text-sm text-muted-foreground">USDC</span>
                {budgetError && (
                  <span className="text-xs text-rose-400">{budgetError}</span>
                )}
              </div>
              <TokenPickerDialog
                selectedTokens={selectedTokens}
                onAddToken={handleAddToken}
              />
            </CardContent>
          </Card>

          {/* Token Allocation Cards */}
          <div className="w-full space-y-2">
            {selectedTokens.length === 0 ? (
              <Card className="gap-3 py-3">
                <CardContent className="text-center text-sm text-muted-foreground">
                  Add tokens from the button on the top right to configure
                  allocations.
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Column Headers */}
                <div className="flex items-center gap-2 px-3 text-xs font-semibold text-muted-foreground">
                  <div className="w-32">COIN</div>
                  <div className="w-24 text-center">PERCENTAGE</div>
                  <div className="w-24 text-center">VALUE</div>
                  <div className="w-24 text-center">SIDE</div>
                  <div className="flex-1 px-2 text-center">ALLOCATION</div>
                  <div className="w-16 text-right">ACTIONS</div>
                </div>
                <div className="space-y-2">
                  {selectedTokens.map(token => (
                    <TokenCard
                      key={token.symbol}
                      token={token}
                      budgetForUi={budgetForUi}
                      activeTokens={activeTokens}
                      maxLeverage={leverageLimitsMap[token.symbol]}
                      onRemove={handleRemoveToken}
                      onUndoRemove={handleUndoRemoveToken}
                      onSliderChange={handleSliderChange}
                      onSideChange={handleSideChange}
                      onLeverageChange={handleLeverageChange}
                    />
                  ))}
                </div>
              </>
            )}
            {blockingReasons.length > 0 && (
              <Card className="gap-3 py-3">
                <CardContent className="space-y-2 text-sm text-rose-400">
                  {blockingReasons.map(reason => (
                    <p key={reason}>{reason}</p>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-background/80 py-3 backdrop-blur mt-auto">
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div className="text-sm font-semibold text-muted-foreground">
              <span>Net Exposure: </span>
              <span
                className={cn(
                  netExposure > 0 && "text-green-500",
                  netExposure < 0 && "text-red-500",
                )}
              >
                ${netExposure.toFixed(2)}
              </span>
            </div>
            <Button onClick={handleOpenPositions} disabled={disableSubmit}>
              {isRebalancing ? "Sending..." : "Rebalance"}
            </Button>
          </div>
        </div>
      </div>

      <AllocationBar
        tokens={activeTokens}
        remainingPercent={remainingPercent}
        budget={budgetForUi}
      />
    </>
  )
}

export default PortfolioPage
