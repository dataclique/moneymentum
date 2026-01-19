import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import {
  useHyperliquidBalance,
  useHyperliquidPositions,
  useHyperliquidLeverageLimits,
  useRebalanceHyperliquidPositions,
  type OrderSide,
  type OrderResult,
} from "@/hooks/useTrading"
import { useWallet } from "@/hooks/useWallet"

const STORAGE_KEY_PREFIX = "portfolio-allocation-state"
export const MIN_USD = 11
const MIN_CHANGE_DELTA = 11.0 // Minimum change in USD to trigger a rebalance

export type AllocationStatus =
  | OrderResult["status"]
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
    notional?: number
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

const getStorageKey = (networkMode: string) =>
  `${STORAGE_KEY_PREFIX}-${networkMode}`

const getStoredPortfolio = (
  networkMode: string,
): StoredPortfolioState | null => {
  const stored = localStorage.getItem(getStorageKey(networkMode))
  if (!stored) return null
  try {
    return JSON.parse(stored) as StoredPortfolioState
  } catch {
    return null
  }
}

export const usePortfolioState = (isPrecise: boolean = false) => {
  const { networkMode } = useWallet()

  // Exchange data queries
  const { data: balanceData, isLoading: isBalanceLoading } =
    useHyperliquidBalance()
  const { data: positionsData, isLoading: isPositionsLoading } =
    useHyperliquidPositions()
  const { data: leverageLimitsData, isLoading: isLeverageLimitsLoading } =
    useHyperliquidLeverageLimits()

  // Mutations
  const rebalancePositionsMutation = useRebalanceHyperliquidPositions()

  const [storedDataSnapshot] = useState(() => getStoredPortfolio(networkMode))

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
    useState(false)
  const lastSufficientBudgetRef = useRef(0)

  const persistStateToLocalStorage = useCallback(
    (budgetVal: number, tokens: TokenAllocation[]) => {
      const payload = {
        budget: budgetVal,
        tokens: tokens.map(
          ({
            symbol,
            percentage,
            side,
            lockedUsd,
            leverage,
            status,
            notional,
          }) => ({
            symbol,
            percentage,
            side,
            lockedUsd,
            leverage,
            status,
            notional,
          }),
        ),
      }
      localStorage.setItem(getStorageKey(networkMode), JSON.stringify(payload))
    },
    [networkMode],
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
    },
    [persistStateToLocalStorage],
  )

  useEffect(() => {
    if (positionsLoadedFromExchange) return
    if (isPositionsLoading || !positionsData?.positions) return

    const exchangeTokens: TokenAllocation[] = positionsData.positions.map(
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

    if (storedDataSnapshot && storedDataSnapshot.tokens.length > 0) {
      // Merge localStorage with exchange positions
      const storedSymbols = new Set(
        storedDataSnapshot.tokens.map(t => t.symbol),
      )

      // Start with localStorage tokens (preserving user's customizations)
      const mergedTokens: TokenAllocation[] = storedDataSnapshot.tokens.map(
        token => ({
          ...token,
          leverage: token.leverage || 1,
          lockedUsd:
            token.lockedUsd === undefined || token.lockedUsd < MIN_USD
              ? MIN_USD
              : token.lockedUsd,
          status: "untouched" as const,
          message: null,
        }),
      )

      // Add exchange positions that are NOT in localStorage (e.g., positions removed from UI but still on exchange)
      for (const exchangeToken of exchangeTokens) {
        if (!storedSymbols.has(exchangeToken.symbol)) {
          mergedTokens.push(exchangeToken)
        } else {
          // Update notional from exchange for existing tokens
          const idx = mergedTokens.findIndex(
            t => t.symbol === exchangeToken.symbol,
          )
          if (idx !== -1) {
            mergedTokens[idx] = {
              ...mergedTokens[idx],
              notional: exchangeToken.notional,
            }
          }
        }
      }

      setSelectedTokens(mergedTokens)
      // Baseline portfolio = only tokens that exist on exchange (for comparison)
      // Tokens only in localStorage will be treated as "idle" (new tokens)
      // But we need to match lockedUsd values from mergedTokens for accurate comparison
      const initialPortfolioTokens = exchangeTokens.map(exchangeToken => {
        const mergedToken = mergedTokens.find(
          t => t.symbol === exchangeToken.symbol,
        )
        return mergedToken ?? exchangeToken
      })
      setInitialPortfolio(initialPortfolioTokens)
    } else if (exchangeTokens.length > 0) {
      // No localStorage data, use exchange positions
      setSelectedTokens(exchangeTokens)
      // Baseline portfolio = what the user sees initially in the UI
      setInitialPortfolio(exchangeTokens)
      const totalSpent = positionsData.totalNotional
      if (totalSpent > 0 && !isBudgetInitialized) {
        setBudget(totalSpent)
        setBudgetInput(totalSpent.toString())
        setIsBudgetInitialized(true)
      }
    }

    setPositionsLoadedFromExchange(true)
  }, [
    positionsData,
    isPositionsLoading,
    storedDataSnapshot,
    isBudgetInitialized,
    positionsLoadedFromExchange,
  ])

  // Initialize budget from balance if not set from positions
  useEffect(() => {
    if (!isBudgetInitialized && positionsLoadedFromExchange) {
      if (typeof balanceData === "number" && balanceData > 0) {
        setBudget(balanceData)
        setBudgetInput(balanceData.toString())
        setIsBudgetInitialized(true)
      }
    }
  }, [balanceData, isBudgetInitialized, positionsLoadedFromExchange])

  const tokensWithComputedStatus = useMemo(() => {
    // If no exchange data to compare against, treat "untouched" tokens as "idle"
    // so they can be submitted for rebalancing
    if (initialPortfolio.length === 0) {
      return selectedTokens.map(token =>
        token.status === "untouched"
          ? { ...token, status: "idle" as const }
          : token,
      )
    }

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
        // Token doesn't exist in initial portfolio - treat as new (idle)
        if (!initialToken && currentToken.status === "untouched") {
          return { ...currentToken, status: "idle" as const }
        }
        return currentToken
      }

      // Use getTokenUsdAllocation to compare actual USD values
      // This handles tokens with notional vs lockedUsd correctly
      // Use budget directly (budgetForUi isn't available yet in this useMemo)
      const comparisonBudget = budget > 0 ? budget : MIN_USD
      const currentUsd = getTokenUsdAllocation(currentToken, comparisonBudget)
      const initialUsd = getTokenUsdAllocation(initialToken, comparisonBudget)

      const isModified =
        Math.abs(currentUsd - initialUsd) > 0.01 ||
        currentToken.side !== initialToken.side ||
        currentToken.leverage !== initialToken.leverage

      const computedStatus: "modified" | "untouched" = isModified
        ? "modified"
        : "untouched"

      console.log("[Portfolio] status computation", {
        symbol: currentToken.symbol,
        initialUsd,
        currentUsd,
        usdDelta: currentUsd - initialUsd,
        sideChanged: currentToken.side !== initialToken.side,
        leverageChanged: currentToken.leverage !== initialToken.leverage,
        isModified,
        previousStatus: currentToken.status,
        computedStatus,
      })

      if (currentToken.status !== computedStatus) {
        return { ...currentToken, status: computedStatus }
      }

      return currentToken
    })
  }, [selectedTokens, initialPortfolio, budget])

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
  const maxBudget = (balanceData ?? 0) * 5

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

  const tokensWithDerivedPercentages = useMemo(() => {
    if (budgetForUi <= 0) return tokensWithComputedStatus

    return tokensWithComputedStatus.map(token => {
      if (token.status === "deleted") return token

      const referenceUsd =
        token.notional !== undefined && token.notional > 0
          ? token.notional
          : token.lockedUsd

      if (referenceUsd === undefined || referenceUsd < 0) return token

      const derivedPercent = parseFloat(
        ((referenceUsd / budgetForUi) * 100).toFixed(2),
      )
      if (
        !Number.isFinite(derivedPercent) ||
        Math.abs(derivedPercent - token.percentage) <= 0.01
      ) {
        return token
      }

      return { ...token, percentage: derivedPercent }
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
    if (!leverageLimitsData) return map
    for (const item of leverageLimitsData) {
      map[item.symbol] = item.maxLeverage
    }
    return map
  }, [leverageLimitsData])

  const tokensBelowMinimum = useMemo(() => {
    if (budgetForUi <= 0) return []
    return derivedActiveTokens
      .filter(token => {
        const usdValue = getTokenUsdAllocation(token, budgetForUi)
        return usdValue > 0 && usdValue < MIN_USD
      })
      .map(token => ({
        symbol: token.symbol,
        usdValue: getTokenUsdAllocation(token, budgetForUi),
      }))
  }, [derivedActiveTokens, budgetForUi])

  const hasPositionsBelowMinimum = tokensBelowMinimum.length > 0
  const hasBlockingBudgetIssue =
    budgetBelowMinimum ||
    insufficientBudgetForTokens ||
    hasPositionsBelowMinimum

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
  if (hasPositionsBelowMinimum) {
    const tokensList = tokensBelowMinimum
      .map(t => `${t.symbol} ($${t.usdValue.toFixed(2)})`)
      .join(", ")
    blockingReasons.push(
      `Each position must be at least $${String(MIN_USD)}. Positions below minimum: ${tokensList}`,
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

      const maxLeverageForSymbol = leverageLimitsMap[symbol] || 1

      setSelectedTokensAndPersist(prev => [
        ...prev,
        {
          symbol,
          percentage: initialPercent,
          side: "buy",
          leverage: maxLeverageForSymbol,
          status: "idle",
          message: null,
          notional: undefined,
          lockedUsd: initialUsd,
        },
      ])
    },
    [
      selectedTokens,
      budgetForUi,
      minPercentFloor,
      leverageLimitsMap,
      setSelectedTokensAndPersist,
    ],
  )

  const handleRemoveToken = useCallback(
    (symbol: string) => {
      setSelectedTokensAndPersist(prev => {
        const token = prev.find(t => t.symbol === symbol)
        if (!token) return prev

        const existsOnExchange =
          initialPortfolio.some(it => it.symbol === symbol) ||
          (token.notional !== undefined && token.notional > 0)

        // If token exists on exchange, mark as deleted so it gets closed
        // Otherwise, just remove it from the list
        if (!existsOnExchange) {
          return prev.filter(t => t.symbol !== symbol)
        }

        return prev.map(t =>
          t.symbol === symbol
            ? {
                ...t,
                status: "deleted" as const,
                previousPercentage: t.percentage,
                percentage: 0,
                message: null,
              }
            : t,
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
    console.log("[Portfolio] handleOpenPositions called", {
      budget,
      isPrecise,
      hasBlockingBudgetIssue,
      derivedTotalPercent,
      hasPendingDeletions,
      isPending: rebalancePositionsMutation.isPending,
      tokensWithDerivedPercentages,
      initialPortfolio,
    })

    if (
      !tokensWithDerivedPercentages.length ||
      budget <= 0 ||
      hasBlockingBudgetIssue ||
      (derivedTotalPercent <= 0 && !hasPendingDeletions) ||
      rebalancePositionsMutation.isPending
    ) {
      console.log("[Portfolio] handleOpenPositions: early return guard hit")
      return
    }

    // Check for positions with changes less than $11 (only if precise is off)
    if (!isPrecise) {
      const tokensWithSmallChangesOnSubmit =
        tokensWithDerivedPercentages.filter(token => {
          // Only check tokens that would be modified (not deleted, not untouched)
          if (token.status === "deleted" || token.status === "untouched") {
            return false
          }

          const targetValue = getTokenUsdAllocation(token, budgetForUi)
          const initialToken = initialPortfolio.find(
            it => it.symbol === token.symbol,
          )

          if (!initialToken) {
            // New position - check if target value is at least MIN_CHANGE_DELTA
            return targetValue > 0 && targetValue < MIN_CHANGE_DELTA
          }

          // Existing position - check if change delta is too small
          const currentValue = getTokenUsdAllocation(initialToken, budgetForUi)
          const delta = Math.abs(targetValue - currentValue)

          // Also check if side or leverage changed (those would require action)
          const sideChanged = token.side !== initialToken.side
          const leverageChanged = token.leverage !== initialToken.leverage

          // If side or leverage changed, we need to act regardless of delta
          if (sideChanged || leverageChanged) {
            return false
          }

          // If delta is too small, mark as error
          return delta > 0 && delta < MIN_CHANGE_DELTA
        })

      console.log("[Portfolio] handleOpenPositions: small-change check", {
        tokensWithSmallChangesOnSubmit,
      })

      // If there are positions with small changes, set error messages and return
      if (tokensWithSmallChangesOnSubmit.length > 0) {
        setSelectedTokensAndPersist(prev =>
          prev.map(token => {
            const hasSmallChange = tokensWithSmallChangesOnSubmit.some(
              t => t.symbol === token.symbol,
            )
            if (!hasSmallChange) return token

            const targetValue = getTokenUsdAllocation(token, budgetForUi)
            const initialToken = initialPortfolio.find(
              it => it.symbol === token.symbol,
            )
            const currentValue = initialToken
              ? getTokenUsdAllocation(initialToken, budgetForUi)
              : 0
            const delta = Math.abs(targetValue - currentValue)

            if (currentValue === 0) {
              return {
                ...token,
                message: `New position value ($${targetValue.toFixed(2)}) is below minimum change of $${MIN_CHANGE_DELTA.toFixed(2)}`,
              }
            }
            return {
              ...token,
              message: `Change ($${delta.toFixed(2)}) is below minimum of $${MIN_CHANGE_DELTA.toFixed(2)}`,
            }
          }),
        )
        return
      }
    }

    const mapStatusForApi = (
      status: AllocationStatus,
    ): "untouched" | "modified" | "idle" | "deleted" | "working" => {
      if (status === "filled" || status === "failed") return "idle"
      return status
    }

    // Only send tokens that actually changed compared to the initial portfolio state
    const tokensForApi = tokensWithDerivedPercentages.filter(token => {
      const inInitial = initialPortfolio.find(it => it.symbol === token.symbol)
      return token.status !== "untouched" || !inInitial
    })

    console.log("[Portfolio] handleOpenPositions: tokensForApi", {
      tokensForApi,
    })

    // Nothing to do: no modifications, creations, or deletions
    if (!tokensForApi.length) {
      return
    }

    const payload = {
      budget,
      precise: isPrecise,
      positions: tokensForApi.map(token => ({
        symbol: token.symbol,
        side: token.side,
        percentage: token.percentage / 100,
        leverage: token.leverage,
        status: mapStatusForApi(token.status),
      })),
    }

    console.log("[Portfolio] handleOpenPositions: payload", payload)

    setSelectedTokensAndPersist(prev =>
      prev.map(token => {
        const isInPayload = tokensForApi.some(t => t.symbol === token.symbol)
        if (!isInPayload) {
          return token
        }

        return {
          ...token,
          status: token.status === "deleted" ? "deleted" : "working",
          message: null,
        }
      }),
    )

    rebalancePositionsMutation.mutate(payload, {
      onSuccess: data => {
        console.log("[Portfolio] handleOpenPositions: success", {
          orders: data.orders,
        })

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
      },
      onError: error => {
        console.error("[Portfolio] handleOpenPositions: error", error)

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
    budgetForUi,
    hasBlockingBudgetIssue,
    derivedTotalPercent,
    hasPendingDeletions,
    initialPortfolio,
    isPrecise,
    rebalancePositionsMutation,
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

    // Loading states
    isBalanceLoading,
    isPositionsLoading,
    isLeverageLimitsLoading,

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
