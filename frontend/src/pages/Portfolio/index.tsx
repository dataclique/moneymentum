import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  useHyperliquidBalance,
  useHyperliquidTickers,
  useRebalanceHyperliquidPositions,
  useHyperliquidPositions,
  useBudgetPreference,
  useSaveBudgetPreference,
  type OrderSide,
  type OrderStatus,
} from "@/hooks/useApi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type AllocationStatus = OrderStatus["status"] | "idle"

interface TokenAllocation {
  symbol: string
  percentage: number
  side: OrderSide
  status: AllocationStatus
  message?: string | null
  notional?: number // Actual position value in USD (from exchange)
  lockedUsd?: number // User-defined USD allocation that persists across budget edits
}

const STORAGE_KEY = "portfolio-allocation-state"
const MIN_USD = 11

const getSideColor = (side: OrderSide) => {
  return side === "buy"
    ? "rgba(34, 197, 94, 0.8)" // green-500 for long
    : "rgba(239, 68, 68, 0.8)" // red-500 for short
}

const getTokenUsdAllocation = (
  token: TokenAllocation,
  currentBudget: number,
) => {
  if (token.notional !== undefined && token.notional > 0) {
    return token.notional
  }
  if (token.lockedUsd !== undefined) {
    return token.lockedUsd
  }
  if (currentBudget > 0) {
    return (token.percentage / 100) * currentBudget
  }
  return 0
}

const recalcPercentagesFromLockedValues = (
  tokens: TokenAllocation[],
  currentBudget: number,
) => {
  if (!tokens.length || currentBudget <= 0) {
    return tokens
  }

  let changed = false
  const updatedTokens = tokens.map(token => {
    const referenceUsd =
      token.notional !== undefined && token.notional > 0
        ? token.notional
        : token.lockedUsd
    if (referenceUsd !== undefined && referenceUsd >= 0) {
      const nextPercent = parseFloat(
        ((referenceUsd / currentBudget) * 100).toFixed(2),
      )
      if (
        Number.isFinite(nextPercent) &&
        Math.abs(nextPercent - token.percentage) > 0.01
      ) {
        changed = true
        return {
          ...token,
          percentage: nextPercent,
        }
      }
    }
    return token
  })

  return changed ? updatedTokens : tokens
}

