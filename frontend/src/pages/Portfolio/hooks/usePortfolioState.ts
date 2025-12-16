import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useHyperliquidBalance,
  useHyperliquidPositions,
  useHyperliquidLeverageLimits,
  useBudgetPreference,
  useSaveBudgetPreference,
  useRebalanceHyperliquidPositions,
  refreshAllData,
  type OrderSide,
  type OrderStatus,
} from "@/hooks/useApi"
import { useNetwork } from "@/hooks/useNetwork"

export const STORAGE_KEY = "portfolio-allocation-state"
export const MIN_USD = 11

export type AllocationStatus =
  | OrderStatus["status"]
  | "idle"
  | "untouched"
  | "deleted"
  | "modified"

export interface TokenAllocation {
  symbol: string
  percentage: number
  side: OrderSide
  leverage: number
  status: AllocationStatus
  message?: string | null
  notional?: number
  lockedUsd?: number
  previousPercentage?: number
}

interface StoredPortfolioState {
  budget: number
  tokens: Array<{
    symbol: string
    percentage: number
    side: OrderSide
    lockedUsd?: number
    leverage: number
    status: string
  }>
}

const getTokenUsdAllocation = (
  token: TokenAllocation,
  currentBudget: number,
) => {
  if (token.notional !== undefined && token.notional > 0) return token.notional
  if (token.lockedUsd !== undefined) return token.lockedUsd
  if (currentBudget > 0) return (token.percentage / 100) * currentBudget
  return 0
}

