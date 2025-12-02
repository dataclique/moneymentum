import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  refreshAllData,
  useHyperliquidBalance,
  useHyperliquidTickers,
  useRebalanceHyperliquidPositions,
  useHyperliquidPositions,
  useBudgetPreference,
  useSaveBudgetPreference,
  useHyperliquidLeverageLimits,
  type OrderSide,
  type OrderStatus,
} from "@/hooks/useApi"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { useNetwork } from "@/contexts/NetworkContext"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type AllocationStatus = OrderStatus["status"] | "idle"

interface TokenAllocation {
  symbol: string
  percentage: number
  side: OrderSide
  leverage: number
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

const AllocationBarToken = ({
  token,
  budget,
  isHovered,
}: {
  token: TokenAllocation
  budget: number
  isHovered: boolean
}) => {
  const isSmall = token.percentage < 4
  const usdAmount = (token.percentage / 100) * budget

  return (
    <div
      key={token.symbol}
      className="flex items-center justify-center overflow-hidden border-b border-background p-1 text-center text-white"
      style={{
        height: `${token.percentage}%`,
        backgroundColor: getSideColor(token.side),
      }}
    >
      <div className={cn("flex", isSmall ? "flex-row gap-1" : "flex-col")}>
        <span className="font-bold">{token.symbol.split("/")[0]}</span>
        <span>
          {isHovered
            ? `$${usdAmount.toFixed(2)}`
            : `${token.percentage.toFixed(1)}%`}
        </span>
      </div>
    </div>
  )
}

const AllocationBar = ({
  tokens,
  remainingPercent,
  budget,
}: {
  tokens: TokenAllocation[]
  remainingPercent: number
  budget: number
}) => {
  const [isHovered, setIsHovered] = useState(false)
  const longs = tokens.filter(t => t.side === "buy")
  const shorts = tokens.filter(t => t.side === "sell")

  return (
    <div
      className="fixed left-0 top-0 z-20 flex h-screen w-20 flex-col border-r border-border bg-background/50 text-xs backdrop-blur-sm"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Longs */}
      {longs.map(token => (
        <AllocationBarToken
          key={token.symbol}
          token={token}
          budget={budget}
          isHovered={isHovered}
        />
      ))}

      {/* Free space */}
      {remainingPercent > 0.1 && (
        <div
          className="flex items-center justify-center text-center"
          style={{ height: `${remainingPercent}%` }}
        >
          <span className="text-muted-foreground">Free</span>
        </div>
      )}

      {/* Shorts */}
      {shorts.map(token => (
        <AllocationBarToken
          key={token.symbol}
          token={token}
          budget={budget}
          isHovered={isHovered}
        />
      ))}
    </div>
  )
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
  const { isNetworkSwitching, setIsNetworkSwitching } = useNetwork()
  const queryClient = useQueryClient()
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
  const { data: balanceData } = useHyperliquidBalance()
  const { data: positionsData, isLoading: isPositionsLoading } =
    useHyperliquidPositions()
  const { data: leverageLimitsData } = useHyperliquidLeverageLimits()
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
              leverage: token.leverage || 1,
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
        leverage: pos.leverage || 1,
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
      tokens: selectedTokens.map(
        ({ symbol, percentage, side, lockedUsd, leverage }) => ({
          symbol,
          percentage,
          side,
          lockedUsd,
          leverage,
        }),
      ),
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
  const leverageLimitsMap = useMemo(() => {
    const map: Record<string, number> = {}
    if (!leverageLimitsData?.data) {
      return map
    }
    for (const item of leverageLimitsData.data) {
      map[item.symbol] = item.max_leverage
    }
    return map
  }, [leverageLimitsData])
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

