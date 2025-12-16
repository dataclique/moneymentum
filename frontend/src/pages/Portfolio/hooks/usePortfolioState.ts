import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
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

const getStoredPortfolio = (): StoredPortfolioState | null => {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return null
  try {
    return JSON.parse(stored) as StoredPortfolioState
  } catch {
    return null
  }
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

  // Mutations
  const { mutate: saveBudgetPreference } = useSaveBudgetPreference()
  const rebalancePositionsMutation = useRebalanceHyperliquidPositions()

  const [storedDataSnapshot] = useState(() => getStoredPortfolio())
  const hasStoredTokens =
    storedDataSnapshot?.tokens && storedDataSnapshot.tokens.length > 0

  const [budget, setBudget] = useState(() => storedDataSnapshot?.budget ?? 0)
  const [budgetInput, setBudgetInput] = useState(
    () => storedDataSnapshot?.budget.toString() ?? "",
  )
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const [isBudgetInitialized, setIsBudgetInitialized] = useState(
    () => typeof storedDataSnapshot?.budget === "number",
  )
  const [selectedTokens, setSelectedTokens] = useState<TokenAllocation[]>(
    () =>
      storedDataSnapshot?.tokens.map(token => ({
        ...token,
        leverage: token.leverage || 1,
        lockedUsd:
          token.lockedUsd === undefined || token.lockedUsd < MIN_USD
            ? MIN_USD
            : token.lockedUsd,
        status: "untouched" as const,
        message: null,
      })) ?? [],
  )
  const [initialPortfolio, setInitialPortfolio] = useState<TokenAllocation[]>(
    [],
  )
  const [positionsLoadedFromExchange, setPositionsLoadedFromExchange] =
    useState(() => hasStoredTokens)
  const lastSufficientBudgetRef = useRef(0)

  const budgetSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const debouncedSaveBudgetPreference = useCallback(
    (newBudget: number) => {
      if (budgetSaveTimeoutRef.current) {
        clearTimeout(budgetSaveTimeoutRef.current)
      }
      budgetSaveTimeoutRef.current = setTimeout(() => {
        saveBudgetPreference({ budget: newBudget })
      }, 3000)
    },
    [saveBudgetPreference],
  )

  const persistStateToLocalStorage = useCallback(
    (budgetVal: number, tokens: TokenAllocation[]) => {
      const payload = {
        budget: budgetVal,
        tokens: tokens.map(
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
    },
    [],
  )

  const latestBudgetRef = useRef(budget)
  const latestSelectedTokensRef = useRef(selectedTokens)
  latestBudgetRef.current = budget
  latestSelectedTokensRef.current = selectedTokens

  const setSelectedTokensAndPersist = useCallback(
    (updater: React.SetStateAction<TokenAllocation[]>) => {
      setSelectedTokens(prev => {
        const newTokens =
          typeof updater === "function" ? updater(prev) : updater
        persistStateToLocalStorage(latestBudgetRef.current, newTokens)
        return newTokens
      })
    },
    [persistStateToLocalStorage],
  )

  const setBudgetAndPersist = useCallback(
    (newBudget: number) => {
      setBudget(newBudget)
      persistStateToLocalStorage(newBudget, latestSelectedTokensRef.current)
      debouncedSaveBudgetPreference(newBudget)
    },
    [persistStateToLocalStorage, debouncedSaveBudgetPreference],
  )

  useEffect(() => {
    if (isBudgetInitialized && positionsLoadedFromExchange) return

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
          saveBudgetPreference({ budget: totalSpent })
        }
      }
      setPositionsLoadedFromExchange(true)
      return
    }

    const shouldInitializeBudgetFromServer =
      !isBudgetInitialized && positionsLoadedFromExchange
    if (shouldInitializeBudgetFromServer) {
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
    positionsData,
    isPositionsLoading,
    balanceData,
    budgetPreferenceData,
    isBudgetInitialized,
    isBudgetPreferenceLoading,
    positionsLoadedFromExchange,
    saveBudgetPreference,
  ])

  const tokensWithComputedStatus = useMemo(() => {
    if (initialPortfolio.length === 0) return selectedTokens

    return selectedTokens.map(currentToken => {
      const initialToken = initialPortfolio.find(
        it => it.symbol === currentToken.symbol,
      )

      const shouldComputeStatus =
        initialToken &&
        currentToken.status !== "deleted" &&
        currentToken.status !== "failed" &&
        currentToken.status !== "working"

      if (!shouldComputeStatus) {
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

  const budgetForUi = useMemo(() => {
    const isSufficientBudget = budget > 0 && budget >= requiredBudgetForTokens
    if (isSufficientBudget) {
      lastSufficientBudgetRef.current = budget
    }

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

  const handleAddToken = useCallback(
    (symbol: string) => {
      const existingToken = selectedTokens.find(t => t.symbol === symbol)
      if (existingToken) {
        if (existingToken.status === "deleted") {
          setSelectedTokensAndPersist(prev =>
            prev.map(token => {
              if (token.symbol !== symbol) return token
              const hasExchangeNotional =
                token.notional !== undefined && token.notional > 0
              const needsMinimumUsd =
                !hasExchangeNotional &&
                (token.lockedUsd === undefined || token.lockedUsd < MIN_USD)
              return {
                ...token,
                status: hasExchangeNotional ? "untouched" : "idle",
                percentage: token.previousPercentage ?? minPercentFloor,
                previousPercentage: undefined,
                lockedUsd: needsMinimumUsd ? MIN_USD : token.lockedUsd,
              }
            }),
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

      setSelectedTokensAndPersist(prev => [
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
    [selectedTokens, budgetForUi, minPercentFloor, setSelectedTokensAndPersist],
  )

  const handleRemoveToken = useCallback(
    (symbol: string) => {
      setSelectedTokensAndPersist(prev => {
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
    [initialPortfolio, setSelectedTokensAndPersist],
  )

  const handleUndoRemoveToken = useCallback(
    (symbol: string) => {
      setSelectedTokensAndPersist(prev =>
        prev.map(token => {
          if (token.symbol !== symbol) return token
          const hasExchangeNotional =
            token.notional !== undefined && token.notional > 0
          const needsMinimumUsd =
            !hasExchangeNotional &&
            (token.lockedUsd === undefined || token.lockedUsd < MIN_USD)
          return {
            ...token,
            status: hasExchangeNotional ? "untouched" : "idle",
            percentage: token.previousPercentage ?? minPercentFloor,
            previousPercentage: undefined,
            lockedUsd: needsMinimumUsd ? MIN_USD : token.lockedUsd,
          }
        }),
      )
    },
    [minPercentFloor, setSelectedTokensAndPersist],
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

      setSelectedTokensAndPersist(prev =>
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
    [
      selectedTokens,
      activeTokens,
      budgetForUi,
      minPercentFloor,
      setSelectedTokensAndPersist,
    ],
  )

  const handleSideChange = useCallback(
    (symbol: string, side: OrderSide) => {
      setSelectedTokensAndPersist(prev =>
        prev.map(token =>
          token.symbol === symbol ? { ...token, side } : token,
        ),
      )
    },
    [setSelectedTokensAndPersist],
  )

  const handleLeverageChange = useCallback(
    (symbol: string, leverage: number) => {
      const maxLeverage = leverageLimitsMap[symbol] || 1
      const newLeverage = Math.max(1, Math.min(leverage, maxLeverage))
      setSelectedTokensAndPersist(prev =>
        prev.map(token =>
          token.symbol === symbol ? { ...token, leverage: newLeverage } : token,
        ),
      )
    },
    [leverageLimitsMap, setSelectedTokensAndPersist],
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

      setBudgetAndPersist(numValue)
      setIsBudgetInitialized(true)
    },
    [maxBudget, setBudgetAndPersist],
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
        setBudgetAndPersist(numValue)
        setIsBudgetInitialized(true)
        setBudgetError(null)
      }
    }
  }, [
    budgetInput,
    budget,
    maxBudget,
    tokensWithDerivedPercentages.length,
    setBudgetAndPersist,
  ])

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

    setSelectedTokensAndPersist(prev =>
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

        setSelectedTokensAndPersist(updatedTokens)

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

        setSelectedTokensAndPersist(prev =>
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
    setSelectedTokensAndPersist,
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