// Query for localStorage - provides initial hydration
const useStoredPortfolio = () => {
  return useQuery({
    queryKey: ["portfolio", "stored"],
    queryFn: (): StoredPortfolioState | null => {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return null
      try {
        return JSON.parse(stored) as StoredPortfolioState
      } catch {
        return null
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

export const usePortfolioState = () => {
  const { setIsNetworkSwitching } = useNetwork()
  const queryClient = useQueryClient()

  // Server data queries
  const { data: balanceData } = useHyperliquidBalance()
  const { data: positionsData, isLoading: isPositionsLoading } =
    useHyperliquidPositions()
  const { data: leverageLimitsData } = useHyperliquidLeverageLimits()
  const { data: budgetPreferenceData, isLoading: isBudgetPreferenceLoading } =
    useBudgetPreference()
  const { data: storedData, isFetched: isStoredDataFetched } =
    useStoredPortfolio()

  // Mutations
  const { mutate: saveBudgetPreference } = useSaveBudgetPreference()
  const rebalancePositionsMutation = useRebalanceHyperliquidPositions()

  // Local state
  const [budget, setBudget] = useState(0)
  const [budgetInput, setBudgetInput] = useState("")
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const [isBudgetInitialized, setIsBudgetInitialized] = useState(false)
  const [selectedTokens, setSelectedTokens] = useState<TokenAllocation[]>([])
  const [initialPortfolio, setInitialPortfolio] = useState<TokenAllocation[]>(
    [],
  )
  const [positionsLoadedFromExchange, setPositionsLoadedFromExchange] =
    useState(false)
  const lastSufficientBudgetRef = useRef(0)

  // Memoized save function
  const memoizedSaveBudgetPreference = useCallback(
    (vars: { budget: number }) => {
      saveBudgetPreference(vars)
    },
    [saveBudgetPreference],
  )

  // Combined initialization effect with priority: localStorage > exchange > server preference > balance
  useEffect(() => {
    // Wait for localStorage query to complete first
    if (!isStoredDataFetched) return

    if (isBudgetInitialized && positionsLoadedFromExchange) return

    // Priority 1: Load from localStorage
    if (storedData) {
      if (!isBudgetInitialized && typeof storedData.budget === "number") {
        setBudget(storedData.budget)
        setBudgetInput(storedData.budget.toString())
        setIsBudgetInitialized(true)
      }
      if (Array.isArray(storedData.tokens) && storedData.tokens.length > 0) {
        setSelectedTokens(
          storedData.tokens.map(token => ({
            ...token,
            leverage: token.leverage || 1,
            status: "untouched" as const,
            message: null,
          })),
        )
        setPositionsLoadedFromExchange(true)
        return
      }
    }

    // Priority 2: Load positions from exchange (if no localStorage tokens)
    if (
      !isPositionsLoading &&
      positionsData?.positions &&
      !positionsLoadedFromExchange
    ) {
      const loadedTokens: TokenAllocation[] = positionsData.positions.map(
        pos => ({
          symbol: pos.symbol,
          percentage: parseFloat(pos.percentage.toFixed(2)),
          side: pos.side,
          leverage: pos.leverage || 1,
          status: "untouched" as const,
          message: null,
          notional: pos.notional,
          lockedUsd: pos.notional,
        }),
      )

      if (loadedTokens.length > 0) {
        setSelectedTokens(loadedTokens)
        setInitialPortfolio(loadedTokens)
        const totalSpent = positionsData.total_notional
        if (totalSpent > 0) {
          setBudget(totalSpent)
          setBudgetInput(totalSpent.toString())
          setIsBudgetInitialized(true)
          memoizedSaveBudgetPreference({ budget: totalSpent })
        }
      }
      setPositionsLoadedFromExchange(true)
      return
    }

    // Priority 3: Initialize budget from server preference or balance (if no positions)
    if (!isBudgetInitialized && positionsLoadedFromExchange) {
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
    }
  }, [
    storedData,
    isStoredDataFetched,
    positionsData,
    isPositionsLoading,
    balanceData,
    budgetPreferenceData,
    isBudgetInitialized,
    isBudgetPreferenceLoading,
    positionsLoadedFromExchange,
    memoizedSaveBudgetPreference,
  ])

  // Persist to localStorage
  useEffect(() => {
    const payload = {
      budget,
      tokens: selectedTokens.map(
        ({ symbol, percentage, side, lockedUsd, leverage, status }) => ({
          symbol,
          percentage,
          side,
          lockedUsd,
          leverage,
          status,
        }),
      ),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [budget, selectedTokens])

  // Derive token statuses (modified/untouched) by comparing to initial portfolio
  const tokensWithComputedStatus = useMemo(() => {
    if (initialPortfolio.length === 0) return selectedTokens

    return selectedTokens.map(currentToken => {
      const initialToken = initialPortfolio.find(
        it => it.symbol === currentToken.symbol,
      )

      // Don't compute status for certain base statuses
      if (
        !initialToken ||
        currentToken.status === "deleted" ||
        currentToken.status === "failed" ||
        currentToken.status === "working"
      ) {
        return currentToken
      }

      const isModified =
        Math.abs(
          (currentToken.lockedUsd ?? 0) - (initialToken.lockedUsd ?? 0),
        ) > 0.01 ||
        currentToken.side !== initialToken.side ||
        currentToken.leverage !== initialToken.leverage

      const computedStatus: "modified" | "untouched" = isModified
        ? "modified"
        : "untouched"

      if (currentToken.status !== computedStatus) {
        return { ...currentToken, status: computedStatus }
      }

      return currentToken
    })
  }, [selectedTokens, initialPortfolio])

  // Computed values
  const activeTokens = useMemo(
    () => tokensWithComputedStatus.filter(t => t.status !== "deleted"),
    [tokensWithComputedStatus],
  )

  const hasPendingDeletions = useMemo(
    () => tokensWithComputedStatus.some(t => t.status === "deleted"),
    [tokensWithComputedStatus],
  )

  const requiredBudgetForTokens = activeTokens.length * MIN_USD
  const budgetIsPositive = budget > 0
  const budgetBelowMinimum =
    activeTokens.length > 0 && budgetIsPositive && budget < MIN_USD
  const insufficientBudgetForTokens =
    activeTokens.length > 0 &&
    budgetIsPositive &&
    requiredBudgetForTokens > budget
  const maxBudget = (balanceData?.perp_usdc_balance ?? 0) * 5

  // Track last sufficient budget
  useEffect(() => {
    if (budget > 0 && budget >= requiredBudgetForTokens) {
      lastSufficientBudgetRef.current = budget
    }
  }, [budget, requiredBudgetForTokens])

  const budgetForUi = useMemo(() => {
    if (activeTokens.length === 0) {
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
  }, [budget, requiredBudgetForTokens, activeTokens.length])

  const minPercentOfBudget =
    budgetForUi > 0 ? Math.min(100, (MIN_USD / budgetForUi) * 100) : 0
  const minPercentFloor = budgetForUi >= MIN_USD ? minPercentOfBudget : 0
  const hasBlockingBudgetIssue =
    budgetBelowMinimum || insufficientBudgetForTokens

  // Derive percentages from lockedUsd/notional and budgetForUi
  const tokensWithDerivedPercentages = useMemo(() => {
    if (budgetForUi <= 0) return tokensWithComputedStatus

    return tokensWithComputedStatus.map(token => {
      if (token.status === "deleted") return token

      const referenceUsd =
        token.notional !== undefined && token.notional > 0
          ? token.notional
          : token.lockedUsd

      if (referenceUsd !== undefined && referenceUsd >= 0) {
        const derivedPercent = parseFloat(
          ((referenceUsd / budgetForUi) * 100).toFixed(2),
        )
        if (
          Number.isFinite(derivedPercent) &&
          Math.abs(derivedPercent - token.percentage) > 0.01
        ) {
          return { ...token, percentage: derivedPercent }
        }
      }
      return token
    })
  }, [tokensWithComputedStatus, budgetForUi])

  // Recompute derived values with correct percentages
  const derivedActiveTokens = useMemo(
    () => tokensWithDerivedPercentages.filter(t => t.status !== "deleted"),
    [tokensWithDerivedPercentages],
  )
  const derivedTotalPercent = derivedActiveTokens.reduce(
    (acc, token) => acc + token.percentage,
    0,
  )
  const derivedRemainingPercent = Math.max(0, 100 - derivedTotalPercent)

  const leverageLimitsMap = useMemo(() => {
    const map: Record<string, number> = {}
    if (!leverageLimitsData?.data) return map
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
      `Delete some tokens or make bigger budget (need at least $${String(requiredBudgetForTokens)}).`,
    )
  }
  const derivedTotalPercentExceeds100 = derivedTotalPercent > 100
  if (derivedTotalPercentExceeds100) {
    blockingReasons.push(
      `Total allocation cannot exceed 100%. Current allocation: ${derivedTotalPercent.toFixed(2)}%`,
    )
  }

  // Enforce minimum USD amounts for tokens (percentage is now derived)
  useEffect(() => {
    if (budgetForUi <= 0 || minPercentFloor <= 0) return

    setSelectedTokens(prevTokens => {
      const needsAdjustment = prevTokens.some(
        token =>
          token.status !== "deleted" &&
          !(token.notional !== undefined && token.notional > 0) &&
          (token.lockedUsd === undefined || token.lockedUsd < MIN_USD),
      )
      if (!needsAdjustment) return prevTokens

      return prevTokens.map(token => {
        // Skip deleted tokens or tokens with exchange notional
        if (
          token.status === "deleted" ||
          (token.notional !== undefined && token.notional > 0)
        ) {
          return token
        }
        // Check if token meets minimum USD requirement
        if (token.lockedUsd !== undefined && token.lockedUsd >= MIN_USD) {
          return token
        }
        // Bump up to minimum
        return {
          ...token,
          lockedUsd: MIN_USD,
          status: "idle" as const,
          message: null,
        }
      })
    })
  }, [budgetForUi, minPercentFloor])

  // Debounced budget save
  useEffect(() => {
    if (budget <= 0 || !isBudgetInitialized) return
    const timeoutId = setTimeout(() => {
      memoizedSaveBudgetPreference({ budget })
    }, 3000)
    return () => {
      clearTimeout(timeoutId)
    }
  }, [budget, isBudgetInitialized, memoizedSaveBudgetPreference])

  // Action handlers
  const handleAddToken = useCallback(
    (symbol: string) => {
      const existingToken = selectedTokens.find(t => t.symbol === symbol)
      if (existingToken) {
        if (existingToken.status === "deleted") {
          setSelectedTokens(prev =>
            prev.map(token =>
              token.symbol === symbol
                ? {
                    ...token,
                    status: token.notional ? "untouched" : "idle",
                    percentage: token.previousPercentage ?? minPercentFloor,
                    previousPercentage: undefined,
                  }
                : token,
            ),
          )
        }
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
          notional: undefined,
          lockedUsd: initialUsd,
        },
      ])
    },
    [selectedTokens, budgetForUi, minPercentFloor],
  )

  const handleRemoveToken = useCallback(
    (symbol: string) => {
      setSelectedTokens(prev => {
        const wasInitiallyInPortfolio = initialPortfolio.some(
          it => it.symbol === symbol,
        )

        if (!wasInitiallyInPortfolio) {
          return prev.filter(token => token.symbol !== symbol)
        }

        return prev.map(token =>
          token.symbol === symbol
            ? {
                ...token,
                status: "deleted" as const,
                previousPercentage: token.percentage,
                percentage: 0,
                message: null,
              }
            : token,
        )
      })
    },
    [initialPortfolio],
  )

  const handleUndoRemoveToken = useCallback(
    (symbol: string) => {
      setSelectedTokens(prev =>
        prev.map(token =>
          token.symbol === symbol
            ? {
                ...token,
                status: token.notional ? "untouched" : "idle",
                percentage: token.previousPercentage ?? minPercentFloor,
                previousPercentage: undefined,
              }
            : token,
        ),
      )
    },
    [minPercentFloor],
  )

  const handleSliderChange = useCallback(
    (symbol: string, usdValue: number) => {
      if (Number.isNaN(usdValue) || usdValue < 0) return
      const sliderBudget = budgetForUi > 0 ? budgetForUi : MIN_USD
      if (sliderBudget <= 0) return

      const targetToken = selectedTokens.find(token => token.symbol === symbol)
      if (!targetToken) return

      const tokenUsdValue = getTokenUsdAllocation(targetToken, sliderBudget)
      const totalLockedUsd = activeTokens.reduce(
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

      setSelectedTokens(prev =>
        prev.map(token => {
          if (token.symbol !== symbol) return token
          const nextValue = Math.max(minPercentFloor, targetPercent)
          const finalPercent = parseFloat(Math.min(nextValue, 100).toFixed(2))
          return {
            ...token,
            percentage: finalPercent,
            notional: undefined,
            lockedUsd: parseFloat(clampedUsd.toFixed(2)),
            message: null,
          }
        }),
      )
    },
    [selectedTokens, activeTokens, budgetForUi, minPercentFloor],
  )

  const handleSideChange = useCallback((symbol: string, side: OrderSide) => {
    setSelectedTokens(prev =>
      prev.map(token => (token.symbol === symbol ? { ...token, side } : token)),
    )
  }, [])

  const handleLeverageChange = useCallback(
    (symbol: string, leverage: number) => {
      const maxLeverage = leverageLimitsMap[symbol] || 1
      const newLeverage = Math.max(1, Math.min(leverage, maxLeverage))
      setSelectedTokens(prev =>
        prev.map(token =>
          token.symbol === symbol ? { ...token, leverage: newLeverage } : token,
        ),
      )
    },
    [leverageLimitsMap],
  )

  const handleBudgetInputChange = useCallback(
    (value: string) => {
      setBudgetInput(value)
      setBudgetError(null)

      if (value === "") return

      const numValue = Number(value)
      if (Number.isNaN(numValue) || numValue < 0) {
        setBudgetError("Budget must be a positive number")
        return
      }
      if (maxBudget > 0 && numValue > maxBudget) {
        setBudgetError(`Max budget: $${maxBudget.toFixed(2)}`)
        return
      }

      setBudget(numValue)
      setIsBudgetInitialized(true)
    },
    [maxBudget],
  )

  const handleBudgetInputBlur = useCallback(() => {
    if (budgetInput === "") {
      setBudgetError("Budget is required")
      setBudgetInput(budget.toString())
    } else {
      const numValue = Number(budgetInput)
      if (Number.isNaN(numValue) || numValue < 0) {
        setBudgetError("Budget must be a positive number")
        setBudgetInput(budget.toString())
      } else if (maxBudget > 0 && numValue > maxBudget) {
        setBudgetError(`Max budget: $${maxBudget.toFixed(2)}`)
      } else if (
        numValue < MIN_USD &&
        tokensWithDerivedPercentages.length > 0
      ) {
        setBudgetError(`Budget must be at least $${String(MIN_USD)}`)
      } else {
        setBudget(numValue)
        setIsBudgetInitialized(true)
        setBudgetError(null)
      }
    }
  }, [budgetInput, budget, maxBudget, tokensWithDerivedPercentages.length])

  const handleOpenPositions = useCallback(() => {
    if (
      !tokensWithDerivedPercentages.length ||
      budget <= 0 ||
      hasBlockingBudgetIssue ||
      (derivedTotalPercent <= 0 && !hasPendingDeletions) ||
      rebalancePositionsMutation.isPending
    ) {
      return
    }

    const mapStatusForApi = (
      status: AllocationStatus,
    ): "untouched" | "modified" | "idle" | "deleted" | "working" => {
      if (status === "filled" || status === "failed") return "idle"
      return status
    }

    const payload = {
      budget,
      positions: tokensWithDerivedPercentages.map(token => ({
        symbol: token.symbol,
        side: token.side,
        percentage: token.percentage / 100,
        leverage: token.leverage,
        status: mapStatusForApi(token.status),
      })),
    }

    setSelectedTokens(prev =>
      prev.map(token => ({
        ...token,
        status: token.status === "deleted" ? "deleted" : "working",
        message: null,
      })),
    )

    rebalancePositionsMutation.mutate(payload, {
      onSuccess: data => {
        const updatedTokens = tokensWithDerivedPercentages
          .map(token => {
            const status = data.orders.find(
              order => order.symbol === token.symbol,
            )
            if (!status) return token

            if (token.status === "deleted" && status.status === "filled") {
              return null
            }

            return {
              ...token,
              status: status.status,
              message: status.message ?? null,
            }
          })
          .filter((t): t is TokenAllocation => t !== null)

        setSelectedTokens(updatedTokens)

        const allFilled = data.orders.every(order => order.status === "filled")
        const hasFailures = data.orders.some(order => order.status === "failed")

        if (allFilled && !hasFailures) {
          setIsNetworkSwitching(true)
          refreshAllData(queryClient)
            .catch((error: unknown) => {
              console.error("Failed to refresh after positions filled:", error)
            })
            .finally(() => {
              setIsNetworkSwitching(false)
            })
        }
      },
      onError: error => {
        const symbolMatch = error.message.match(/([A-Z0-9-]+\/[A-Z]+:[A-Z]+)/)
        const failedSymbol = symbolMatch ? symbolMatch[0] : null

        setSelectedTokens(prev =>
          prev.map(token => {
            if (failedSymbol) {
              if (token.symbol === failedSymbol) {
                return { ...token, status: "failed", message: error.message }
              }
              return { ...token, status: "idle", message: null }
            }
            return { ...token, status: "failed", message: error.message }
          }),
        )
      },
    })
  }, [
    tokensWithDerivedPercentages,
    budget,
    hasBlockingBudgetIssue,
    derivedTotalPercent,
    hasPendingDeletions,
    rebalancePositionsMutation,
    setIsNetworkSwitching,
    queryClient,
  ])

  const netExposure = derivedActiveTokens.reduce((acc, token) => {
    const usdValue = getTokenUsdAllocation(token, budgetForUi)
    return acc + (token.side === "buy" ? usdValue : -usdValue)
  }, 0)

  const disableSubmit =
    !tokensWithDerivedPercentages.length ||
    budget <= 0 ||
    rebalancePositionsMutation.isPending ||
    (derivedTotalPercent <= 0 && !hasPendingDeletions) ||
    hasBlockingBudgetIssue ||
    derivedTotalPercentExceeds100

  return {
    // State
    budget,
    budgetInput,
    budgetError,
    selectedTokens: tokensWithDerivedPercentages,
    activeTokens: derivedActiveTokens,
    budgetForUi,
    maxBudget,
    minPercentFloor,
    totalPercent: derivedTotalPercent,
    remainingPercent: derivedRemainingPercent,
    hasPendingDeletions,
    blockingReasons,
    leverageLimitsMap,
    netExposure,
    disableSubmit,
    isRebalancing: rebalancePositionsMutation.isPending,

    // Actions
    handleAddToken,
    handleRemoveToken,
    handleUndoRemoveToken,
    handleSliderChange,
    handleSideChange,
    handleLeverageChange,
    handleBudgetInputChange,
    handleBudgetInputBlur,
    handleOpenPositions,
  }
}
