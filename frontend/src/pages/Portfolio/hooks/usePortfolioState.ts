import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import {
  useHyperliquidAccountSummary,
  useHyperliquidPositions,
  useHyperliquidLeverageLimits,
  useRebalanceHyperliquidPositions,
  type OrderSide,
  type OrderResult,
} from "@/hooks/useTrading"
import { useWallet } from "@/hooks/useWallet"

const STORAGE_KEY_PREFIX = "portfolio-allocation-state"
export const MIN_USD = 11
export const MIN_CHANGE_DELTA = 11.0 // Minimum change in USD to trigger a rebalance

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
  // Delta tracking for UI display
  targetNotional?: number
  currentNotional?: number
  deltaInsufficient?: boolean
}

interface StoredPortfolioState {
  crossAccountLeverage: number
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

const MIN_CROSS_ACCOUNT_LEVERAGE = 0.1
const MAX_CROSS_ACCOUNT_LEVERAGE = 5
const DEFAULT_CROSS_ACCOUNT_LEVERAGE = 1
const LEVERAGE_COOKIE_NAME = "portfolio-cross-account-leverage"

const getLeverageFromCookie = (): number => {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${LEVERAGE_COOKIE_NAME}=([^;]*)`),
  )
  if (!match) return DEFAULT_CROSS_ACCOUNT_LEVERAGE
  const value = parseFloat(match[1])
  if (Number.isNaN(value)) return DEFAULT_CROSS_ACCOUNT_LEVERAGE
  return Math.max(
    MIN_CROSS_ACCOUNT_LEVERAGE,
    Math.min(MAX_CROSS_ACCOUNT_LEVERAGE, value),
  )
}

const setLeverageCookie = (value: number) => {
  const maxAge = 365 * 24 * 60 * 60 // 1 year
  document.cookie = `${LEVERAGE_COOKIE_NAME}=${value}; path=/; max-age=${maxAge}; SameSite=Lax`
}

const getTokenUsdAllocation = (
  token: TokenAllocation,
  targetNotional: number,
) => {
  if (token.notional !== undefined && token.notional > 0) return token.notional
  if (token.lockedUsd !== undefined) return token.lockedUsd
  if (targetNotional > 0) return (token.percentage / 100) * targetNotional
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
  const { data: accountSummaryData, isLoading: isBalanceLoading } =
    useHyperliquidAccountSummary()
  const { data: positionsData, isLoading: isPositionsLoading } =
    useHyperliquidPositions()
  const { data: leverageLimitsData, isLoading: isLeverageLimitsLoading } =
    useHyperliquidLeverageLimits()

  // Mutations
  const rebalancePositionsMutation = useRebalanceHyperliquidPositions()

  const [storedDataSnapshot] = useState(() => getStoredPortfolio(networkMode))

  // crossAccountLeverage is initialized from cookie, default to 1
  const [crossAccountLeverage, setCrossAccountLeverage] = useState(
    getLeverageFromCookie,
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

  // Derive accountValue from account summary
  const accountValue = useMemo(
    () => accountSummaryData?.accountValue ?? 0,
    [accountSummaryData],
  )

  // Compute targetNotional = accountValue * crossAccountLeverage (used for percentage calculations)
  const targetNotional = useMemo(
    () => accountValue * crossAccountLeverage,
    [accountValue, crossAccountLeverage],
  )

  const persistStateToLocalStorage = useCallback(
    (leverageVal: number, tokens: TokenAllocation[]) => {
      const payload = {
        crossAccountLeverage: leverageVal,
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

  const latestCrossAccountLeverageRef = useRef(crossAccountLeverage)
  const latestSelectedTokensRef = useRef(selectedTokens)
  latestCrossAccountLeverageRef.current = crossAccountLeverage
  latestSelectedTokensRef.current = selectedTokens

  const setSelectedTokensAndPersist = useCallback(
    (updater: React.SetStateAction<TokenAllocation[]>) => {
      setSelectedTokens(prev => {
        const newTokens =
          typeof updater === "function" ? updater(prev) : updater
        persistStateToLocalStorage(
          latestCrossAccountLeverageRef.current,
          newTokens,
        )
        return newTokens
      })
    },
    [persistStateToLocalStorage],
  )

  const setCrossAccountLeverageAndPersist = useCallback(
    (newLeverage: number) => {
      const clampedLeverage = Math.max(
        MIN_CROSS_ACCOUNT_LEVERAGE,
        Math.min(MAX_CROSS_ACCOUNT_LEVERAGE, newLeverage),
      )
      setCrossAccountLeverage(clampedLeverage)
      setLeverageCookie(clampedLeverage)
      persistStateToLocalStorage(
        clampedLeverage,
        latestSelectedTokensRef.current,
      )
    },
    [persistStateToLocalStorage],
  )

  useEffect(() => {
    const effectStartTime = performance.now()
    console.log("[usePortfolioState] positions useEffect triggered")

    if (positionsLoadedFromExchange) {
      console.log("[usePortfolioState] positions already loaded, skipping")
      return
    }
    if (isPositionsLoading || !positionsData?.positions) {
      console.log("[usePortfolioState] positions still loading or no data")
      return
    }

    console.log(
      `[usePortfolioState] processing ${positionsData.positions.length} positions from exchange`,
    )

    const mapStartTime = performance.now()
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
    console.log(
      `[usePortfolioState] mapping exchangeTokens took ${(performance.now() - mapStartTime).toFixed(2)}ms`,
    )

    // Always set initialPortfolio from exchange (source of truth for what exists on exchange)
    setInitialPortfolio(exchangeTokens)

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
    }

    setPositionsLoadedFromExchange(true)
    console.log(
      `[usePortfolioState] positions useEffect completed in ${(performance.now() - effectStartTime).toFixed(2)}ms`,
    )
  }, [
    positionsData,
    isPositionsLoading,
    storedDataSnapshot,
    positionsLoadedFromExchange,
  ])

  // Initialize budget from balance if not set from positions
  useEffect(() => {
    if (positionsLoadedFromExchange) {
    }
  }, [positionsLoadedFromExchange])

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
      const comparisonBudget = targetNotional > 0 ? targetNotional : MIN_USD
      const currentUsd = getTokenUsdAllocation(currentToken, comparisonBudget)
      const initialUsd = getTokenUsdAllocation(initialToken, comparisonBudget)

      const isModified =
        Math.abs(currentUsd - initialUsd) > 0.01 ||
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
  }, [selectedTokens, initialPortfolio, targetNotional])

  const activeTokens = useMemo(
    () => tokensWithComputedStatus.filter(t => t.status !== "deleted"),
    [tokensWithComputedStatus],
  )

  const hasPendingDeletions = useMemo(
    () => tokensWithComputedStatus.some(t => t.status === "deleted"),
    [tokensWithComputedStatus],
  )

  const requiredNotionalForTokens = activeTokens.length * MIN_USD
  const notionalIsPositive = targetNotional > 0
  const notionalBelowMinimum =
    activeTokens.length > 0 && notionalIsPositive && targetNotional < MIN_USD
  const insufficientNotionalForTokens =
    activeTokens.length > 0 &&
    notionalIsPositive &&
    requiredNotionalForTokens > targetNotional

  // displayNotional is targetNotional, falling back to a minimum if needed for UI
  const displayNotional = useMemo(() => {
    if (targetNotional > 0) {
      return targetNotional
    }
    if (activeTokens.length === 0) {
      return 0
    }
    return Math.max(requiredNotionalForTokens, MIN_USD)
  }, [targetNotional, requiredNotionalForTokens, activeTokens.length])

  const minPercentOfNotional =
    displayNotional > 0 ? Math.min(100, (MIN_USD / displayNotional) * 100) : 0
  const minPercentFloor = displayNotional >= MIN_USD ? minPercentOfNotional : 0

  const tokensWithDerivedPercentages = useMemo(() => {
    if (displayNotional <= 0) return tokensWithComputedStatus

    return tokensWithComputedStatus.map(token => {
      if (token.status === "deleted") return token
      const referenceUsd =
        token.notional !== undefined && token.notional > 0
          ? token.notional
          : token.lockedUsd
      if (referenceUsd === undefined || referenceUsd < 0) return token

      const derivedPercent = parseFloat(
        ((referenceUsd / displayNotional) * 100).toFixed(2),
      )

      if (
        !Number.isFinite(derivedPercent) ||
        Math.abs(derivedPercent - token.percentage) <= 0.01
      ) {
        return token
      }

      return { ...token, percentage: derivedPercent }
    })
  }, [tokensWithComputedStatus, targetNotional])

  // Compute delta tracking for each token to show when adjustments are too small
  const tokensWithDeltaTracking = useMemo(() => {
    return tokensWithDerivedPercentages.map(token => {
      if (token.status === "deleted") return token

      // Current notional from exchange (what exists on exchange now)
      // Look up from initialPortfolio to get the actual exchange position
      const exchangePosition = initialPortfolio.find(
        p => p.symbol === token.symbol,
      )
      const currentNotional = exchangePosition?.notional ?? 0

      // Target notional based on percentage and total notional
      const targetNotional =
        displayNotional > 0 ? (token.percentage / 100) * displayNotional : 0

      // Check if the delta is too small to execute
      const delta = Math.abs(targetNotional - currentNotional)
      // Delta is insufficient if:
      // 1. There's a difference (not exactly matching)
      // 2. The difference is below the minimum order size
      // 3. This is a modification (not a new position or deletion)
      const isExistingPosition = currentNotional > 0
      const hasChanges = delta > 0.01 // Small tolerance for floating point
      const deltaInsufficient =
        isExistingPosition && hasChanges && delta < MIN_CHANGE_DELTA

      return {
        ...token,
        targetNotional,
        currentNotional,
        deltaInsufficient,
      }
    })
  }, [tokensWithDerivedPercentages, displayNotional, initialPortfolio])

  const derivedActiveTokens = useMemo(
    () => tokensWithDeltaTracking.filter(t => t.status !== "deleted"),
    [tokensWithDeltaTracking],
  )
  const derivedTotalPercent = derivedActiveTokens.reduce(
    (acc, token) => acc + token.percentage,
    0,
  )
  const derivedRemainingPercent = Math.max(0, 100 - derivedTotalPercent)

  // Total notional = sum of all position notionals (actual exchange positions)
  const totalNotional = useMemo(
    () => derivedActiveTokens.reduce((sum, token) => sum + (token.notional ?? 0), 0),
    [derivedActiveTokens],
  )

  const leverageLimitsMap = useMemo(() => {
    const map: Record<string, number> = {}
    if (!leverageLimitsData) return map
    for (const item of leverageLimitsData) {
      map[item.symbol] = item.maxLeverage
    }
    return map
  }, [leverageLimitsData])

  const tokensBelowMinimum = useMemo(() => {
    if (targetNotional <= 0) return []
    return derivedActiveTokens
      .filter(token => {
        const usdValue = getTokenUsdAllocation(token, targetNotional)
        if (token.status === "untouched") {
          return false
        }
        return usdValue > 0 && usdValue < MIN_USD
      })
      .map(token => ({
        symbol: token.symbol,
        usdValue: getTokenUsdAllocation(token, targetNotional),
      }))
  }, [derivedActiveTokens, targetNotional])

  const hasPositionsBelowMinimum = tokensBelowMinimum.length > 0
  const hasBlockingNotionalIssue =
    notionalBelowMinimum ||
    insufficientNotionalForTokens ||
    hasPositionsBelowMinimum

  const blockingReasons: string[] = []
  if (notionalBelowMinimum) {
    blockingReasons.push(
      "Minimum total notional is $11. Increase leverage or add funds.",
    )
  }
  if (insufficientNotionalForTokens) {
    blockingReasons.push(
      `Not enough notional for all positions. Need at least $${String(requiredNotionalForTokens)}.`,
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

      const initialPercent =
        targetNotional > 0
          ? parseFloat(((MIN_USD / targetNotional) * 100).toFixed(2))
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
          lockedUsd: MIN_USD,
        },
      ])
    },
    [
      targetNotional,
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
    (symbol: string, percentage: number) => {
      if (Number.isNaN(percentage) || percentage < 0) return

      const targetToken = selectedTokens.find(token => token.symbol === symbol)
      if (!targetToken) return

      // Calculate other tokens' total percentage
      const otherTokensPercent = activeTokens.reduce((sum, token) => {
        if (token.symbol === symbol) return sum
        return sum + token.percentage
      }, 0)

      // Max percentage for this token: 100% minus other tokens' allocations
      const maxPercent = Math.max(0, 100 - otherTokensPercent)

      // Clamp to valid range
      const clampedPercent = Math.max(
        minPercentFloor,
        Math.min(percentage, maxPercent),
      )

      setSelectedTokensAndPersist(prev =>
        prev.map(token => {
          if (token.symbol !== symbol) return token
          const finalPercent = parseFloat(
            Math.max(0, clampedPercent).toFixed(2),
          )
          return {
            ...token,
            percentage: finalPercent,
            notional: undefined,
            lockedUsd: undefined,
            message: null,
          }
        }),
      )
    },
    [
      selectedTokens,
      activeTokens,
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

  const handleCrossAccountLeverageChange = useCallback(
    (value: number) => {
      setCrossAccountLeverageAndPersist(value)
    },
    [setCrossAccountLeverageAndPersist],
  )

  const handleOpenPositions = useCallback(() => {
    const rebalanceStartTime = performance.now()
    console.log("[Rebalance] handleOpenPositions called", {
      timestamp: new Date().toISOString(),
    })

    if (
      !tokensWithDeltaTracking.length ||
      accountValue <= 0 ||
      hasBlockingNotionalIssue ||
      (derivedTotalPercent <= 0 && !hasPendingDeletions) ||
      rebalancePositionsMutation.isPending
    ) {
      console.log("[Rebalance] Early return - validation failed")
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

          const targetValue = getTokenUsdAllocation(token, targetNotional)
          const initialToken = initialPortfolio.find(
            it => it.symbol === token.symbol,
          )

          if (!initialToken) {
            // New position - check if target value is at least MIN_CHANGE_DELTA
            return targetValue > 0 && targetValue < MIN_CHANGE_DELTA
          }

          // Existing position - check if change delta is too small
          const currentValue = getTokenUsdAllocation(
            initialToken,
            targetNotional,
          )
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

      // If there are positions with small changes, set error messages and return
      if (tokensWithSmallChangesOnSubmit.length > 0) {
        setSelectedTokensAndPersist(prev =>
          prev.map(token => {
            const hasSmallChange = tokensWithSmallChangesOnSubmit.some(
              t => t.symbol === token.symbol,
            )
            if (!hasSmallChange) return token

            const targetValue = getTokenUsdAllocation(token, targetNotional)
            const initialToken = initialPortfolio.find(
              it => it.symbol === token.symbol,
            )
            const currentValue = initialToken
              ? getTokenUsdAllocation(initialToken, targetNotional)
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
              message: `Change ($${delta.toFixed(2)}) is below minimum of $${MIN_CHANGE_DELTA.toFixed(2)}. Use precise mode to open this position.`,
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

    // Nothing to do: no modifications, creations, or deletions
    if (!tokensForApi.length) {
      return
    }

    const payload = {
      accountValue,
      crossAccountLeverage,
      precise: isPrecise,
      positions: tokensWithDeltaTracking.map(token => {
        const exchangePosition = initialPortfolio.find(
          p => p.symbol === token.symbol,
        )
        return {
          symbol: token.symbol,
          side: token.side,
          leverage: token.leverage,
          leverageChanged: exchangePosition
            ? token.leverage !== exchangePosition.leverage
            : true,
          currentNotional: exchangePosition?.notional,
          percentage: token.percentage / 100,
          status: mapStatusForApi(token.status),
        }
      }),
    }

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

    const mutationCallTime = performance.now()
    console.log("[Rebalance] Calling mutation.mutate()", {
      preparationTime: `${(mutationCallTime - rebalanceStartTime).toFixed(2)}ms`,
      positions: payload.positions.length,
      accountValue: payload.accountValue,
      crossAccountLeverage: payload.crossAccountLeverage,
      precise: payload.precise,
    })

    rebalancePositionsMutation.mutate(payload, {
      onSuccess: data => {
        const successTime = performance.now()
        console.log("[Rebalance] Mutation onSuccess", {
          totalTime: `${(successTime - rebalanceStartTime).toFixed(2)}ms`,
          networkTime: `${(successTime - mutationCallTime).toFixed(2)}ms`,
          ordersCount: data.orders.length,
          orders: data.orders.map(o => ({
            symbol: o.symbol,
            status: o.status,
          })),
        })

        const updatedTokens = tokensWithDeltaTracking
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
        const errorTime = performance.now()
        console.error("[Rebalance] Mutation onError", {
          totalTime: `${(errorTime - rebalanceStartTime).toFixed(2)}ms`,
          networkTime: `${(errorTime - mutationCallTime).toFixed(2)}ms`,
          error: error.message,
        })

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
    tokensWithDeltaTracking,
    accountValue,
    crossAccountLeverage,
    hasBlockingNotionalIssue,
    derivedTotalPercent,
    hasPendingDeletions,
    initialPortfolio,
    isPrecise,
    rebalancePositionsMutation,
    setSelectedTokensAndPersist,
  ])

  const netExposure = derivedActiveTokens.reduce((acc, token) => {
    const usdValue = getTokenUsdAllocation(token, targetNotional)
    return acc + (token.side === "buy" ? usdValue : -usdValue)
  }, 0)

  const disableSubmit =
    !tokensWithDeltaTracking.length ||
    accountValue <= 0 ||
    rebalancePositionsMutation.isPending ||
    (derivedTotalPercent <= 0 && !hasPendingDeletions) ||
    hasBlockingNotionalIssue ||
    derivedTotalPercentExceeds100

  return {
    // State
    accountValue,
    crossAccountLeverage,
    totalNotional,
    displayNotional,
    selectedTokens: tokensWithDeltaTracking,
    activeTokens: derivedActiveTokens,
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
    handleCrossAccountLeverageChange,
    handleOpenPositions,
  }
}
