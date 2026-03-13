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
import { useWallet } from "@/hooks/useWallet"
import { createStore, produce, reconcile } from "solid-js/store"

export const MIN_USD = 11
export const MIN_CHANGE_DELTA = 11.0 // Minimum change in USD to trigger a rebalance
// Allow sum of weights slightly above 100% due to rounding (e.g. 33.33 + 33.33 + 33.34 = 100.00)
const MAX_TOTAL_PERCENT_TOLERANCE = 0.1

const roundNotional = (n: number): number =>
  new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()

export type AllocationStatus =
  | OrderResult["status"]
  | "new"
  | "idle" //TODO: what is this status?
  | "untouched"
  | "deleted"
  | "modified"

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

  const [targetCrossAccountLeverage, setTargetCrossAccountLeverage] =
    createSignal(DEFAULT_CROSS_ACCOUNT_LEVERAGE)
  const [currentCrossAccountLeverage, setCurrentCrossAccountLeverage] =
    createSignal(DEFAULT_CROSS_ACCOUNT_LEVERAGE)

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
    const active = activeSymbols() // Предполагаем, это список ключей без "deleted"
    if (totalNotional <= 0 || !active.includes(changedSymbol)) return

    const clampedNew = Math.max(0, Math.min(100, newPercentage))
    const otherSymbols = active.filter(s => s !== changedSymbol)

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

  const [targetTotalNotional, setTargetTotalNotional] = createSignal(0)
  const [currentTotalNotional, setCurrentTotalNotional] = createSignal(0)

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

  // const currentLeverage = createMemo(() => {
  //   if (accountValue() === 0) return 0;
  //   return targetTotalNotional() / accountValue();
  // });

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

  const setSelectedTokensAndPersist = (
    updater:
      | TokenAllocation[]
      | ((prev: TokenAllocation[]) => TokenAllocation[]),
  ) => {
    setSelectedTokens(prev =>
      typeof updater === "function" ? updater(prev) : updater,
    )
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

    const exchangeTokens: CurrentPortfolioInterface[] =
      positionsData.positions.map(pos => ({
        symbol: pos.symbol,
        side: pos.side,
        leverage: pos.leverage || 1,
        notional: pos.notional,
      }))

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

    // Calculate leverage from the formula: leverage = totalNotional / accountValue
    const initialLeverage = calcLeverage(totalExchangeNotional, accountValue())
    console.log("initialLeverage", initialLeverage)
    setTargetTotalNotional(totalExchangeNotional)
    setCurrentTotalNotional(totalExchangeNotional)
    setTargetCrossAccountLeverage(initialLeverage)
    setCurrentCrossAccountLeverage(initialLeverage)

    setPositionsLoadedFromExchange(true)
  })

  //TODO: review this type
  type StagedTradeItem = {
    underlying: string
    side: OrderSide
    notional: number
    previousWeight?: number
    newWeight?: number
    status: AllocationStatus
  }

  const stagedTrades = createMemo(() => {
    const trades: StagedTradeItem[] = []
    const allSymbols = new Set([
      ...Object.keys(currentPortfolio),
      ...Object.keys(targetPortfolio),
    ])

    for (const symbol of allSymbols) {
      const current = currentPortfolio[symbol]
      const target = targetPortfolio[symbol]

      const curNotional = current?.notional || 0
      const curSide = current?.side || "buy"

      const isDeleted = target?.status === "deleted"
      const tarNotional = isDeleted ? 0 : target?.notional || 0
      const tarSide = target?.side || curSide

      const currentSigned = curSide === "buy" ? curNotional : -curNotional
      const targetSigned = tarSide === "buy" ? tarNotional : -tarNotional

      const diff = targetSigned - currentSigned

      if (Math.abs(diff) > 0.01) {
        trades.push({
          underlying: symbol,
          side: diff > 0 ? "buy" : "sell",
          notional: Math.abs(diff),
          previousWeight: curNotional / (currentTotalNotional() || 1),
          newWeight: tarNotional / (targetTotalNotional() || 1),
          status: target?.status || "modified",
        })
      }
    }
    return trades
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

  //TODO: move back validation logic to the component
  // const hasPositionsBelowMinimum = () => tokensBelowMinimum().length > 0
  // const hasTotalPercentExceeded = () =>
  //   derivedTotalPercent() > 100 + MAX_TOTAL_PERCENT_TOLERANCE
  // const hasTotalPercentBelow = () =>
  //   derivedTotalPercent() < 100 - MAX_TOTAL_PERCENT_TOLERANCE
  // const showTargetOfTotal = () =>
  //   Math.abs(derivedTotalPercent() - 100) > MAX_TOTAL_PERCENT_TOLERANCE
  // const hasBlockingNotionalIssue = () =>
  //   notionalBelowMinimum() ||
  //   insufficientNotionalForTokens() ||
  //   hasPositionsBelowMinimum() ||
  //   hasTotalPercentExceeded() ||
  //   hasTotalPercentBelow()

  // const blockingReasons = createMemo(() => {
  //   const reasons: string[] = []
  //   if (notionalBelowMinimum()) {
  //     reasons.push(
  //       "Minimum total notional is $11. Increase leverage or add funds.",
  //     )
  //   }
  //   if (insufficientNotionalForTokens()) {
  //     reasons.push(
  //       `Not enough notional for all positions. Need at least $${String(requiredNotionalForTokens())}.`,
  //     )
  //   }
  //   if (hasPositionsBelowMinimum()) {
  //     const tokensList = tokensBelowMinimum()
  //       .map(t => `${t.symbol} ($${t.usdValue.toFixed(2)})`)
  //       .join(", ")
  //     reasons.push(
  //       `Each position must be at least $${String(MIN_USD)}. Positions below minimum: ${tokensList}`,
  //     )
  //   }
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
  //   return reasons
  // })

  const handleAddToken = (symbol: string) => {
    if (symbol in targetPortfolio) return

    batch(() => {
      setTargetPortfolio(symbol, {
        symbol,
        side: "buy",
        leverage: leverageLimitsMap()[symbol] || 1,
        notional: MIN_USD,
        status: "new",
      })

      setTargetTotalNotional(prev => prev + MIN_USD)
    })
  }

  const handleRemoveToken = (symbol: string) => {
    const position = targetPortfolio[symbol]
    if (!position) return

    batch(() => {
      if (position.status === "new") {
        const removedNotional = position.notional
        setTargetPortfolio(
          produce(state => {
            delete state[symbol]
          }),
        )
        setTargetTotalNotional(prev => Math.max(0, prev - removedNotional))
      } else {
        setTargetPortfolio(symbol, "status", "deleted")
        setTargetTotalNotional(prev => Math.max(0, prev - position.notional))
      }
    })
  }

  const handleUndoRemoveToken = (symbol: string) => {
    const position = targetPortfolio[symbol]
    if (!position) return

    batch(() => {
      setTargetTotalNotional(prev => prev + position.notional)

      //TODO: make it as function like `checkIsModified`
      //Now no logic to set `modified` status, let's check this working later
      const current = currentPortfolio[symbol]

      const isModified =
        current.notional !== position.notional ||
        current.side !== position.side ||
        current.leverage !== position.leverage

      setTargetPortfolio(
        symbol,
        "status",
        isModified ? "modified" : "untouched",
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
      if (pos.status === "deleted") return sum
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
          if (state[symbol].status !== "deleted") {
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
        { ...token, status: "untouched" as const },
      ]),
    )

    batch(() => {
      setTargetPortfolio(reconcile(nextTarget))

      setTargetTotalNotional(currentTotalNotional())
    })
  }

  // const handleOpenPositions = () => {
  //   if (
  //     !tokensWithDeltaTracking().length ||
  //     accountValue() <= 0 ||
  //     hasBlockingNotionalIssue() ||
  //     (derivedTotalPercent() <= 0 && !hasPendingDeletions()) ||
  //     rebalancePositionsMutation.isPending
  //   ) {
  //     return
  //   }

  //   // Check for positions with changes less than $11 (only if precise is off)
  //   if (!isPrecise()) {
  //     const tokensWithSmallChangesOnSubmit =
  //       tokensWithDerivedPercentages().filter(token => {
  //         // Only check tokens that would be modified (not deleted, not untouched)
  //         if (token.status === "deleted" || token.status === "untouched") {
  //           return false
  //         }

  //         const targetValue = getTokenUsdAllocation(token, targetNotional())
  //         const initialToken = currentPortfolio[token.symbol]

  //         if (!initialToken) {
  //           // New position - check if target value is at least MIN_CHANGE_DELTA
  //           return targetValue > 0 && targetValue < MIN_CHANGE_DELTA
  //         }

  //         // Existing position - check if change delta is too small
  //         const currentValue = getTokenUsdAllocation(
  //           initialToken,
  //           targetNotional(),
  //         )
  //         const delta = Math.abs(targetValue - currentValue)

  //         // Also check if side or leverage changed (those would require action)
  //         const sideChanged = token.side !== initialToken.side
  //         const leverageChanged = token.leverage !== initialToken.leverage

  //         // If side or leverage changed, we need to act regardless of delta
  //         if (sideChanged || leverageChanged) {
  //           return false
  //         }

  //         // If delta is too small, mark as error
  //         return delta > 0 && delta < MIN_CHANGE_DELTA
  //       })

  //     // If there are positions with small changes, set error messages and return
  //     if (tokensWithSmallChangesOnSubmit.length > 0) {
  //       // eslint-disable-next-line solid/reactivity
  //       setSelectedTokensAndPersist(prev =>
  //         prev.map(token => {
  //           const hasSmallChange = tokensWithSmallChangesOnSubmit.some(
  //             t => t.symbol === token.symbol,
  //           )
  //           if (!hasSmallChange) return token

  //           const targetValue = getTokenUsdAllocation(token, targetNotional())
  //           const initialToken = currentPortfolio().find(
  //             it => it.symbol === token.symbol,
  //           )
  //           const currentValue = initialToken
  //             ? getTokenUsdAllocation(initialToken, targetNotional())
  //             : 0
  //           const delta = Math.abs(targetValue - currentValue)

  //           if (currentValue === 0) {
  //             return {
  //               ...token,
  //               message: `New position value ($${targetValue.toFixed(2)}) is below minimum change of $${MIN_CHANGE_DELTA.toFixed(2)}`,
  //             }
  //           }
  //           return {
  //             ...token,
  //             message: `Change ($${delta.toFixed(2)}) is below minimum of $${MIN_CHANGE_DELTA.toFixed(2)}. Use precise mode to open this position.`,
  //           }
  //         }),
  //       )
  //       return
  //     }
  //   }

  //   const mapStatusForApi = (
  //     status: AllocationStatus,
  //   ): "untouched" | "modified" | "idle" | "deleted" | "working" => {
  //     if (status === "filled" || status === "failed") return "idle"
  //     return status
  //   }

  //   // Only send tokens that actually changed compared to the initial portfolio state
  //   const tokensForApi = tokensWithDerivedPercentages().filter(token => {
  //     const inInitial = currentPortfolio[token.symbol]
  //     return token.status !== "untouched" || !inInitial
  //   })

  //   // Nothing to do: no modifications, creations, or deletions
  //   if (!tokensForApi.length) {
  //     return
  //   }

  //   const payload = {
  //     accountValue: accountValue(),
  //     targetCrossAccountLeverage: targetCrossAccountLeverage(),
  //     precise: isPrecise(),
  //     positions: tokensWithDeltaTracking().map(token => {
  //       const exchangePosition = currentPortfolio[token.symbol]
  //       return {
  //         symbol: token.symbol,
  //         side: token.side,
  //         leverage: token.leverage,
  //         leverageChanged: exchangePosition
  //           ? token.leverage !== exchangePosition.leverage
  //           : true,
  //         currentNotional: exchangePosition?.notional,
  //         currentSide: exchangePosition?.side,
  //         percentage: new Decimal(token.percentage)
  //           .div(100)
  //           .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
  //           .toNumber(),
  //         status: mapStatusForApi(token.status),
  //       }
  //     }),
  //   }

  //   // Mark UI as rebalancing for the full lifecycle (including delayed refetch)
  //   setIsRebalancingUi(true)

  //   setSelectedTokensAndPersist(prev =>
  //     prev.map(token => {
  //       const isInPayload = tokensForApi.some(t => t.symbol === token.symbol)
  //       if (!isInPayload) {
  //         return token
  //       }

  //       return {
  //         ...token,
  //         status: token.status === "deleted" ? "deleted" : "working",
  //         message: null,
  //       }
  //     }),
  //   )

  //   rebalancePositionsMutation.mutate(payload, {
  //     onSuccess: () => {
  //       // After we receive final order statuses, treat the exchange as source of truth:
  //       // 1. Allow positions effect to re-run by clearing the "loaded" flag
  //       // 2. Poll positions for a short window to observe the post-fill portfolio
  //       setPositionsLoadedFromExchange(false)

  //       // Kick off polling: short interval (1s) up to a max window (~7s).
  //       // UI "rebalancing" flag will be cleared by a separate effect once
  //       // stagedTrades have been reduced to an empty set.
  //       const pollStart = Date.now()
  //       const pollIntervalMs = 1_000
  //       const pollTimeoutMs = 7_000

  //       const pollPositions = () => {
  //         const elapsed = Date.now() - pollStart
  //         if (elapsed > pollTimeoutMs) {
  //           return
  //         }

  //         void positionsQuery.refetch().then(() => {
  //           setTimeout(pollPositions, pollIntervalMs)
  //         })
  //       }

  //       // Prime account summary once, then begin polling positions
  //       void accountSummaryQuery.refetch()
  //       setTimeout(pollPositions, pollIntervalMs)
  //     },
  //     onError: error => {
  //       console.error("[Rebalance] Mutation onError", {
  //         error: error.message,
  //       })

  //       const symbolMatch = error.message.match(/([A-Z0-9-]+\/[A-Z]+:[A-Z]+)/)
  //       const failedSymbol = symbolMatch ? symbolMatch[0] : null

  //       setSelectedTokensAndPersist(prev =>
  //         prev.map(token => {
  //           if (failedSymbol) {
  //             if (token.symbol === failedSymbol) {
  //               return {
  //                 ...token,
  //                 status: "failed",
  //                 message: error.message,
  //               }
  //             }
  //             return { ...token, status: "idle", message: null }
  //           }
  //           return {
  //             ...token,
  //             status: "failed",
  //             message: error.message,
  //           }
  //         }),
  //       )

  //       setIsRebalancingUi(false)
  //     },
  //   })
  // }

  // const netExposure = createMemo(() => {
  //   const target = targetNotional()
  //   return derivedActiveTokens().reduce((acc, token) => {
  //     const usdValue = getTokenUsdAllocation(token, target)
  //     return acc + (token.side === "buy" ? usdValue : -usdValue)
  //   }, 0)
  // })

  // const disableSubmit = () =>
  //   !tokensWithDeltaTracking().length ||
  //   accountValue() <= 0 ||
  //   isRebalancingUi() ||
  //   (derivedTotalPercent() <= 0 && !hasPendingDeletions()) ||
  //   hasBlockingNotionalIssue()

  // // createEffect: clear rebalancing UI state once staged trades are empty
  // createEffect(() => {
  //   if (!isRebalancingUi() || !positionsLoadedFromExchange()) {
  //     return
  //   }
  // })

  return {
    // State (all getters for consistent consumer API -- access as properties, not function calls)
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
    get targetPortfolio() {
      return getTargetPortfolio()
    },
    get getActiveSymbols() {
      return activeSymbols()
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
    // handleOpenPositions,
    handleResetToCurrent,
  }
}
