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
import { useState, useEffect, useCallback, useRef } from "react"
import { useNetwork } from "@/hooks/useNetwork"
import type { TokenAllocation } from "./hooks/usePortfolioState"
import {
  SortableHeaderButton,
  type SortColumn,
  type SortDirection,
  type SortState,
} from "./components/SortableHeaderButton"

import { usePortfolioState } from "./hooks/usePortfolioState"
import { AllocationBar } from "./components/AllocationBar"
import { TokenCard } from "./components/TokenCard"
import { TokenPickerDialog } from "./components/TokenPickerDialog"

const PRECISE_TOGGLE_STORAGE_KEY = "portfolio-precise-toggle"
const WEIGHT_REDISTRIBUTION_STORAGE_KEY = "portfolio-weight-redistribution"

const LEVERAGE_MIN = 0.001
const LEVERAGE_MAX = 5
const LEVERAGE_STEP = 0.1
const DEFAULT_LEVERAGE = 1

export const sortTokens = (tokens: TokenAllocation[], sortState: SortState) => {
  if (!sortState) {
    return tokens
  }

  const directionMultiplier = sortState.direction === "asc" ? 1 : -1

  const getComparable = (token: TokenAllocation) => {
    switch (sortState.column) {
      case "market": {
        const [base] = token.symbol.split("/")
        return base.toUpperCase()
      }
      case "weight":
        return token.percentage
      case "notional":
        return token.notional ?? token.targetNotional ?? 0
      case "side":
        return token.side === "buy" ? 1 : 0
      default:
        return 0
    }
  }

  return [...tokens].sort((a, b) => {
    const aValue = getComparable(a)
    const bValue = getComparable(b)

    if (aValue < bValue) return -1 * directionMultiplier
    if (aValue > bValue) return 1 * directionMultiplier

    const [aBase] = a.symbol.split("/")
    const [bBase] = b.symbol.split("/")
    return aBase.localeCompare(bBase) * directionMultiplier
  })
}

