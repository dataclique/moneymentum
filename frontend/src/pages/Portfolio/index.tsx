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
import { useState, useEffect } from "react"
import { useNetwork } from "@/hooks/useNetwork"

import { usePortfolioState } from "./hooks/usePortfolioState"
import { AllocationBar } from "./components/AllocationBar"
import { TokenCard } from "./components/TokenCard"
import { TokenPickerDialog } from "./components/TokenPickerDialog"

const PRECISE_TOGGLE_STORAGE_KEY = "portfolio-precise-toggle"

const PortfolioPage = () => {
  const { isNetworkSwitching } = useNetwork()
  const [isPrecise, setIsPrecise] = useState(() => {
    const stored = localStorage.getItem(PRECISE_TOGGLE_STORAGE_KEY)
    return stored === "true"
  })

  useEffect(() => {
    localStorage.setItem(PRECISE_TOGGLE_STORAGE_KEY, String(isPrecise))
  }, [isPrecise])

  const {
    accountValue,
    crossAccountLeverage,
    totalNotional,
    selectedTokens,
    activeTokens,
    displayNotional,
    remainingPercent,
    blockingReasons,
    leverageLimitsMap,
    netExposure,
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
  } = usePortfolioState(isPrecise)

  return (
    <>
      <div
        className={twMerge(
          clsx(
            "container mx-auto flex max-w-5xl flex-col gap-4 py-4 pl-28 min-h-screen",
            isNetworkSwitching && "pointer-events-none opacity-50",
          ),
        )}
      >
        <div className="flex flex-col gap-4">
          {/* Account Summary & Add Position */}
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-6">
                {isBalanceLoading ? (
                  <>
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="h-6 w-40" />
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-muted-foreground">
                        Account Value:
                      </span>
                      <span className="text-sm font-medium">
                        ${accountValue.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-muted-foreground">
                        Total Notional:
                      </span>
                      <span className="text-sm font-medium">
                        ${totalNotional.toFixed(2)}
                      </span>
                    </div>
                  </>
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
            {isPositionsLoading ? (
              <>
                {/* Skeleton column headers */}
                <div className="flex items-center gap-2 px-3 text-xs font-semibold text-muted-foreground">
                  <div className="w-32">MARKET</div>
                  <div className="w-24 text-center">WEIGHT</div>
                  <div className="w-24 text-center">NOTIONAL</div>
                  <div className="w-24 text-center">SIDE</div>
                  <div className="w-16 text-right">ACTIONS</div>
                </div>
                {/* Skeleton token cards */}
                <div className="space-y-2">
                  {[1, 2, 3].map(i => (
                    <Card key={i} className="gap-3 py-3">
                      <CardContent className="flex items-center gap-2">
                        <Skeleton className="h-8 w-32" />
                        <Skeleton className="h-6 w-24" />
                        <Skeleton className="h-6 w-24" />
                        <Skeleton className="h-8 w-24" />
                        <Skeleton className="h-4 flex-1" />
                        <Skeleton className="h-8 w-16" />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </>
            ) : selectedTokens.length === 0 ? (
              <Card className="gap-3 py-3">
                <CardContent className="text-center text-sm text-muted-foreground">
                  Add positions using the button above to configure your
                  portfolio.
                </CardContent>
              </Card>
            ) : (
              <>
                {/* Column Headers */}
                <div className="flex items-center gap-2 px-3 text-xs font-semibold text-muted-foreground">
                  <div className="w-32">MARKET</div>
                  <div className="w-24 text-center">WEIGHT</div>
                  <div className="w-24 text-center">NOTIONAL</div>
                  <div className="w-24 text-center">SIDE</div>
                  <div className="w-16 text-right">ACTIONS</div>
                </div>
                <div className="space-y-2">
                  {selectedTokens.map(token => (
                    <TokenCard
                      key={token.symbol}
                      token={token}
                      displayNotional={displayNotional}
                      maxLeverage={leverageLimitsMap[token.symbol]}
                      onRemove={handleRemoveToken}
                      onUndoRemove={handleUndoRemoveToken}
                      onSideChange={handleSideChange}
                      onLeverageChange={handleLeverageChange}
                      onNotionalChange={handleNotionalChange}
                      onWeightChange={handleWeightChange}
                    />
                  ))}
                </div>
              </>
            )}
            {blockingReasons.length > 0 && (
              <Card className="gap-3 py-3">
                <CardContent className="space-y-2 text-sm text-rose-400">
                  {blockingReasons.map((reason, index) => (
                    <p key={`${reason}-${index}`}>{reason}</p>
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
                className={twMerge(
                  clsx(
                    netExposure > 0 && "text-green-500",
                    netExposure < 0 && "text-red-500",
                  ),
                )}
              >
                ${netExposure.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center gap-4">
              {/* Cross Account Leverage Slider */}
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-muted-foreground whitespace-nowrap">
                  Leverage:
                </span>
                {isBalanceLoading ? (
                  <Skeleton className="h-4 w-32" />
                ) : (
                  <>
                    <Slider
                      value={[crossAccountLeverage]}
                      onValueChange={([value]) => {
                        handleCrossAccountLeverageChange(value)
                      }}
                      min={0.1}
                      max={5}
                      step={0.1}
                      className="w-32"
                    />
                    <span className="w-10 text-center text-sm font-medium">
                      {crossAccountLeverage.toFixed(3)}x
                    </span>
                  </>
                )}
              </div>
              <div className="flex gap-4">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon">
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="flex items-center justify-between gap-2"
                      onSelect={e => {
                        e.preventDefault()
                      }}
                    >
                      <span>Precise</span>
                      <Switch
                        checked={isPrecise}
                        onCheckedChange={setIsPrecise}
                      />
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button onClick={handleOpenPositions} disabled={disableSubmit}>
                  {isRebalancing ? "Sending..." : "Rebalance"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AllocationBar
        tokens={activeTokens}
        remainingPercent={remainingPercent}
        totalNotional={displayNotional}
      />
    </>
  )
}

export default PortfolioPage
