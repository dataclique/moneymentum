import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  untrack,
} from "solid-js"
import Decimal from "decimal.js"
import {
  useHyperliquidAccountSummary,
  useHyperliquidPositions,
  useHyperliquidLeverageLimits,
  useRebalanceHyperliquidPositions,
  type OrderSide,
  type OrderResult,
} from "@/hooks/useTrading"
import {
  buildApiPayload,
  diffPortfolios,
  // type Portfolio as DiffPortfolio,
  // type PortfolioPosition as DiffPortfolioPosition,
} from "./portfolioRebalancer"
import { useWallet } from "@/hooks/useWallet"
import { createStore, produce, reconcile } from "solid-js/store"

// TODO: maybe move all constants in project to the separate file
export const MIN_USD = 11
const MAX_CROSS_ACCOUNT_LEVERAGE = 5
const DEFAULT_CROSS_ACCOUNT_LEVERAGE = 1

const roundNotional = (n: number): number =>
  new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()

export interface PortfolioInterface {
  symbol: string
  side: OrderSide
  leverage: number
  notional: number
}

export interface StagedTradeItem {
  underlying: string
  side: OrderSide
  notional: number
  previousWeight?: number
  newWeight?: number
}

// TODO: review this function
const calcLeverage = (totalNotional: number, accountValue: number): number => {
  if (accountValue <= 0) return 1
  const leverage = new Decimal(totalNotional)
    .div(accountValue)
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
    .toNumber()
  return Math.min(MAX_CROSS_ACCOUNT_LEVERAGE, leverage)
}

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

  ///////////////////////////
  ///////START HERE//////////
  ///////////////////////////

  const [currentPortfolio, setCurrentPortfolio] = createStore<
    Record<string, PortfolioInterface>
  >({})
  const [targetPortfolio, setTargetPortfolio] = createStore<
    Record<string, PortfolioInterface>
  >({})

  const [deletedArchive, setDeletedArchive] = createStore<
    Record<string, PortfolioInterface>
  >({})

  const [currentCrossAccountLeverage, setCurrentCrossAccountLeverage] =
    createSignal(DEFAULT_CROSS_ACCOUNT_LEVERAGE)
  const [targetCrossAccountLeverage, setTargetCrossAccountLeverage] =
    createSignal(DEFAULT_CROSS_ACCOUNT_LEVERAGE)

  const [currentTotalNotional, setCurrentTotalNotional] = createSignal(0)
  const [targetTotalNotional, setTargetTotalNotional] = createSignal(0)

  ///////////////////////////
  ///////END HERE//////////
  ///////////////////////////

  const [isRebalancingUi, setIsRebalancingUi] = createSignal(false)

  const [positionsLoadedFromExchange, setPositionsLoadedFromExchange] =
    createSignal(false)

  // Track previous connection state for disconnect cleanup
  let wasConnected = isConnected()

  const redistributeWeights = (
    changedSymbol: string,
    newPercentage: number,
    totalNotional: number,
  ) => {
    const symbols = Object.keys(targetPortfolio)

    if (totalNotional <= 0 || !symbols.includes(changedSymbol)) return

    const clampedNew = Math.max(0, Math.min(100, newPercentage))
    const otherSymbols = symbols.filter(s => s !== changedSymbol)

    // 1. Считаем текущий суммарный процент остальных весов
    const otherTotalPercent = otherSymbols.reduce((sum, s) => {
      const currentNotional = targetPortfolio[s]?.notional || 0
      return sum + (currentNotional / totalNotional) * 100
    }, 0)

    batch(() => {
      // 2. Обновляем целевой символ
      const newTargetNotional = (clampedNew / 100) * totalNotional
      setTargetPortfolio(changedSymbol, "notional", newTargetNotional)

      // 3. Распределяем оставшийся процент
      const remainingPercentForOthers = 100 - clampedNew

      otherSymbols.forEach(symbol => {
        let nextPercent: number

        if (otherTotalPercent <= 0) {
          // Если у остальных был 0%, делим остаток поровну
          nextPercent = remainingPercentForOthers / otherSymbols.length
        } else {
          // Пропорциональное изменение:
          // (текущий_вес / сумма_остальных_весов) * доступный_остаток
          const currentPercent =
            (targetPortfolio[symbol].notional / totalNotional) * 100
          nextPercent =
            (currentPercent / otherTotalPercent) * remainingPercentForOthers
        }

        setTargetPortfolio(
          symbol,
          "notional",
          (nextPercent / 100) * totalNotional,
        )
      })
    })
  }

  const symbolsBelowMinimum = createMemo(() =>
    Object.keys(targetPortfolio).filter(symbol => {
      if (targetPortfolio[symbol].notional >= MIN_USD) return false

      const currentNotional = currentPortfolio[symbol]?.notional ?? 0
      const unchanged =
        currentNotional < MIN_USD &&
        Math.abs(targetPortfolio[symbol].notional - currentNotional) < 0.01

      return !unchanged
    }),
  )

  const symbolsDeltaBelowMinimum = createMemo(() =>
    Object.keys(targetPortfolio).filter(symbol => {
      const delta = Math.abs(
        targetPortfolio[symbol].notional - currentPortfolio[symbol]?.notional,
      )
      return delta < MIN_USD && delta !== 0
    }),
  )

  // Keep displayed target leverage in sync with planned target notional.
  createEffect(() => {
    setTargetCrossAccountLeverage(
      calcLeverage(targetTotalNotional(), accountValue()),
    )
  })

  // Keep displayed current leverage in sync with current notional on the exchange.
  createEffect(() => {
    setCurrentCrossAccountLeverage(
      calcLeverage(currentTotalNotional(), accountValue()),
    )
  })

  // createEffect: disconnect cleanup - detect falling edge from connected to disconnected
  createEffect(() => {
    const currentlyConnected = isConnected()
    const previouslyConnected = wasConnected
    wasConnected = currentlyConnected

    if (!previouslyConnected || currentlyConnected) {
      return
    }

    setCurrentPortfolio({})
    setTargetCrossAccountLeverage(DEFAULT_CROSS_ACCOUNT_LEVERAGE)
    setCurrentCrossAccountLeverage(DEFAULT_CROSS_ACCOUNT_LEVERAGE)
    setPositionsLoadedFromExchange(false)
  })

  // Derive accountValue from account summary
  const accountValue = createMemo(
    () => accountSummaryQuery.data?.accountValue ?? 0,
  )

  // Compute targetNotional = accountValue * targetCrossAccountLeverage (used for percentage calculations)
  const targetNotional = createMemo(() =>
    new Decimal(accountValue())
      .mul(targetCrossAccountLeverage())
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toNumber(),
  )

  // Mutable ref kept in sync with targetCrossAccountLeverage signal via createEffect.
  // Avoids stale closures in callbacks that read leverage without re-subscribing.
  let latestCrossAccountLeverage = untrack(targetCrossAccountLeverage)

  // createEffect: sync mutable ref with signal so downstream functions read current value
  createEffect(() => {
    latestCrossAccountLeverage = targetCrossAccountLeverage()
  })

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

    const exchangeTokens: PortfolioInterface[] = positionsData.positions.map(
      pos => ({
        symbol: pos.symbol,
        side: pos.side,
        leverage: pos.leverage || 1,
        notional: pos.notional,
      }),
    )

    const portfolioMap = Object.fromEntries(
      exchangeTokens.map(token => [token.symbol, token]),
    ) as Record<string, PortfolioInterface>

    setCurrentPortfolio(portfolioMap)

    // Create a FULLY independent copy for the target
    setTargetPortfolio(structuredClone(portfolioMap))

    // Calculate leverage from the formula: leverage = totalNotional / accountValue
    const initialLeverage = calcLeverage(totalExchangeNotional, accountValue())
    console.log("initialLeverage", initialLeverage)
    setTargetTotalNotional(totalExchangeNotional)
    setCurrentTotalNotional(totalExchangeNotional)
    setTargetCrossAccountLeverage(initialLeverage)
    setCurrentCrossAccountLeverage(initialLeverage)

    setPositionsLoadedFromExchange(true)
  })

  const actions = createMemo(() =>
    diffPortfolios(currentPortfolio, targetPortfolio),
  )

  //TODO: move this to the utils
  const getSignedNotional = (side: OrderSide, notional: number): number => {
    return side === "buy" ? notional : -notional
  }

  //Get staged trades directly for actions we will perform
  const stagedTrades = createMemo<StagedTradeItem[]>(() => {
    return actions().map(action => {
      const symbol = action.symbol
      const c = currentPortfolio[symbol]
      const t = targetPortfolio[symbol]

      const delta =
        action.kind === "close"
          ? -getSignedNotional(c.side, c.notional)
          : action.notional

      return {
        underlying: symbol,
        side: delta > 0 ? "buy" : "sell",
        notional: Math.abs(delta),
        previousWeight: (c?.notional || 0) / (currentTotalNotional() || 1),
        newWeight: (t?.notional || 0) / (targetTotalNotional() || 1),
      }
    })
  })

  const leverageLimitsMap = createMemo(() => {
    const map: Record<string, number> = {}
    const limitsData = leverageLimitsQuery.data
    if (!limitsData) return map
    for (const item of limitsData) {
      map[item.symbol] = item.maxLeverage
    }
    return map
  })

  const hasPositionsBelowMinimum = () => symbolsBelowMinimum().length > 0
  const hasSymbolsDeltaBelowMinimum = () =>
    symbolsDeltaBelowMinimum().length > 0

  //TODO: add this ater, when non precise mode is implemented
  // const hasTotalPercentExceeded = () =>
  //   totalTargetPortfolioPercent() > 100 + MAX_TOTAL_PERCENT_TOLERANCE
  // const hasTotalPercentBelow = () =>
  //   derivedTotalPercent() < 100 - MAX_TOTAL_PERCENT_TOLERANCE
  // const showTargetOfTotal = () =>
  //   Math.abs(derivedTotalPercent() - 100) > MAX_TOTAL_PERCENT_TOLERANCE

  const blockingReasons = createMemo(() => {
    const reasons: string[] = []
    if (hasPositionsBelowMinimum()) {
      const symbolsList = symbolsBelowMinimum()
        .map(s => `${s} ($${targetPortfolio[s].notional.toFixed(2)})`)
        .join(", ")
      return `Each position must be at least $${String(MIN_USD)}. Positions below minimum: ${symbolsList}`
    }
    if (hasSymbolsDeltaBelowMinimum() && !isPrecise()) {
      const symbolsList = symbolsDeltaBelowMinimum()
        .map(s => `${s} ($${targetPortfolio[s].notional.toFixed(2)})`)
        .join(", ")
      return `Each position delta must be at least $${String(MIN_USD)}. Positions below minimum: ${symbolsList}`
    }
    //   if (hasTotalPercentExceeded()) {
    //     const excessPercent = (derivedTotalPercent() - 100).toFixed(1)
    //     reasons.push(
    //       `Sum of weights exceeds 100% by ${excessPercent}%. Reduce allocations.`,
    //     )
    //   }
    //   if (hasTotalPercentBelow()) {
    //     const deficitPercent = (100 - derivedTotalPercent()).toFixed(1)
    //     reasons.push(
    //       `Sum of weights is below 100% by ${deficitPercent}%. Add allocations.`,
    //     )
    //   }
    return reasons
  })

  const handleAddToken = (symbol: string) => {
    if (symbol in targetPortfolio) return

    batch(() => {
      setTargetPortfolio(symbol, {
        symbol,
        side: "buy",
        leverage: leverageLimitsMap()[symbol] || 1,
        notional: MIN_USD,
      })

      setTargetTotalNotional(prev => prev + MIN_USD)
    })
  }

  const handleRemoveToken = (symbol: string) => {
    const targetPosition = targetPortfolio[symbol]
    if (!targetPosition) return

    const isPresentInCurrentPortfolio = !!currentPortfolio[symbol]

    batch(() => {
      if (isPresentInCurrentPortfolio) {
        setDeletedArchive(symbol, { ...targetPosition })
      }

      setTargetPortfolio(
        produce(state => {
          delete state[symbol]
        }),
      )
      setTargetTotalNotional(prev =>
        Math.max(0, prev - targetPosition.notional),
      )
    })
  }

  const handleUndoRemoveToken = (symbol: string) => {
    const archivedPosition = deletedArchive[symbol]
    const currentPosition = currentPortfolio[symbol]

    const positionToRestore = archivedPosition || currentPosition

    if (!positionToRestore) return

    batch(() => {
      setTargetPortfolio(symbol, { ...positionToRestore })
      setTargetTotalNotional(prev => prev + positionToRestore.notional)

      setDeletedArchive(
        produce(state => {
          delete state[symbol]
        }),
      )
    })
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

    const nextTotal = Object.values(targetPortfolio).reduce((sum, pos) => {
      if (deletedArchive[symbol]) return sum
      return sum + (pos.notional || 0)
    }, 0)

    setTargetTotalNotional(nextTotal)
  }

  const handleWeightChange = (changedSymbol: string, newPercentage: number) => {
    if (isWeightRedistribution()) {
      redistributeWeights(changedSymbol, newPercentage, targetTotalNotional())

      return
    }

    // TODO: make this working
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
  const handleCrossAccountLeverageChange = (newLeverage: number) => {
    const newTotal = accountValue() * newLeverage
    const oldTotal = targetTotalNotional()

    if (oldTotal === 0) {
      setTargetTotalNotional(newTotal)
      return
    }

    const multiplier = newTotal / oldTotal

    setTargetPortfolio(
      produce(state => {
        for (const symbol in state) {
          if (!deletedArchive[symbol]) {
            state[symbol].notional *= multiplier
          }
        }
      }),
    )

    setTargetTotalNotional(newTotal)
  }

  const handleResetToCurrent = () => {
    const currentTokens = Object.values(currentPortfolio)
    const nextTarget = Object.fromEntries(
      currentTokens.map(token => [
        token.symbol,
        { ...token, status: "synced" as const },
      ]),
    )

    batch(() => {
      setTargetPortfolio(reconcile(nextTarget))

      setTargetTotalNotional(currentTotalNotional())
    })
  }

  const handleRebalancePositions = () => {
    const apiPayload = buildApiPayload(
      currentPortfolio,
      targetPortfolio,
      isPrecise(),
    )

    console.log(apiPayload)

    rebalancePositionsMutation.mutate(apiPayload)

    setIsRebalancingUi(true)
  }

  const handleDisconnect = () => {
    setCurrentPortfolio({})
    setTargetPortfolio({})
    setDeletedArchive({})
    // setFundingRatesByBaseSymbol({}) //TODO: also reset this
    setCurrentCrossAccountLeverage(DEFAULT_CROSS_ACCOUNT_LEVERAGE)
    setTargetCrossAccountLeverage(DEFAULT_CROSS_ACCOUNT_LEVERAGE)
    setCurrentTotalNotional(0)
    setTargetTotalNotional(0)
  }

  const hasBlockingNotionalIssue = () => hasPositionsBelowMinimum()
  // ||
  // hasTotalPercentExceeded() ||
  // hasTotalPercentBelow()

  const canSubmit = () => {
    const isPortfolioValid =
      Object.keys(targetPortfolio).length + Object.keys(deletedArchive).length >
      0
    // const isWeightsOk = totalWeight() === 1.0;
    // const allOrdersValid = stagedTrades().every(t => t.notional >= 11);

    return (
      isPortfolioValid &&
      !hasPositionsBelowMinimum() &&
      (isPrecise() || !hasSymbolsDeltaBelowMinimum())
    )
  }

  // // createEffect: clear rebalancing UI state once staged trades are empty
  // createEffect(() => {
  //   if (!isRebalancingUi() || !positionsLoadedFromExchange()) {
  //     return
  //   }
  // })

  return {
    get accountValue() {
      return accountValue()
    },
    get targetCrossAccountLeverage() {
      return targetCrossAccountLeverage()
    },
    get currentCrossAccountLeverage() {
      return currentCrossAccountLeverage()
    },
    get targetNotional() {
      return targetNotional()
    },
    get currentTotalNotional() {
      return currentTotalNotional()
    },
    get targetTotalNotional() {
      return targetTotalNotional()
    },
    get currentPortfolio() {
      return currentPortfolio
    },
    get targetPortfolio() {
      return targetPortfolio
    },
    get deletedArchive() {
      return deletedArchive
    },
    get leverageLimitsMap() {
      return leverageLimitsMap()
    },
    get stagedTrades() {
      return stagedTrades()
    },
    get isRebalancing() {
      return isRebalancingUi()
    },

    get canSubmit() {
      return canSubmit()
    },

    get symbolsBelowMinimum() {
      return symbolsBelowMinimum()
    },

    get symbolsDeltaBelowMinimum() {
      return symbolsDeltaBelowMinimum()
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
    handleRebalancePositions,
    handleResetToCurrent,
    handleDisconnect,
  }
}