  // Combines logic for recalculating percentages and enforcing minimums to prevent re-render loops.
  useEffect(() => {
    if (budgetForUi <= 0) {
      return
    }

    setSelectedTokens(prevTokens => {
      // First, recalculate percentages based on any locked values
      const recalculatedTokens = recalcPercentagesFromLockedValues(
        prevTokens,
        budgetForUi,
      )

      // Then, enforce minimum percentage constraints on the result
      const minPercent = minPercentFloor
      if (minPercent > 0) {
        const adjustedTokens = recalculatedTokens.map(token => {
          if (
            (token.notional !== undefined && token.notional > 0) ||
            token.percentage >= minPercent
          ) {
            return token
          }
          const nextPercent = parseFloat(Math.min(100, minPercent).toFixed(2))
          return {
            ...token,
            percentage: nextPercent,
            lockedUsd: Math.max(token.lockedUsd ?? MIN_USD, MIN_USD),
            status: "idle",
            message: null,
          } as TokenAllocation
        })

        // Only update state if the array has actually changed
        if (JSON.stringify(adjustedTokens) !== JSON.stringify(prevTokens)) {
          return adjustedTokens
        }
      } else if (
        JSON.stringify(recalculatedTokens) !== JSON.stringify(prevTokens)
      ) {
        return recalculatedTokens
      }

      return prevTokens
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
        leverage: 1,
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

  const handleLeverageChange = (symbol: string, leverage: number) => {
    const maxLeverage = leverageLimitsMap[symbol] || 1
    const newLeverage = Math.max(1, Math.min(leverage, maxLeverage))
    setSelectedTokens(prev =>
      prev.map(token =>
        token.symbol === symbol ? { ...token, leverage: newLeverage } : token,
      ),
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
          leverage: token.leverage,
        })),
      },
      {
        onSuccess: async data => {
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
          const allFilled = data.orders.every(
            order => order.status === "filled",
          )
          if (allFilled) {
            setIsNetworkSwitching(true)
            try {
              await refreshAllData(queryClient)
            } catch (error) {
              console.error("Failed to refresh after positions filled:", error)
            } finally {
              setIsNetworkSwitching(false)
            }
          }
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

  const allocationCard = (token: TokenAllocation) => {
    const tokenUsdValue = getTokenUsdAllocation(token, budgetForUi)
    const effectivePercent =
      budgetForUi > 0 ? (tokenUsdValue / budgetForUi) * 100 : token.percentage
    const sideColor = getSideColor(token.side)
    const isLong = token.side === "buy"
    const usdAmount = Number.isFinite(tokenUsdValue)
      ? tokenUsdValue.toFixed(2)
      : "0.00"
    const maxLeverage = leverageLimitsMap[token.symbol]
    const sliderMaxValue =
      budgetForUi > 0 ? budgetForUi : Math.max(tokenUsdValue, MIN_USD)
    const sliderMinValue = Math.min(MIN_USD, sliderMaxValue)
    const sliderValue = Math.min(
      sliderMaxValue,
      Math.max(tokenUsdValue, sliderMinValue),
    )

    const otherTokensAllocatedUsd = selectedTokens.reduce((acc, t) => {
      if (t.symbol === token.symbol) {
        return acc
      }
      return acc + getTokenUsdAllocation(t, budgetForUi)
    }, 0)
    const maxUsdForToken = Math.max(0, budgetForUi - otherTokensAllocatedUsd)

    const cardContent = (
      <Card
        className={cn(
          "overflow-hidden",
          token.status === "idle" && "border-l-4",
          token.status === "filled" && "border-2 border-emerald-500",
          token.status === "working" && "border-animated-gradient",
          token.status === "failed" && "border-2 border-rose-500",
        )}
        style={{
          borderLeftColor: token.status === "idle" ? sideColor : "transparent",
        }}
      >
        {/* This inner div is for the gradient border trick to work */}
        <div
          className={cn(
            token.status === "working"
              ? "rounded-[--radius] bg-background"
              : "",
          )}
        >
          <div className="flex items-center gap-2 px-3">
            {/* Coin Name and Leverage */}
            <div className="flex w-32 items-center">
              <span className="font-semibold" style={{ color: sideColor }}>
                {token.symbol.split("/")[0]}
              </span>
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto px-2 py-1 text-xs"
                    style={{ color: sideColor }}
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
                          handleLeverageChange(token.symbol, value)
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
            <div className="w-24 text-center">
              <span className="text-sm">{effectivePercent.toFixed(2)}%</span>
            </div>

            {/* Position Value */}
            <div className="w-24 text-center">
              <span className="text-sm">${usdAmount}</span>
            </div>

            {/* Long/Short Select */}
            <div className="w-24">
              <select
                value={token.side}
                onChange={event =>
                  handleSideChange(
                    token.symbol,
                    event.target.value as OrderSide,
                  )
                }
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
            <div className="flex-1 px-2">
              <Slider
                value={[sliderValue]}
                onValueChange={([value]) =>
                  handleSliderChange(token.symbol, value)
                }
                min={sliderMinValue}
                max={sliderMaxValue}
                step={0.01}
                limitValue={maxUsdForToken}
              />
            </div>

            {/* Remove Button and Status */}
            <div className="flex w-16 items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleRemoveToken(token.symbol)}
                className="h-8 w-8"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </Card>
    )

    if (token.status === "failed" && token.message) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{cardContent}</TooltipTrigger>
            <TooltipContent>
              <p>{token.message}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    }

    return cardContent
  }

  const disableSubmit =
    !selectedTokens.length ||
    budget <= 0 ||
    rebalancePositionsMutation.isPending ||
    totalPercent <= 0 ||
    hasBlockingBudgetIssue
  const netExposure = selectedTokens.reduce((acc, token) => {
    const usdValue = getTokenUsdAllocation(token, budgetForUi)
    return acc + (token.side === "buy" ? usdValue : -usdValue)
  }, 0)

  return (
    <>
      <div
        className={cn(
          "container mx-auto flex max-w-5xl flex-col gap-4 py-4 pl-28 min-h-screen",
          isNetworkSwitching && "pointer-events-none opacity-50",
        )}
      >
        <div className="flex flex-col gap-4">
          {/* Top section for controls */}
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
                </div>
                <span className="text-sm text-muted-foreground">USDC</span>
                {typeof balanceData?.perp_usdc_balance === "number" &&
                  budget > balanceData?.perp_usdc_balance && (
                    <span className="text-xs text-rose-400">
                      Exceeds available balance
                    </span>
                  )}
              </div>
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Add New Token</Button>
                </DialogTrigger>
                <DialogContent className="flex h-[70vh] max-w-md flex-col">
                  <DialogHeader>
                    <DialogTitle>Select a Token</DialogTitle>
                    <DialogDescription>
                      Search and select a token to add to your portfolio
                      allocation.
                    </DialogDescription>
                  </DialogHeader>
                  <input
                    type="text"
                    placeholder="Search by ticker"
                    value={searchTerm}
                    onChange={event => setSearchTerm(event.target.value)}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                  {tickersError && (
                    <p className="text-sm text-rose-400">
                      {tickersError.message}
                    </p>
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
                              alreadySelected &&
                                "cursor-not-allowed opacity-50",
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
                </DialogContent>
              </Dialog>
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
                  <div className="w-32">
                    <span>COIN</span>
                  </div>
                  <div className="w-24 text-center">
                    <span>PERCENTAGE</span>
                  </div>
                  <div className="w-24 text-center">
                    <span>VALUE</span>
                  </div>
                  <div className="w-24 text-center">
                    <span>SIDE</span>
                  </div>
                  <div className="flex-1 px-2 text-center">
                    <span>ALLOCATION</span>
                  </div>
                  <div className="w-16 text-right">
                    <span>ACTIONS</span>
                  </div>
                </div>
                <div className="space-y-2">
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
              {rebalancePositionsMutation.isPending
                ? "Sending..."
                : "Rebalance"}
            </Button>
          </div>
        </div>
      </div>
      <AllocationBar
        tokens={selectedTokens}
        remainingPercent={remainingPercent}
        budget={budgetForUi}
      />
    </>
  )
}

export default PortfolioPage