function PortfolioPage() {
  const [searchTerm, setSearchTerm] = useState("")
  const [budget, setBudget] = useState(0)
  const [budgetInput, setBudgetInput] = useState<string>("")
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const [isBudgetInitialized, setIsBudgetInitialized] = useState(false)
  const [selectedTokens, setSelectedTokens] = useState<TokenAllocation[]>([])
  const [positionsLoadedFromExchange, setPositionsLoadedFromExchange] =
    useState(false)
  const lastSufficientBudgetRef = useRef(0)

  const {
    data: tickersData,
    isLoading: isTickersLoading,
    error: tickersError,
  } = useHyperliquidTickers()
  const {
    data: balanceData,
    isLoading: isBalanceLoading,
    error: balanceError,
  } = useHyperliquidBalance()
  const { data: positionsData, isLoading: isPositionsLoading } =
    useHyperliquidPositions()
  const { data: budgetPreferenceData, isLoading: isBudgetPreferenceLoading } =
    useBudgetPreference()
  const saveBudgetPreferenceMutation = useSaveBudgetPreference()
  const rebalancePositionsMutation = useRebalanceHyperliquidPositions()

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (typeof parsed?.budget === "number") {
          setBudget(parsed.budget)
          setBudgetInput(parsed.budget.toString())
          setIsBudgetInitialized(true)
        }
        if (Array.isArray(parsed?.tokens)) {
          setSelectedTokens(
            parsed.tokens.map((token: TokenAllocation) => ({
              ...token,
              status: "idle",
              message: null,
            })),
          )
        }
      } catch (error) {
        console.error("Failed to parse saved allocations", error)
      }
    }
  }, [])

  useEffect(() => {
    if (isBudgetInitialized || positionsLoadedFromExchange) {
      return
    }
    // Priority: budget preference > balance
    if (
      !isBudgetPreferenceLoading &&
      typeof budgetPreferenceData?.budget === "number" &&
      budgetPreferenceData.budget > 0
    ) {
      setBudget(budgetPreferenceData.budget)
      setBudgetInput(budgetPreferenceData.budget.toString())
      setIsBudgetInitialized(true)
    } else if (typeof balanceData?.perp_usdc_balance === "number") {
      setBudget(balanceData.perp_usdc_balance)
      setBudgetInput(balanceData.perp_usdc_balance.toString())
      setIsBudgetInitialized(true)
    }
  }, [
    balanceData,
    budgetPreferenceData,
    isBudgetInitialized,
    isBudgetPreferenceLoading,
    positionsLoadedFromExchange,
  ])

  // Load current positions from exchange (only once on initial load)
  useEffect(() => {
    if (
      isPositionsLoading ||
      !positionsData?.positions ||
      positionsLoadedFromExchange
    ) {
      return
    }
    // Only load positions if we don't have any in local storage
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed?.tokens) && parsed.tokens.length > 0) {
          setPositionsLoadedFromExchange(true)
          return // Don't override if user already has positions configured
        }
      } catch {
        // Continue to load from exchange
      }
    }

    // Load positions from exchange
    const loadedTokens: TokenAllocation[] = positionsData.positions.map(
      pos => ({
        symbol: pos.symbol,
        percentage: parseFloat(pos.percentage.toFixed(2)),
        side: pos.side,
        status: "idle",
        message: null,
        notional: pos.notional, // Store actual notional value
      }),
    )

    if (loadedTokens.length > 0) {
      setSelectedTokens(loadedTokens)
      // Update budget to total spent (sum of position notional values)
      const totalSpent = positionsData.total_notional
      if (totalSpent > 0) {
        setBudget(totalSpent)
        setBudgetInput(totalSpent.toString())
        setIsBudgetInitialized(true)
        // Save this as budget preference
        saveBudgetPreferenceMutation.mutate({ budget: totalSpent })
      }
      setPositionsLoadedFromExchange(true)
    }
  }, [
    positionsData,
    isPositionsLoading,
    saveBudgetPreferenceMutation,
    positionsLoadedFromExchange,
  ])

  useEffect(() => {
    const payload = {
      budget,
      tokens: selectedTokens.map(({ symbol, percentage, side, lockedUsd }) => ({
        symbol,
        percentage,
        side,
        lockedUsd,
      })),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [budget, selectedTokens])

  const tickers = tickersData?.data ?? []
  const filteredTickers = useMemo(() => {
    if (!searchTerm.trim()) {
      return tickers.slice(0, 50)
    }
    return tickers.filter(ticker =>
      ticker.toLowerCase().includes(searchTerm.toLowerCase()),
    )
  }, [tickers, searchTerm])

  const totalPercent = selectedTokens.reduce(
    (acc, token) => acc + token.percentage,
    0,
  )
  const remainingPercent = Math.max(0, 100 - totalPercent)
  // Calculate total spent budget from actual position notional values
  const totalSpentBudget = selectedTokens.reduce(
    (acc, token) => acc + (token.notional || 0),
    0,
  )
  // Use spent budget for display if all positions have notional values and budget matches
  // Otherwise use budget (user might have changed it)
  const hasAllNotionalValues =
    selectedTokens.length > 0 &&
    selectedTokens.every(
      token => token.notional !== undefined && token.notional > 0,
    )
  const displayBudget =
    hasAllNotionalValues && Math.abs(totalSpentBudget - budget) < 0.01 // Budget matches total spent (within 1 cent)
      ? totalSpentBudget
      : budget
  const requiredBudgetForTokens = selectedTokens.length * MIN_USD
  const budgetIsPositive = budget > 0
  const budgetBelowMinimum =
    selectedTokens.length > 0 && budgetIsPositive && budget < MIN_USD
  const insufficientBudgetForTokens =
    selectedTokens.length > 0 &&
    budgetIsPositive &&
    requiredBudgetForTokens > budget
  useEffect(() => {
    if (budget > 0 && budget >= requiredBudgetForTokens) {
      lastSufficientBudgetRef.current = budget
    }
  }, [budget, requiredBudgetForTokens])
  const budgetForUi = useMemo(() => {
    if (selectedTokens.length === 0) {
      return budget > 0 ? budget : lastSufficientBudgetRef.current || 0
    }
    if (budget > 0 && budget >= requiredBudgetForTokens) {
      return budget
    }
    if (lastSufficientBudgetRef.current > 0) {
      return lastSufficientBudgetRef.current
    }
    if (budget > 0) {
      return budget
    }
    return Math.max(requiredBudgetForTokens, MIN_USD)
  }, [budget, requiredBudgetForTokens, selectedTokens.length])
  const minPercentOfBudget =
    budgetForUi > 0 ? Math.min(100, (MIN_USD / budgetForUi) * 100) : 0
  const minPercentFloor = budgetForUi >= MIN_USD ? minPercentOfBudget : 0
  const hasBlockingBudgetIssue =
    budgetBelowMinimum || insufficientBudgetForTokens
  const blockingReasons: string[] = []
  if (budgetBelowMinimum) {
    blockingReasons.push(
      "Minimum portfolio budget is $11. Increase the amount to allocate capital.",
    )
  }
  if (insufficientBudgetForTokens) {
    blockingReasons.push(
      `Delete some tokens or make bigger budget (need at least $${requiredBudgetForTokens}).`,
    )
  }

  // Recalculate percentages when budget changes (for tokens with locked USD or notional values)
  useEffect(() => {
    if (budgetForUi <= 0) {
      return
    }
    setSelectedTokens(prevTokens =>
      recalcPercentagesFromLockedValues(prevTokens, budgetForUi),
    )
  }, [budgetForUi])

  // Enforce minimum percentage constraints
  useEffect(() => {
    setSelectedTokens(prevTokens => {
      if (!prevTokens.length || budgetForUi <= 0) {
        return prevTokens
      }
      const minPercent = minPercentFloor
      if (minPercent === 0) {
        return prevTokens
      }

      let changed = false
      const adjustedTokens = prevTokens.map(token => {
        // Only enforce minimum for tokens without notional (user-added tokens)
        if (token.notional !== undefined && token.notional > 0) {
          return token // Keep tokens with notional as-is (they represent actual positions)
        }
        if (token.percentage >= minPercent) {
          return token
        }
        changed = true
        const nextPercent = parseFloat(Math.min(100, minPercent).toFixed(2))
        return {
          ...token,
          percentage: nextPercent,
          lockedUsd: Math.max(token.lockedUsd ?? MIN_USD, MIN_USD),
          status: "idle",
          message: null,
        } as TokenAllocation
      })

      return changed ? adjustedTokens : prevTokens
    })
  }, [budgetForUi, minPercentFloor])

  const handleAddToken = (symbol: string) => {
    if (selectedTokens.some(token => token.symbol === symbol)) {
      return
    }

    const baseBudget =
      budgetForUi > 0
        ? budgetForUi
        : Math.max((selectedTokens.length + 1) * MIN_USD, MIN_USD)
    const initialUsd = MIN_USD
    const initialPercent =
      baseBudget > 0
        ? parseFloat(((initialUsd / baseBudget) * 100).toFixed(2))
        : 0

    setSelectedTokens(prev => [
      ...prev,
      {
        symbol,
        percentage: initialPercent,
        side: "buy",
        status: "idle",
        message: null,
        notional: undefined, // New tokens don't have notional yet
        lockedUsd: initialUsd,
      },
    ])
  }

  const handleRemoveToken = (symbol: string) => {
    setSelectedTokens(prev => prev.filter(token => token.symbol !== symbol))
  }

  const enforceLimits = (
    symbol: string,
    targetPercent: number,
    getOverrides?: (finalPercent: number) => Partial<TokenAllocation>,
  ) => {
    setSelectedTokens(prev =>
      prev.map(token => {
        if (token.symbol !== symbol) {
          return token
        }
        const totalWithoutCurrent = prev.reduce((sum, item) => {
          if (item.symbol === symbol) return sum
          return sum + item.percentage
        }, 0)
        const maxForToken = Math.max(
          0,
          Math.min(100, 100 - totalWithoutCurrent),
        )
        let nextValue = Math.min(targetPercent, maxForToken)

        nextValue = Math.max(nextValue, minPercentFloor)
        const finalPercent = parseFloat(Math.min(nextValue, 100).toFixed(2))
        const overrides = getOverrides ? getOverrides(finalPercent) : {}
        const hasNotionalOverride = Object.prototype.hasOwnProperty.call(
          overrides,
          "notional",
        )

        return {
          ...token,
          ...overrides,
          percentage: finalPercent,
          notional: hasNotionalOverride ? overrides.notional : token.notional,
          status: "idle",
          message: null,
        }
      }),
    )
  }

  const handleSliderChange = (symbol: string, usdValue: number) => {
    if (Number.isNaN(usdValue) || usdValue < 0) {
      return
    }
    const sliderBudget = budgetForUi > 0 ? budgetForUi : MIN_USD
    if (sliderBudget <= 0) {
      return
    }
    const targetToken = selectedTokens.find(token => token.symbol === symbol)
    if (!targetToken) {
      return
    }
    const tokenUsdValue = getTokenUsdAllocation(targetToken, sliderBudget)
    const totalLockedUsd = selectedTokens.reduce(
      (sum, token) => sum + getTokenUsdAllocation(token, sliderBudget),
      0,
    )
    const freeUsd = Math.max(sliderBudget - totalLockedUsd, 0)
    const maxUsdForToken = Math.min(sliderBudget, tokenUsdValue + freeUsd)
    const minAllowedUsd = Math.min(MIN_USD, sliderBudget)
    const clampedUsd = Math.max(
      minAllowedUsd,
      Math.min(usdValue, maxUsdForToken),
    )
    const targetPercent = (clampedUsd / sliderBudget) * 100
    enforceLimits(symbol, targetPercent, () => ({
      notional: undefined,
      lockedUsd: parseFloat(clampedUsd.toFixed(2)),
    }))
  }

  const handleSideChange = (symbol: string, side: OrderSide) => {
    setSelectedTokens(prev =>
      prev.map(token => (token.symbol === symbol ? { ...token, side } : token)),
    )
  }

  // Debounced budget save effect
  useEffect(() => {
    if (budget <= 0 || !isBudgetInitialized) {
      return
    }
    const timeoutId = setTimeout(() => {
      saveBudgetPreferenceMutation.mutate({ budget })
    }, 3000)
    return () => clearTimeout(timeoutId)
  }, [budget, isBudgetInitialized, saveBudgetPreferenceMutation])

  const handleBudgetInputChange = (value: string) => {
    console.log("handleBudgetInputChange", value)
    setBudgetInput(value)
    setBudgetError(null)

    // Allow empty string for deletion
    if (value === "") {
      return
    }

    const numValue = Number(value)
    if (Number.isNaN(numValue) || numValue < 0) {
      setBudgetError("Budget must be a positive number")
      return
    }

    // Update budget immediately for calculations, but save will be debounced
    setBudget(numValue)
    setIsBudgetInitialized(true)
  }

  const handleBudgetInputBlur = () => {
    // Validate on blur
    if (budgetInput === "") {
      setBudgetError("Budget is required")
      setBudgetInput(budget.toString())
    } else {
      const numValue = Number(budgetInput)
      if (Number.isNaN(numValue) || numValue < 0) {
        setBudgetError("Budget must be a positive number")
        setBudgetInput(budget.toString())
      } else if (numValue < MIN_USD && selectedTokens.length > 0) {
        setBudgetError(`Budget must be at least $${MIN_USD}`)
      } else {
        setBudget(numValue)
        setIsBudgetInitialized(true)
        setBudgetError(null)
      }
    }
  }

  const handleOpenPositions = () => {
    if (
      !selectedTokens.length ||
      budget <= 0 ||
      hasBlockingBudgetIssue ||
      totalPercent <= 0
    ) {
      return
    }

    setSelectedTokens(prev =>
      prev.map(token => ({ ...token, status: "working", message: null })),
    )

    rebalancePositionsMutation.mutate(
      {
        budget,
        positions: selectedTokens.map(token => ({
          symbol: token.symbol,
          side: token.side,
          percentage: token.percentage / 100,
        })),
      },
      {
        onSuccess: data => {
          setSelectedTokens(prev =>
            prev.map(token => {
              const status = data.orders.find(
                order => order.symbol === token.symbol,
              )
              if (!status) return token
              return {
                ...token,
                status: status.status,
                message: status.message ?? null,
              }
            }),
          )
        },
        onError: error => {
          setSelectedTokens(prev =>
            prev.map(token => ({
              ...token,
              status: "failed",
              message: error.message,
            })),
          )
        },
      },
    )
  }

  const renderStatusBadge = (status: AllocationStatus) => {
    const colorMap: Record<AllocationStatus, string> = {
      idle: "bg-muted text-muted-foreground border border-border",
      working: "bg-amber-500/20 text-amber-400 border border-amber-500/40",
      filled: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40",
      failed: "bg-rose-500/20 text-rose-400 border border-rose-500/40",
    }
    const labelMap: Record<AllocationStatus, string> = {
      idle: "idle",
      working: "processing",
      filled: "filled",
      failed: "failed",
    }
    return (
      <span
        className={cn(
          "rounded-full px-3 py-1 text-xs font-medium capitalize",
          colorMap[status],
        )}
      >
        {labelMap[status]}
      </span>
    )
  }

  const allocationCard = (token: TokenAllocation) => {
    const tokenUsdValue = getTokenUsdAllocation(token, budgetForUi)
    const effectivePercent =
      budgetForUi > 0 ? (tokenUsdValue / budgetForUi) * 100 : token.percentage
    const otherPercent = totalPercent - token.percentage
    const maxForToken = Math.max(0, Math.min(100, 100 - otherPercent))
    const sliderMax = Math.max(
      effectivePercent,
      Math.min(100, maxForToken || effectivePercent),
    )
    const usdAmount = Number.isFinite(tokenUsdValue)
      ? tokenUsdValue.toFixed(2)
      : "0.00"
    const availableExtra = Math.max(0, sliderMax - effectivePercent)
    const displayGradientStop = Math.min(
      100,
      effectivePercent + Math.max(0, sliderMax - effectivePercent),
    )
    const sideColor = getSideColor(token.side)
    const isLong = token.side === "buy"
    const gradient = `linear-gradient(90deg, ${sideColor} 0% ${effectivePercent}%, rgba(250,204,21,0.6) ${effectivePercent}% ${displayGradientStop}%, rgba(107,114,128,0.3) ${displayGradientStop}% 100%)`
    const sliderMaxValue =
      budgetForUi > 0 ? budgetForUi : Math.max(tokenUsdValue, MIN_USD)
    const sliderMinValue = Math.min(MIN_USD, sliderMaxValue)
    const sliderValue = Math.min(
      sliderMaxValue,
      Math.max(tokenUsdValue, sliderMinValue),
    )

    return (
      <Card
        key={token.symbol}
        className="gap-3 py-3 border-l-4"
        style={{ borderLeftColor: sideColor }}
      >
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-2">
            <div
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: sideColor }}
            />
            <CardTitle className="text-lg font-semibold">
              {token.symbol}
            </CardTitle>
          </div>
          {renderStatusBadge(token.status)}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>
              {effectivePercent.toFixed(2)}% (~${usdAmount})
            </span>
            <select
              value={token.side}
              onChange={event =>
                handleSideChange(token.symbol, event.target.value as OrderSide)
              }
              className={cn(
                "rounded-md border bg-transparent px-2 py-1 text-sm font-medium",
                isLong
                  ? "border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400"
                  : "border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400",
              )}
            >
              <option value="buy">Long</option>
              <option value="sell">Short</option>
            </select>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleRemoveToken(token.symbol)}
            >
              Remove
            </Button>
          </div>
          <div className="space-y-2">
            <div className="relative w-full">
              <div className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2 px-2">
                <div
                  className="h-2 rounded-full"
                  style={{ background: gradient }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={sliderMaxValue}
                step={0.01}
                value={sliderValue}
                className="portfolio-slider relative z-10"
                onChange={event =>
                  handleSliderChange(token.symbol, Number(event.target.value))
                }
              />
            </div>
            <div className="text-xs text-muted-foreground">
              Additional allocation available for this token:{" "}
              {availableExtra.toFixed(2)}%
            </div>
          </div>
          {token.message && (
            <div className="text-sm text-muted-foreground">{token.message}</div>
          )}
        </CardContent>
      </Card>
    )
  }

  const disableSubmit =
    !selectedTokens.length ||
    budget <= 0 ||
    rebalancePositionsMutation.isPending ||
    totalPercent <= 0 ||
    hasBlockingBudgetIssue

  return (
    <div className="container mx-auto flex max-w-5xl flex-col gap-4 py-4">
      <div>
        <h1 className="text-3xl font-bold">Portfolio builder</h1>
        <p className="text-muted-foreground">
          Select perp tokens, distribute percentages, and submit orders to
          Hyperliquid.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_3fr] lg:items-stretch">
        <Card className="flex min-h-0 flex-col gap-3 py-3">
          <CardHeader className="flex-shrink-0">
            <CardTitle>Token list</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col space-y-3">
            <input
              type="text"
              placeholder="Search by ticker"
              value={searchTerm}
              onChange={event => setSearchTerm(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            {tickersError && (
              <p className="text-sm text-rose-400">{tickersError.message}</p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
              {isTickersLoading ? (
                <div className="p-4 text-sm text-muted-foreground">
                  Loading tickers...
                </div>
              ) : filteredTickers.length ? (
                filteredTickers.map(symbol => {
                  const alreadySelected = selectedTokens.some(
                    token => token.symbol === symbol,
                  )
                  return (
                    <button
                      key={symbol}
                      type="button"
                      onClick={() => handleAddToken(symbol)}
                      disabled={alreadySelected}
                      className={cn(
                        "flex w-full items-center justify-between border-b border-border/60 px-4 py-2 text-left text-sm hover:bg-muted/40",
                        alreadySelected && "cursor-not-allowed opacity-50",
                      )}
                    >
                      {symbol}
                      {alreadySelected && (
                        <span className="text-xs text-muted-foreground">
                          added
                        </span>
                      )}
                    </button>
                  )
                })
              ) : (
                <div className="p-4 text-sm text-muted-foreground">
                  Nothing found
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="flex min-h-0 flex-col space-y-4">
          <Card className="gap-3 py-3">
            <CardHeader>
              <CardTitle>Total budget</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {balanceError && (
                <p className="text-sm text-rose-400">{balanceError.message}</p>
              )}
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span>
                  Perp account balance:{" "}
                  {isBalanceLoading
                    ? "loading..."
                    : `${
                        typeof balanceData?.perp_usdc_balance === "number"
                          ? balanceData.perp_usdc_balance.toFixed(2)
                          : "0.00"
                      } USDC`}
                </span>
                {typeof balanceData?.perp_usdc_balance === "number" &&
                  budget > balanceData.perp_usdc_balance && (
                    <span className="text-rose-400">
                      Exceeds available balance
                    </span>
                  )}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <input
                    type="number"
                    min={MIN_USD}
                    step={10}
                    value={budgetInput}
                    onChange={event =>
                      handleBudgetInputChange(event.target.value)
                    }
                    onBlur={handleBudgetInputBlur}
                    className={cn(
                      "w-full rounded-md border border-border bg-background px-3 py-2 text-sm",
                      budgetError && "border-rose-500",
                    )}
                  />
                  {budgetError && (
                    <p className="mt-1 text-xs text-rose-400">{budgetError}</p>
                  )}
                  {insufficientBudgetForTokens && (
                    <p className="mt-1 text-xs text-rose-400">
                      Delete some tokens or make bigger budget (need at least $
                      {requiredBudgetForTokens}).
                    </p>
                  )}
                </div>
                <span className="text-sm text-muted-foreground">USDC</span>
              </div>
              <div className="text-sm text-muted-foreground">
                Allocated: {totalPercent.toFixed(2)}% — free:{" "}
                {remainingPercent.toFixed(2)}%
              </div>
            </CardContent>
          </Card>

          {selectedTokens.length === 0 ? (
            <Card className="gap-3 py-3">
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                Add tokens from the list on the left to configure allocations.
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="gap-3 py-3">
                <CardHeader>
                  <CardTitle>Allocation block</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                    <span>Total allocated</span>
                    <span>
                      {totalPercent.toFixed(2)}% · ${displayBudget.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex h-12 overflow-hidden rounded-lg border border-border text-xs font-medium text-background">
                    {selectedTokens.map(token => {
                      const sideColor = getSideColor(token.side)
                      return (
                        <div
                          key={token.symbol}
                          className="flex items-center justify-center px-2 text-center"
                          style={{
                            flexGrow: Math.max(token.percentage, 0.1),
                            flexBasis: 0,
                            backgroundColor: sideColor,
                          }}
                        >
                          {token.symbol} · {token.percentage.toFixed(1)}%
                        </div>
                      )
                    })}
                    {remainingPercent > 0 && (
                      <div
                        className="flex items-center justify-center bg-muted px-2 text-center text-foreground"
                        style={{
                          flexGrow: remainingPercent,
                          flexBasis: 0,
                        }}
                      >
                        Free {remainingPercent.toFixed(1)}%
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    {selectedTokens.map(token => {
                      const sideColor = getSideColor(token.side)
                      const isLong = token.side === "buy"
                      const tokenUsdValue = getTokenUsdAllocation(
                        token,
                        budgetForUi,
                      )
                      const percentDisplay =
                        budgetForUi > 0
                          ? (tokenUsdValue / budgetForUi) * 100
                          : token.percentage
                      return (
                        <div
                          key={`${token.symbol}-summary`}
                          className="flex items-center justify-between"
                        >
                          <div className="flex items-center gap-2">
                            <div
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: sideColor }}
                            />
                            <span className="font-medium text-foreground">
                              {token.symbol}
                            </span>
                            <span
                              className={cn(
                                "text-xs px-1.5 py-0.5 rounded font-medium",
                                isLong
                                  ? "bg-green-500/20 text-green-600 dark:text-green-400"
                                  : "bg-red-500/20 text-red-600 dark:text-red-400",
                              )}
                            >
                              {isLong ? "LONG" : "SHORT"}
                            </span>
                          </div>
                          <span>
                            {percentDisplay.toFixed(2)}% · $
                            {tokenUsdValue.toFixed(2)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
              <div className="space-y-4">
                {selectedTokens.map(allocationCard)}
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

      <div className="sticky bottom-0 bg-background/80 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="text-sm text-muted-foreground">
            Each token must receive at least ${MIN_USD}. Remove extra positions
            if you run out of budget.
          </div>
          <Button onClick={handleOpenPositions} disabled={disableSubmit}>
            {rebalancePositionsMutation.isPending ? "Sending..." : "Rebalance"}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default PortfolioPage
