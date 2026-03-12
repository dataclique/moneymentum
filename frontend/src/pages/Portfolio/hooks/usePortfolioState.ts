import { createEffect, createMemo, createSignal, untrack } from "solid-js"
import Decimal from "decimal.js"
import {
  useHyperliquidAccountSummary,
  useHyperliquidPositions,
  useHyperliquidLeverageLimits,
  useRebalanceHyperliquidPositions,
  type OrderSide,
  type OrderResult,
} from "@/hooks/useTrading"
import { useWallet } from "@/hooks/useWallet"
import { createStore } from "solid-js/store"

export const MIN_USD = 11
export const MIN_CHANGE_DELTA = 11.0 // Minimum change in USD to trigger a rebalance
// Allow sum of weights slightly above 100% due to rounding (e.g. 33.33 + 33.33 + 33.34 = 100.00)
const MAX_TOTAL_PERCENT_TOLERANCE = 0.1

const roundNotional = (n: number): number =>
  new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()

export type AllocationStatus =
  | OrderResult["status"]
  | "idle" //TODO: what is this status?
  | "untouched"
  | "deleted"
  | "modified"

export interface TokenAllocation {
  symbol: string
  percentage?: number
  side: OrderSide
  leverage: number
  status: AllocationStatus
  message?: string | null
  notional: number
  lockedUsd?: number
  previousPercentage?: number
  previousNotional?: number
  // Delta tracking for UI display
  targetNotional?: number
  currentNotional?: number
  deltaInsufficient?: boolean
}

export interface CurrentPortfolioInterface {
  symbol: string
  side: OrderSide
  leverage: number
  notional: number
}

export interface TargetPortfolioInterface extends CurrentPortfolioInterface {
  status: AllocationStatus
}

const MAX_CROSS_ACCOUNT_LEVERAGE = 5
const DEFAULT_CROSS_ACCOUNT_LEVERAGE = 1

const getTokenUsdAllocation = (
  token: TokenAllocation,
  targetNotional: number,
) => {
  if (token.notional !== undefined && token.notional > 0) return token.notional
  if (token.lockedUsd !== undefined) return token.lockedUsd
  if (targetNotional > 0) {
    return new Decimal(token.percentage)
      .div(100)
      .mul(targetNotional)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toNumber()
  }
  return 0
}

