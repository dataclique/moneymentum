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

const recalcPercentagesFromLockedValues = (
  tokens: TokenAllocation[],
  currentBudget: number,
): TokenAllocation[] => {
  if (!tokens.length || currentBudget <= 0) return tokens

  const changeTracker = { changed: false }
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
        changeTracker.changed = true
        return { ...token, percentage: nextPercent }
      }
    }
    return token
  })

  return changeTracker.changed ? updatedTokens : tokens
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

  // Initialize from localStorage (one-time on mount)
  useEffect(() => {
    if (!storedData) return
    if (typeof storedData.budget === "number") {
      setBudget(storedData.budget)
      setBudgetInput(storedData.budget.toString())
      setIsBudgetInitialized(true)
    }
    if (Array.isArray(storedData.tokens)) {
      setSelectedTokens(
        storedData.tokens.map(token => ({
          ...token,
          leverage: token.leverage || 1,
          status: "untouched" as const,
          message: null,
        })),
      )
    }
  }, [storedData])

  // Initialize budget from server (budget preference > balance)
  useEffect(() => {
    if (isBudgetInitialized || positionsLoadedFromExchange) return

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

  // Load positions from exchange (only once if no local storage)
  useEffect(() => {
    // Wait for localStorage query to complete first
    if (!isStoredDataFetched) return

    if (
      isPositionsLoading ||
      !positionsData?.positions ||
      positionsLoadedFromExchange
    ) {
      return
    }

    // Don't override if user already has positions configured
    if (storedData?.tokens && storedData.tokens.length > 0) {
      setPositionsLoadedFromExchange(true)
      return
    }

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
  }, [
    positionsData,
    isPositionsLoading,
    storedData,
    isStoredDataFetched,
    memoizedSaveBudgetPreference,
    positionsLoadedFromExchange,
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

  // Computed values
  const activeTokens = useMemo(
    () => selectedTokens.filter(t => t.status !== "deleted"),
    [selectedTokens],
  )

  const hasPendingDeletions = useMemo(
    () => selectedTokens.some(t => t.status === "deleted"),
    [selectedTokens],
  )

  const totalPercent = activeTokens.reduce(
    (acc, token) => acc + token.percentage,
    0,
  )
  const remainingPercent = Math.max(0, 100 - totalPercent)
  const requiredBudgetForTokens = activeTokens.length * MIN_USD
  const budgetIsPositive = budget > 0
  const budgetBelowMinimum =
    activeTokens.length > 0 && budgetIsPositive && budget < MIN_USD
  const insufficientBudgetForTokens =
    activeTokens.length > 0 &&
    budgetIsPositive &&
    requiredBudgetForTokens > budget
  const totalPercentExceeds100 = totalPercent > 100
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
  if (totalPercentExceeds100) {
    blockingReasons.push(
      `Total allocation cannot exceed 100%. Current allocation: ${totalPercent.toFixed(2)}%`,
    )
  }

  // Recalculate percentages and enforce limits
  useEffect(() => {
    if (budgetForUi <= 0) return

    setSelectedTokens(prevTokens => {
      const currentActiveTokens = prevTokens.filter(t => t.status !== "deleted")
      const tokensPendingDeletion = prevTokens.filter(
        t => t.status === "deleted",
      )
      const recalculatedTokens = recalcPercentagesFromLockedValues(
        currentActiveTokens,
        budgetForUi,
      )

      const minPercent = minPercentFloor
      if (minPercent > 0) {
        const adjustedTokens = recalculatedTokens.map(token => {
          if (
            token.status === "deleted" ||
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
            status: "idle" as const,
            message: null,
          }
        })

        const finalTokens = [...adjustedTokens, ...tokensPendingDeletion]
        if (JSON.stringify(finalTokens) !== JSON.stringify(prevTokens)) {
          return finalTokens
        }
      } else {
        const finalTokens = [...recalculatedTokens, ...tokensPendingDeletion]
        if (JSON.stringify(finalTokens) !== JSON.stringify(prevTokens)) {
          return finalTokens
        }
      }
      return prevTokens
    })
  }, [budgetForUi, minPercentFloor])

  // Update token statuses based on changes from initial state
  useEffect(() => {
    if (initialPortfolio.length === 0) return

    setSelectedTokens(prevTokens => {
      const tracker = { hasChanged: false }
      const updatedTokens = prevTokens.map(currentToken => {
        const initialToken = initialPortfolio.find(
          it => it.symbol === currentToken.symbol,
        )

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

        const newStatus: "modified" | "untouched" = isModified
          ? "modified"
          : "untouched"

        if (currentToken.status !== newStatus) {
          tracker.hasChanged = true
          return { ...currentToken, status: newStatus } as TokenAllocation
        }

        return currentToken
      })

      return tracker.hasChanged ? updatedTokens : prevTokens
    })
  }, [initialPortfolio, selectedTokens])

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
      } else if (numValue < MIN_USD && selectedTokens.length > 0) {
        setBudgetError(`Budget must be at least $${String(MIN_USD)}`)
      } else {
        setBudget(numValue)
        setIsBudgetInitialized(true)
        setBudgetError(null)
      }
    }
  }, [budgetInput, budget, maxBudget, selectedTokens.length])

  const handleOpenPositions = useCallback(() => {
    if (
      !selectedTokens.length ||
      budget <= 0 ||
      hasBlockingBudgetIssue ||
      (totalPercent <= 0 && !hasPendingDeletions) ||
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
      positions: selectedTokens.map(token => ({
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
        const updatedTokens = selectedTokens
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
    selectedTokens,
    budget,
    hasBlockingBudgetIssue,
    totalPercent,
    hasPendingDeletions,
    rebalancePositionsMutation,
    setIsNetworkSwitching,
    queryClient,
  ])

  const netExposure = activeTokens.reduce((acc, token) => {
    const usdValue = getTokenUsdAllocation(token, budgetForUi)
    return acc + (token.side === "buy" ? usdValue : -usdValue)
  }, 0)

  const disableSubmit =
    !selectedTokens.length ||
    budget <= 0 ||
    rebalancePositionsMutation.isPending ||
    (totalPercent <= 0 && !hasPendingDeletions) ||
    hasBlockingBudgetIssue ||
    totalPercentExceeds100

  return {
    // State
    budget,
    budgetInput,
    budgetError,
    selectedTokens,
    activeTokens,
    budgetForUi,
    maxBudget,
    minPercentFloor,
    totalPercent,
    remainingPercent,
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