const PortfolioPage = () => {
  const { isNetworkSwitching } = useNetwork()
  const [sortState, setSortState] = useState<SortState>(null)
  const [sortedSymbols, setSortedSymbols] = useState<string[] | null>(null)
  const lastSortSnapshotRef = useRef<string | null>(null)
  const [needsResort, setNeedsResort] = useState<{
    weight: boolean
    notional: boolean
    side: boolean
  }>({
    weight: false,
    notional: false,
    side: false,
  })
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
    targetNotional,
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
  } = usePortfolioState(isPrecise, isWeightRedistribution)

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

  const applySorting = useCallback(
    (nextSortState: SortState) => {
      if (!nextSortState) {
        setSortedSymbols(null)
        lastSortSnapshotRef.current = null
        return
      }

      const sortedTokens = sortTokens(selectedTokens, nextSortState)
      setSortedSymbols(sortedTokens.map(token => token.symbol))

      const snapshot = sortedTokens
        .map(token => {
          switch (nextSortState.column) {
            case "market": {
              const [base] = token.symbol.split("/")
              return `${token.symbol}:${base.toUpperCase()}`
            }
            case "weight":
              return `${token.symbol}:${token.percentage}`
            case "notional": {
              const value = token.notional ?? token.targetNotional ?? 0
              return `${token.symbol}:${value}`
            }
            case "side":
              return `${token.symbol}:${token.side}`
            default:
              return token.symbol
          }
        })
        .join("|")

      lastSortSnapshotRef.current = snapshot
    },
    [selectedTokens],
  )

  const handleHeaderClick = (column: SortColumn) => {
    setSortState(previous => {
      if (!previous || previous.column !== column) {
        const next = { column, direction: "desc" as SortDirection }
        applySorting(next)
        setNeedsResort({ weight: false, notional: false, side: false })
        return next
      }

      if (previous.direction === "desc") {
        const next = { column, direction: "asc" as SortDirection }
        applySorting(next)
        setNeedsResort({ weight: false, notional: false, side: false })
        return next
      }

      applySorting(null)
      setNeedsResort({ weight: false, notional: false, side: false })
      return null
    })
  }

  const handleResort = (column: SortColumn) => {
    if (!sortState || sortState.column !== column) {
      return
    }

    applySorting(sortState)
    if (column === "weight") {
      setNeedsResort(current => ({ ...current, weight: false }))
    }
    if (column === "notional") {
      setNeedsResort(current => ({ ...current, notional: false }))
    }
    if (column === "side") {
      setNeedsResort(current => ({ ...current, side: false }))
    }
  }

  const handleWeightChangeWithSort = (symbol: string, percentage: number) => {
    handleWeightChange(symbol, percentage)
    if (sortState?.column === "weight") {
      setNeedsResort(current => ({ ...current, weight: true }))
    }
  }

  const handleNotionalChangeWithSort = (symbol: string, notional: number) => {
    handleNotionalChange(symbol, notional)
    if (sortState?.column === "notional") {
      setNeedsResort(current => ({ ...current, notional: true }))
    }
  }

  useEffect(() => {
    if (!sortState || !sortedSymbols) {
      return
    }

    const sortedTokens = sortTokens(selectedTokens, sortState)
    const snapshot = sortedTokens
      .map(token => {
        switch (sortState.column) {
          case "market": {
            const [base] = token.symbol.split("/")
            return `${token.symbol}:${base.toUpperCase()}`
          }
          case "weight":
            return `${token.symbol}:${token.percentage}`
          case "notional": {
            const value = token.notional ?? token.targetNotional ?? 0
            return `${token.symbol}:${value}`
          }
          case "side":
            return `${token.symbol}:${token.side}`
          default:
            return token.symbol
        }
      })
      .join("|")

    if (
      lastSortSnapshotRef.current !== null &&
      snapshot !== lastSortSnapshotRef.current
    ) {
      if (sortState.column === "weight") {
        setNeedsResort(current => ({ ...current, weight: true }))
      }
      if (sortState.column === "notional") {
        setNeedsResort(current => ({ ...current, notional: true }))
      }
      if (sortState.column === "side") {
        setNeedsResort(current => ({ ...current, side: true }))
      }
    }
  }, [selectedTokens, sortState, sortedSymbols])

  const tokensToRender =
    sortState && sortedSymbols
      ? sortedSymbols
          .map(symbol => selectedTokens.find(token => token.symbol === symbol))
          .filter((token): token is TokenAllocation => Boolean(token))
      : selectedTokens

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
                        ${targetNotional.toFixed(2)}
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
          <div className="space-y-2 self-start w-fit">
            {isPositionsLoading ? (
              <>
                {/* Skeleton column headers */}
                <div className="grid grid-cols-[8rem_7rem_7rem_6rem_4rem] gap-2 px-3 text-xs font-semibold text-muted-foreground">
                  <div>MARKET</div>
                  <div className="text-center">WEIGHT</div>
                  <div className="text-center">NOTIONAL</div>
                  <div className="text-center">SIDE</div>
                  <div className="text-right">ACTIONS</div>
                </div>
                {/* Skeleton token cards */}
                <div className="space-y-2">
                  {[1, 2, 3].map(i => (
                    <Card key={i} className="gap-3 py-3">
                      <CardContent className="grid grid-cols-[8rem_7rem_7rem_6rem_4rem] items-center gap-2 px-3">
                        <Skeleton className="h-8 w-32" />
                        <Skeleton className="h-6 w-20" />
                        <Skeleton className="h-6 w-20" />
                        <Skeleton className="h-8 w-20" />
                        <Skeleton className="h-8 w-8" />
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
                <div className="grid grid-cols-[8rem_7rem_7rem_6rem_4rem] gap-2 px-3 text-xs font-semibold text-muted-foreground">
                  <SortableHeaderButton
                    label="MARKET"
                    column="market"
                    sortState={sortState}
                    onHeaderClick={handleHeaderClick}
                    className="text-left"
                  />
                  <SortableHeaderButton
                    label="WEIGHT"
                    column="weight"
                    sortState={sortState}
                    onHeaderClick={handleHeaderClick}
                    className="justify-center"
                    needsResort={needsResort.weight}
                    onResort={handleResort}
                  />
                  <SortableHeaderButton
                    label="NOTIONAL"
                    column="notional"
                    sortState={sortState}
                    onHeaderClick={handleHeaderClick}
                    className="justify-center"
                    needsResort={needsResort.notional}
                    onResort={handleResort}
                  />
                  <SortableHeaderButton
                    label="SIDE"
                    column="side"
                    sortState={sortState}
                    onHeaderClick={handleHeaderClick}
                    className="justify-center"
                    needsResort={needsResort.side}
                    onResort={handleResort}
                  />
                  <div className="text-right">ACTIONS</div>
                </div>
                <div className="space-y-2">
                  {tokensToRender.map(token => (
                    <TokenCard
                      key={token.symbol}
                      token={token}
                      displayNotional={displayNotional}
                      maxLeverage={leverageLimitsMap[token.symbol]}
                      isRebalancing={isRebalancing}
                      isPrecise={isPrecise}
                      onRemove={handleRemoveToken}
                      onUndoRemove={handleUndoRemoveToken}
                      onSideChange={handleSideChange}
                      onLeverageChange={handleLeverageChange}
                      onNotionalChange={handleNotionalChangeWithSort}
                      onWeightChange={handleWeightChangeWithSort}
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
                      min={LEVERAGE_MIN}
                      max={LEVERAGE_MAX}
                      step={LEVERAGE_STEP}
                      className="w-32"
                    />
                    <input
                      type="number"
                      value={leverageInput}
                      onChange={event => {
                        applyLeverageInput(event.target.value)
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
                      className="w-14 rounded-md border border-border bg-transparent px-2 py-1 text-center text-sm font-medium [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <span className="text-sm font-medium">x</span>
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
                    <DropdownMenuItem
                      className="flex items-center justify-between gap-2"
                      onSelect={e => {
                        e.preventDefault()
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