// Calculate total notional from active (non-deleted) tokens
const calcTotalNotional = (tokens: TokenAllocation[]): number =>
  tokens
    .reduce((sum, t) => {
      if (t.status === "deleted") return sum
      return sum.plus(t.notional ?? 0)
    }, new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber()

// Calculate percentage from notional and total
const calcPercentage = (notional: number, totalNotional: number): number => {
  if (totalNotional <= 0) return 0
  return new Decimal(notional)
    .div(totalNotional)
    .mul(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber()
}

// Recalculate percentages for all tokens based on their notional values
// Returns updated tokens and the total notional. Notionals are rounded to 2 decimals.
const recalculateFromNotionals = (
  tokens: TokenAllocation[],
): { tokens: TokenAllocation[]; totalNotional: number } => {
  const totalNotional = calcTotalNotional(tokens)
  const updatedTokens = tokens.map(t => {
    if (t.status === "deleted" || t.notional === undefined) return t
    return {
      ...t,
      notional: t.notional,
      percentage: calcPercentage(t.notional, totalNotional),
    }
  })
  return { tokens: updatedTokens, totalNotional }
}

// Calculate leverage from total notional and account value
const calcLeverage = (totalNotional: number, accountValue: number): number => {
  if (accountValue <= 0) return 1
  const leverage = new Decimal(totalNotional)
    .div(accountValue)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
    .toNumber()
  return Math.min(MAX_CROSS_ACCOUNT_LEVERAGE, leverage)
}

// Calculate notional from percentage and total notional
const calcNotional = (percentage: number, totalNotional: number): number =>
  new Decimal(percentage)
    .div(100)
    .mul(totalNotional)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber()

// Recalculate notionals for all tokens based on their weights and total notional
// Use when leverage changes: totalNotional = leverage * accountValue
const recalculateFromWeights = (
  tokens: TokenAllocation[],
  totalNotional: number,
): TokenAllocation[] =>
  tokens.map(t => {
    if (t.status === "deleted") return t
    return {
      ...t,
      notional: calcNotional(t.percentage, totalNotional),
    }
  })

export const usePortfolioState = (
  isPrecise: () => boolean,
  isWeightRedistribution: () => boolean,
) => {
  const { networkMode, isConnected } = useWallet()

  // Exchange data queries
  const accountSummaryQuery = useHyperliquidAccountSummary()
  const positionsQuery = useHyperliquidPositions()
  const leverageLimitsQuery = useHyperliquidLeverageLimits()

  // Mutations
  const rebalancePositionsMutation = useRebalanceHyperliquidPositions()

  const [crossAccountLeverage, setCrossAccountLeverage] = createSignal(
    DEFAULT_CROSS_ACCOUNT_LEVERAGE,
  )
  const [initialCrossAccountLeverage, setInitialCrossAccountLeverage] =
    createSignal<number | null>(null)

  const [selectedTokens, setSelectedTokens] = createSignal<TokenAllocation[]>(
    [],
  )
  const [isRebalancingUi, setIsRebalancingUi] = createSignal(false)
  const [currentPortfolio, setCurrentPortfolio] = createStore<
    Record<string, CurrentPortfolioInterface>
  >({})
  // symbol -> its parameters in targetPortfolio
  const [targetPortfolio, setTargetPortfolio] = createStore<
    Record<string, TargetPortfolioInterface>
  >({})

  const [positionsLoadedFromExchange, setPositionsLoadedFromExchange] =
    createSignal(false)

  // Track previous connection state for disconnect cleanup
  let wasConnected = isConnected()

  const redistributeWeights = (
    changedSymbol: string,
    newPercentage: number,
    totalNotional: number,
  ) => {
    const active = activeSymbols()

    if (totalNotional <= 0 || !active.includes(changedSymbol)) return

    const clampedNew = Math.max(0, Math.min(100, newPercentage))

    const oldNotional = targetPortfolio[changedSymbol].notional
    const oldPercent = (oldNotional / totalNotional) * 100
    const delta = clampedNew - oldPercent

    const otherActiveSymbols = active.filter(s => s !== changedSymbol)

    const otherTotalPercent = active
      .filter(s => s !== changedSymbol)
      .reduce(
        (sum, s) => sum + (targetPortfolio[s].notional / totalNotional) * 100,
        0,
      )

    const updates: Record<string, any> = {}

    updates[changedSymbol] = {
      ...targetPortfolio[changedSymbol],
      notional: (clampedNew / 100) * totalNotional,
    }

    let remainingPercent = 100 - clampedNew

    otherActiveSymbols.forEach((symbol, index) => {
      let nextPercent: number

      if (index === otherActiveSymbols.length - 1) {
        nextPercent = Math.max(0, remainingPercent)
      } else {
        const currentPercent =
          (targetPortfolio[symbol].notional / totalNotional) * 100

        const proportion =
          otherTotalPercent > 0
            ? currentPercent / otherTotalPercent
            : 1 / otherActiveSymbols.length

        nextPercent = Math.max(0, currentPercent - delta * proportion)
        remainingPercent -= nextPercent
      }

      updates[symbol] = {
        ...targetPortfolio[symbol],
        notional: (nextPercent / 100) * totalNotional,
      }
    })

    setTargetPortfolio(updates)
  }

  // Derived: total notional of target portfolio (sum of per-symbol target notionals)
  // const targetTotalNotional = createMemo(() =>
  //   Object.values(targetPortfolio)
  //     .filter(position => position.status !== 'deleted')
  //     .reduce((sum, position) => sum + position.notional, 0),
  // )

  const activeSymbols = createMemo(() =>
    Object.keys(targetPortfolio).filter(
      s => targetPortfolio[s].status !== "deleted",
    ),
  )

  // TODO: use in future to close positions
  const closingSymbols = createMemo(() =>
    Object.keys(targetPortfolio).filter(
      s => targetPortfolio[s].status === "deleted",
    ),
  )

  const targetTotalNotional = createMemo(() => {
    return activeSymbols().reduce(
      (sum, s) => sum + (targetPortfolio[s].notional || 0),
      0,
    )
  })

  function getTargetPortfolio(): Record<string, TargetPortfolioInterface> {
    // console.table(
    //   Object.values(targetPortfolio).map(position => ({
    //     symbol: position.symbol,
    //     side: position.side,
    //     leverage: position.leverage,
    //     status: position.status,
    //     notional: position.notional,
    //   })),
    // )
    return targetPortfolio
  }

  // createEffect: disconnect cleanup - detect falling edge from connected to disconnected
  createEffect(() => {
    const currentlyConnected = isConnected()
    const previouslyConnected = wasConnected
    wasConnected = currentlyConnected

    if (!previouslyConnected || currentlyConnected) {
      return
    }

    setSelectedTokens([])
    setCurrentPortfolio([])
    setCrossAccountLeverage(DEFAULT_CROSS_ACCOUNT_LEVERAGE)
    setInitialCrossAccountLeverage(null)
    setPositionsLoadedFromExchange(false)
  })

  // Derive accountValue from account summary
  const accountValue = createMemo(
    () => accountSummaryQuery.data?.accountValue ?? 0,
  )

  // Compute targetNotional = accountValue * crossAccountLeverage (used for percentage calculations)
  const targetNotional = createMemo(() =>
    new Decimal(accountValue())
      .mul(crossAccountLeverage())
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toNumber(),
  )

  // Mutable ref kept in sync with crossAccountLeverage signal via createEffect.
  // Avoids stale closures in callbacks that read leverage without re-subscribing.
  let latestCrossAccountLeverage = untrack(crossAccountLeverage)

  // createEffect: sync mutable ref with signal so downstream functions read current value
  createEffect(() => {
    latestCrossAccountLeverage = crossAccountLeverage()
  })

  const setSelectedTokensAndPersist = (
    updater:
      | TokenAllocation[]
      | ((prev: TokenAllocation[]) => TokenAllocation[]),
  ) => {
    setSelectedTokens(prev =>
      typeof updater === "function" ? updater(prev) : updater,
    )
  }

  // Helper: recalculate percentages from notionals and update leverage
  // Use this when notional values change (add/remove/edit token notional)
  const updateByNotionalChange = (
    tokens: TokenAllocation[],
  ): TokenAllocation[] => {
    const { tokens: updatedTokens, totalNotional } =
      recalculateFromNotionals(tokens)
    if (accountValue() > 0) {
      const newLeverage = calcLeverage(totalNotional, accountValue())
      setCrossAccountLeverage(newLeverage)
    }
    return updatedTokens
  }

  // Wait for positionsQuery data and positive accountValue, then initialize from exchange positions
  createEffect(() => {
    if (positionsLoadedFromExchange()) {
      return
    }
    const positionsData = positionsQuery.data
    const isPositionsLoading = positionsQuery.isLoading
    if (isPositionsLoading || !positionsData?.positions) {
      return
    }
    // Wait for accountValue to be loaded so we can calculate correct percentages
    if (accountValue() <= 0) {
      return
    }

    // Calculate total notional from all exchange positions first
    const totalExchangeNotional = positionsData.positions.reduce(
      (sum, pos) => sum + pos.notional,
      0,
    )

    // Calculate leverage from the formula: leverage = totalNotional / accountValue
    const initialLeverage = calcLeverage(totalExchangeNotional, accountValue())
    setCrossAccountLeverage(initialLeverage)

    // Map exchange positions to CurrentPortfolioInterface
    const exchangeTokens: CurrentPortfolioInterface[] =
      positionsData.positions.map(pos => ({
        symbol: pos.symbol,
        side: pos.side,
        leverage: pos.leverage || 1,
        notional: pos.notional,
      }))

    // Always set currentPortfolio from exchange (source of truth for what exists on exchange)
    setCurrentPortfolio(
      Object.fromEntries(
        exchangeTokens.map(token => [token.symbol, token]),
      ) as Record<string, CurrentPortfolioInterface>,
    )

    setTargetPortfolio(
      Object.fromEntries(
        exchangeTokens.map(token => [
          token.symbol,
          { ...token, status: "untouched" as const },
        ]),
      ) as Record<string, TargetPortfolioInterface>,
    )

    setPositionsLoadedFromExchange(true)
  })

  const tokensWithComputedStatus = createMemo(() => {
    // If no exchange data to compare against, treat "untouched" tokens as "idle"
    // so they can be submitted for rebalancing
    if (Object.keys(currentPortfolio).length === 0) {
      return selectedTokens().map(token =>
        token.status === "untouched"
          ? { ...token, status: "idle" as const }
          : token,
      )
    }

    return selectedTokens().map(currentToken => {
      const initialToken = currentPortfolio[currentToken.symbol]

      const shouldComputeStatus =
        initialToken &&
        (currentToken.status === "idle" ||
          currentToken.status === "untouched" ||
          currentToken.status === "modified")

      if (!shouldComputeStatus) {
        // Token doesn't exist in initial portfolio - treat as new (idle)
        if (!initialToken && currentToken.status === "untouched") {
          return { ...currentToken, status: "idle" as const }
        }
        return currentToken
      }

      // Compare notional values and other properties to determine if modified
      // Notional comparison is the source of truth for position changes
      const notionalDelta = Math.abs(
        (currentToken.notional ?? 0) - (initialToken.notional ?? 0),
      )
      const isModified =
        notionalDelta > 0.01 ||
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
  })

  const activeTokens = createMemo(() =>
    tokensWithComputedStatus().filter(t => t.status !== "deleted"),
  )

  // Total notional = sum of all position notionals (actual exchange positions)
  // Must be calculated before tokensWithDeltaTracking since it's used there
  const totalNotional = createMemo(() =>
    activeTokens().reduce((sum, token) => sum + token.notional, 0),
  )

  const currentTotalNotional = createMemo(() =>
    Object.values(currentPortfolio).reduce(
      (sum, token) => sum + token.notional,
      0,
    ),
  )

  const hasPendingDeletions = createMemo(() =>
    tokensWithComputedStatus().some(t => t.status === "deleted"),
  )

  const requiredNotionalForTokens = () => activeTokens().length * MIN_USD
  const notionalIsPositive = () => targetNotional() > 0
  const notionalBelowMinimum = () =>
    activeTokens().length > 0 &&
    notionalIsPositive() &&
    targetNotional() < MIN_USD
  const insufficientNotionalForTokens = () =>
    activeTokens().length > 0 &&
    notionalIsPositive() &&
    requiredNotionalForTokens() > targetNotional()

  // displayNotional is targetNotional, falling back to a minimum if needed for UI
  const displayNotional = createMemo(() => {
    if (targetNotional() > 0) {
      return targetNotional()
    }
    if (activeTokens().length === 0) {
      return 0
    }
    return Math.max(requiredNotionalForTokens(), MIN_USD)
  })

  const minPercentOfNotional = () =>
    displayNotional() > 0
      ? Math.min(100, (MIN_USD / displayNotional()) * 100)
      : 0
  const minPercentFloor = () =>
    displayNotional() >= MIN_USD ? minPercentOfNotional() : 0

  // Percentages (weights) are fixed - they only change when user adjusts the slider
  // or when initially loaded from exchange. They do NOT change when leverage changes.
  const tokensWithDerivedPercentages = tokensWithComputedStatus

  // Compute delta tracking for each token to show when adjustments are too small
  const tokensWithDeltaTracking = createMemo(() => {
    return tokensWithDerivedPercentages().map(token => {
      if (token.status === "deleted") return token

      // Current notional from exchange (what exists on exchange now)
      // Look up from currentPortfolio map by symbol
      const exchangePosition = currentPortfolio[token.symbol]
      const currentNotional = exchangePosition?.notional ?? 0

      // Target notional based on percentage and fixed target total (accountValue * leverage)
      const computedTargetNotional =
        targetNotional() > 0
          ? new Decimal(token.percentage)
              .div(100)
              .mul(targetNotional())
              .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
              .toNumber()
          : 0

      // Check if the delta is too small to execute
      const delta = new Decimal(computedTargetNotional)
        .minus(currentNotional)
        .abs()
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toNumber()
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
        targetNotional: computedTargetNotional,
        currentNotional,
        deltaInsufficient,
      }
    })
  })

  type StagedTradeItem = {
    id: string
    underlying: string
    side: OrderSide
    notional: number
    previousWeight?: number
    newWeight?: number
    status: AllocationStatus
    message: string | null
  }

  // Retain last known staged trades to prevent flickering during position reloads
  let lastKnownStagedTrades: StagedTradeItem[] = []

  const stagedTrades = createMemo(() => {
    // Before we have any exchange data, don't show staged trades at all.
    if (
      !positionsLoadedFromExchange() &&
      Object.keys(currentPortfolio).length === 0
    ) {
      return lastKnownStagedTrades
    }

    const trades = tokensWithDeltaTracking()
      .map(token => {
        const initialToken = currentPortfolio[token.symbol]
        const inInitial = initialToken !== undefined

        // Deleted tokens:
        // - if they existed on the exchange (inInitial), this is a full close
        //   of the current position: notional = currentNotional, side = opposite
        // - if they are purely local (newly added then removed), we skip them
        if (token.status === "deleted") {
          if (!initialToken) {
            return null
          }

          const previousNotional = initialToken.notional ?? 0
          const previousWeight = initialToken.percentage / 100

          const closeSide: OrderSide =
            initialToken.side === "buy" ? "sell" : "buy"

          return {
            id: token.symbol,
            underlying: token.symbol,
            side: closeSide,
            notional: previousNotional,
            previousWeight,
            newWeight: 0,
            status: token.status,
            message: token.message ?? null,
          }
        }

        const shouldInclude =
          token.status === "modified" ||
          token.status === "working" ||
          token.status === "failed" ||
          // Newly created positions (no initial snapshot)
          !inInitial

        if (!shouldInclude) {
          return null
        }

        const previousWeight = initialToken
          ? initialToken.percentage / 100
          : undefined
        const newWeight = token.percentage / 100

        const previousNotional = token.currentNotional ?? 0
        const targetNotionalForToken =
          token.targetNotional ?? token.notional ?? 0
        const notionalDelta = Math.abs(
          targetNotionalForToken - previousNotional,
        )

        return {
          id: token.symbol,
          underlying: token.symbol,
          side: token.side,
          notional: notionalDelta,
          previousWeight,
          newWeight,
          status: token.status,
          message: token.message ?? null,
        }
      })
      .filter((trade): trade is NonNullable<typeof trade> => trade !== null)

    // When exchange positions are fully loaded, update the retained snapshot.
    if (positionsLoadedFromExchange()) {
      lastKnownStagedTrades = trades
      return trades
    }

    // While a reload is in progress, keep showing the last known staged trades
    // instead of clearing the panel.
    return lastKnownStagedTrades
  })

  const derivedActiveTokens = createMemo(() =>
    tokensWithDeltaTracking().filter(t => t.status !== "deleted"),
  )
  const derivedTotalPercent = () =>
    derivedActiveTokens().reduce((acc, token) => acc + token.percentage, 0)
  const derivedRemainingPercent = () => Math.max(0, 100 - derivedTotalPercent())

  const leverageLimitsMap = createMemo(() => {
    const map: Record<string, number> = {}
    const limitsData = leverageLimitsQuery.data
    if (!limitsData) return map
    for (const item of limitsData) {
      map[item.symbol] = item.maxLeverage
    }
    return map
  })

  const tokensBelowMinimum = createMemo(() => {
    if (targetNotional() <= 0) return []
    return derivedActiveTokens()
      .filter(token => {
        const usdValue = getTokenUsdAllocation(token, targetNotional())
        if (token.status === "untouched") {
          return false
        }
        return usdValue > 0 && usdValue < MIN_USD
      })
      .map(token => ({
        symbol: token.symbol,
        usdValue: getTokenUsdAllocation(token, targetNotional()),
      }))
  })

  const hasPositionsBelowMinimum = () => tokensBelowMinimum().length > 0
  const hasTotalPercentExceeded = () =>
    derivedTotalPercent() > 100 + MAX_TOTAL_PERCENT_TOLERANCE
  const hasTotalPercentBelow = () =>
    derivedTotalPercent() < 100 - MAX_TOTAL_PERCENT_TOLERANCE
  const showTargetOfTotal = () =>
    Math.abs(derivedTotalPercent() - 100) > MAX_TOTAL_PERCENT_TOLERANCE
  const hasBlockingNotionalIssue = () =>
    notionalBelowMinimum() ||
    insufficientNotionalForTokens() ||
    hasPositionsBelowMinimum() ||
    hasTotalPercentExceeded() ||
    hasTotalPercentBelow()

  const blockingReasons = createMemo(() => {
    const reasons: string[] = []
    if (notionalBelowMinimum()) {
      reasons.push(
        "Minimum total notional is $11. Increase leverage or add funds.",
      )
    }
    if (insufficientNotionalForTokens()) {
      reasons.push(
        `Not enough notional for all positions. Need at least $${String(requiredNotionalForTokens())}.`,
      )
    }
    if (hasPositionsBelowMinimum()) {
      const tokensList = tokensBelowMinimum()
        .map(t => `${t.symbol} ($${t.usdValue.toFixed(2)})`)
        .join(", ")
      reasons.push(
        `Each position must be at least $${String(MIN_USD)}. Positions below minimum: ${tokensList}`,
      )
    }
    if (hasTotalPercentExceeded()) {
      const excessPercent = (derivedTotalPercent() - 100).toFixed(1)
      reasons.push(
        `Sum of weights exceeds 100% by ${excessPercent}%. Reduce allocations.`,
      )
    }
    if (hasTotalPercentBelow()) {
      const deficitPercent = (100 - derivedTotalPercent()).toFixed(1)
      reasons.push(
        `Sum of weights is below 100% by ${deficitPercent}%. Add allocations.`,
      )
    }
    return reasons
  })

  const handleAddToken = (symbol: string) => {
    // solid/reactivity warns that a reactive closure is passed to a non-tracked scope.
    // The rule exists to prevent signal reads from being ignored outside reactive contexts.
    // Here it's a false positive: setSelectedTokensAndPersist wraps setSelectedTokens (a signal
    // setter), so the callback runs synchronously during a state update, not in a detached scope.
    // The only signal read inside (leverageLimitsMap()) is read-only contextual data, not the
    // state being updated.
    // eslint-disable-next-line solid/reactivity
    setSelectedTokensAndPersist(prev => {
      const existingToken = prev.find(token => token.symbol === symbol)

      if (existingToken) {
        if (existingToken.status !== "deleted") return prev

        const restoredNotional = roundNotional(
          existingToken.previousNotional ?? existingToken.notional ?? MIN_USD,
        )
        const restoredValue =
          existingToken.previousNotional ?? existingToken.notional
        const hasExchangeNotional =
          restoredValue !== undefined && restoredValue > 0

        const tokensWithRestored = prev.map(token =>
          token.symbol === symbol
            ? {
                ...token,
                status: hasExchangeNotional
                  ? ("untouched" as const)
                  : ("idle" as const),
                previousPercentage: undefined,
                notional: restoredNotional,
              }
            : token,
        )
        return updateByNotionalChange(tokensWithRestored)
      }

      const maxLeverageForSymbol = leverageLimitsMap()[symbol] || 1
      const initialNotional = MIN_USD
      const tokensWithNew: TokenAllocation[] = [
        ...prev,
        {
          symbol,
          percentage: 0, // Will be recalculated from notional
          side: "buy" as const,
          leverage: maxLeverageForSymbol,
          status: "idle" as const,
          message: null,
          notional: initialNotional,
          lockedUsd: initialNotional,
        },
      ]
      return updateByNotionalChange(tokensWithNew)
    })
  }

  const handleRemoveToken = (symbol: string) => {
    setTargetPortfolio(symbol, "status", "deleted")
  }

  const handleUndoRemoveToken = (symbol: string) => {
    //TODO: make it as function like `checkIsModified`
    //Now no logic to set `modified` status, let's check this working later
    let currentNotional = currentPortfolio[symbol].notional
    let currentSide = currentPortfolio[symbol].side
    let currentLeverage = currentPortfolio[symbol].leverage
    let targetNotional = targetPortfolio[symbol].notional
    let targetSide = targetPortfolio[symbol].side
    let targetLeverage = targetPortfolio[symbol].leverage

    if (
      currentNotional !== targetNotional ||
      currentSide !== targetSide ||
      currentLeverage !== targetLeverage
    ) {
      setTargetPortfolio(symbol, "status", "modified")
      return
    }

    setTargetPortfolio(symbol, "status", "untouched")
  }

  const handleSideChange = (symbol: string, side: OrderSide) => {
    setTargetPortfolio(symbol, "side", side)
  }

  const handleLeverageChange = (symbol: string, leverage: number) => {
    const maxLeverage = leverageLimitsMap()[symbol] || 1
    const newLeverage = Math.max(1, Math.min(leverage, maxLeverage))

    setTargetPortfolio(symbol, "leverage", newLeverage)
  }

  const handleNotionalChange = (symbol: string, newNotional: number) => {
    setTargetPortfolio(symbol, "notional", newNotional)
  }

  const handleWeightChange = (changedSymbol: string, newPercentage: number) => {
    if (isWeightRedistribution()) {
      redistributeWeights(changedSymbol, newPercentage, targetTotalNotional())
      return
    }

    // setSelectedTokensAndPersist(prev => {
    //   const clampedPercentage = Math.min(100, newPercentage)

    //   if (isWeightRedistribution()) {
    //     return redistributeWeights(
    //       prev,
    //       symbol,
    //       clampedPercentage,
    //       targetNotional(),
    //     )
    //   }

    //   // TODO: make this working
    //   // No redistribution: total notional is fixed (targetNotional = accountValue * leverage).
    //   // Update only the changed token's notional. Other tokens unchanged.
    //   return prev.map(t =>
    //     t.symbol === symbol
    //       ? {
    //           ...t,
    //           percentage: parseFloat(clampedPercentage.toFixed(2)),
    //           notional: calcNotional(clampedPercentage, targetNotional()),
    //         }
    //       : t,
    //   )
    // })
  }

  // When leverage changes: totalNotional = leverage * accountValue
  // Weights stay fixed, notionals are recalculated from weights and new total
  const handleCrossAccountLeverageChange = (value: number) => {
    const clampedLeverage = Math.min(MAX_CROSS_ACCOUNT_LEVERAGE, value)
    const newTotalNotional =
      accountValue() > 0 ? accountValue() * clampedLeverage : 0

    setCrossAccountLeverage(clampedLeverage)
    latestCrossAccountLeverage = clampedLeverage

    setSelectedTokensAndPersist(prev =>
      recalculateFromWeights(prev, newTotalNotional),
    )
  }

  const handleOpenPositions = () => {
    if (
      !tokensWithDeltaTracking().length ||
      accountValue() <= 0 ||
      hasBlockingNotionalIssue() ||
      (derivedTotalPercent() <= 0 && !hasPendingDeletions()) ||
      rebalancePositionsMutation.isPending
    ) {
      return
    }

    // Check for positions with changes less than $11 (only if precise is off)
    if (!isPrecise()) {
      const tokensWithSmallChangesOnSubmit =
        tokensWithDerivedPercentages().filter(token => {
          // Only check tokens that would be modified (not deleted, not untouched)
          if (token.status === "deleted" || token.status === "untouched") {
            return false
          }

          const targetValue = getTokenUsdAllocation(token, targetNotional())
          const initialToken = currentPortfolio[token.symbol]

          if (!initialToken) {
            // New position - check if target value is at least MIN_CHANGE_DELTA
            return targetValue > 0 && targetValue < MIN_CHANGE_DELTA
          }

          // Existing position - check if change delta is too small
          const currentValue = getTokenUsdAllocation(
            initialToken,
            targetNotional(),
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
        // eslint-disable-next-line solid/reactivity
        setSelectedTokensAndPersist(prev =>
          prev.map(token => {
            const hasSmallChange = tokensWithSmallChangesOnSubmit.some(
              t => t.symbol === token.symbol,
            )
            if (!hasSmallChange) return token

            const targetValue = getTokenUsdAllocation(token, targetNotional())
            const initialToken = currentPortfolio().find(
              it => it.symbol === token.symbol,
            )
            const currentValue = initialToken
              ? getTokenUsdAllocation(initialToken, targetNotional())
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
    const tokensForApi = tokensWithDerivedPercentages().filter(token => {
      const inInitial = currentPortfolio[token.symbol]
      return token.status !== "untouched" || !inInitial
    })

    // Nothing to do: no modifications, creations, or deletions
    if (!tokensForApi.length) {
      return
    }

    const payload = {
      accountValue: accountValue(),
      crossAccountLeverage: crossAccountLeverage(),
      precise: isPrecise(),
      positions: tokensWithDeltaTracking().map(token => {
        const exchangePosition = currentPortfolio[token.symbol]
        return {
          symbol: token.symbol,
          side: token.side,
          leverage: token.leverage,
          leverageChanged: exchangePosition
            ? token.leverage !== exchangePosition.leverage
            : true,
          currentNotional: exchangePosition?.notional,
          currentSide: exchangePosition?.side,
          percentage: new Decimal(token.percentage)
            .div(100)
            .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
            .toNumber(),
          status: mapStatusForApi(token.status),
        }
      }),
    }

    // Mark UI as rebalancing for the full lifecycle (including delayed refetch)
    setIsRebalancingUi(true)

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
      onSuccess: () => {
        // After we receive final order statuses, treat the exchange as source of truth:
        // 1. Allow positions effect to re-run by clearing the "loaded" flag
        // 2. Poll positions for a short window to observe the post-fill portfolio
        setPositionsLoadedFromExchange(false)

        // Kick off polling: short interval (1s) up to a max window (~7s).
        // UI "rebalancing" flag will be cleared by a separate effect once
        // stagedTrades have been reduced to an empty set.
        const pollStart = Date.now()
        const pollIntervalMs = 1_000
        const pollTimeoutMs = 7_000

        const pollPositions = () => {
          const elapsed = Date.now() - pollStart
          if (elapsed > pollTimeoutMs) {
            return
          }

          void positionsQuery.refetch().then(() => {
            setTimeout(pollPositions, pollIntervalMs)
          })
        }

        // Prime account summary once, then begin polling positions
        void accountSummaryQuery.refetch()
        setTimeout(pollPositions, pollIntervalMs)
      },
      onError: error => {
        console.error("[Rebalance] Mutation onError", {
          error: error.message,
        })

        const symbolMatch = error.message.match(/([A-Z0-9-]+\/[A-Z]+:[A-Z]+)/)
        const failedSymbol = symbolMatch ? symbolMatch[0] : null

        setSelectedTokensAndPersist(prev =>
          prev.map(token => {
            if (failedSymbol) {
              if (token.symbol === failedSymbol) {
                return {
                  ...token,
                  status: "failed",
                  message: error.message,
                }
              }
              return { ...token, status: "idle", message: null }
            }
            return {
              ...token,
              status: "failed",
              message: error.message,
            }
          }),
        )

        setIsRebalancingUi(false)
      },
    })
  }

  const netExposure = createMemo(() => {
    const target = targetNotional()
    return derivedActiveTokens().reduce((acc, token) => {
      const usdValue = getTokenUsdAllocation(token, target)
      return acc + (token.side === "buy" ? usdValue : -usdValue)
    }, 0)
  })

  const handleResetToInitial = () => {
    if (currentPortfolio().length === 0) {
      return
    }

    const baseLeverage =
      initialCrossAccountLeverage() ?? DEFAULT_CROSS_ACCOUNT_LEVERAGE

    setCrossAccountLeverage(baseLeverage)
    latestCrossAccountLeverage = baseLeverage
    // Compute the reset value eagerly so the setter callback has no reactive reads
    const resetTokens = updateByNotionalChange(currentPortfolio())
    setSelectedTokensAndPersist(resetTokens)
  }

  const disableSubmit = () =>
    !tokensWithDeltaTracking().length ||
    accountValue() <= 0 ||
    isRebalancingUi() ||
    (derivedTotalPercent() <= 0 && !hasPendingDeletions()) ||
    hasBlockingNotionalIssue()

  // createEffect: clear rebalancing UI state once staged trades are empty
  createEffect(() => {
    if (!isRebalancingUi() || !positionsLoadedFromExchange()) {
      return
    }

    if (stagedTrades().length === 0) {
      setIsRebalancingUi(false)
    }
  })

  return {
    // State (all getters for consistent consumer API -- access as properties, not function calls)
    get accountValue() {
      return accountValue()
    },
    get crossAccountLeverage() {
      return crossAccountLeverage()
    },
    get initialCrossAccountLeverage() {
      return initialCrossAccountLeverage()
    },
    get totalNotional() {
      return totalNotional()
    },
    get displayNotional() {
      return displayNotional()
    },
    get targetNotional() {
      return targetNotional()
    },
    get targetTotalNotional() {
      return targetTotalNotional()
    },
    get showTargetOfTotal() {
      return showTargetOfTotal()
    },
    get targetPortfolio() {
      return getTargetPortfolio()
    },
    get selectedTokens() {
      return tokensWithDeltaTracking()
    },
    get activeTokens() {
      return derivedActiveTokens()
    },
    get minPercentFloor() {
      return minPercentFloor()
    },
    get totalPercent() {
      return derivedTotalPercent()
    },
    get remainingPercent() {
      return derivedRemainingPercent()
    },
    get hasPendingDeletions() {
      return hasPendingDeletions()
    },
    get blockingReasons() {
      return blockingReasons()
    },
    get leverageLimitsMap() {
      return leverageLimitsMap()
    },
    get netExposure() {
      return netExposure()
    },
    //TODO: rename
    get initialTotalNotional() {
      return currentTotalNotional()
    },
    get stagedTrades() {
      return stagedTrades()
    },
    get disableSubmit() {
      return disableSubmit()
    },
    get isRebalancing() {
      return isRebalancingUi()
    },

    // Loading states
    get isBalanceLoading() {
      return accountSummaryQuery.isLoading
    },
    get isPositionsLoading() {
      return positionsQuery.isLoading
    },
    get isLeverageLimitsLoading() {
      return leverageLimitsQuery.isLoading
    },

    // Actions
    handleAddToken,
    handleRemoveToken,
    handleUndoRemoveToken,
    handleSideChange,
    handleLeverageChange,
    handleNotionalChange,
    handleWeightChange,
    handleCrossAccountLeverageChange,
    handleOpenPositions,
    handleResetToInitial,
  }
}
