import { useMemo, useState, useCallback } from "react"
import {
  MOCK_GREEKS,
  MOCK_FACTOR_EXPOSURES,
  MOCK_CORRELATION_MATRIX,
  CORRELATION_ASSETS_LIST,
  MOCK_FACTOR_DECOMPOSITION,
  MOCK_FACTOR_TARGETS,
  MOCK_RISK_METRICS,
  MOCK_STRESS_TESTS,
  MOCK_BACKTEST_DATA,
  MOCK_MONTE_CARLO,
  MOCK_PERFORMANCE_STATS,
  MOCK_ASSET_ANALYSIS,
  MOCK_POSITIONS,
  MOCK_INSTRUMENT_COSTS,
  MOCK_FACTOR_HISTORICAL_RETURNS,
  MOCK_FACTOR_ATTRIBUTION,
  MOCK_CONCENTRATION_METRICS,
  MOCK_DRAWDOWN_DATA,
  MOCK_RETURN_DISTRIBUTION,
  type MockPosition,
  type ComputedTrade,
} from "../mockData"
import {
  rebalanceWeights,
  computeStagedTradesFromDiff,
} from "../utils/portfolio"

export interface PositionsByUnderlying {
  underlying: string
  positions: Array<{
    symbol: string
    side: "long" | "short"
    weight: number
    notional: number
    percentage: number
    fundingRate?: number
    carryRate?: number
    theta?: number
  }>
}

const buildWeightsMap = (positions: MockPosition[]): Map<string, number> =>
  new Map(positions.map(p => [p.symbol, p.weight]))

const mergeWeights = (
  positions: MockPosition[],
  overrides: Map<string, number>,
): Map<string, number> => {
  const base = buildWeightsMap(positions)
  for (const [symbol, weight] of overrides) {
    base.set(symbol, weight)
  }
  return base
}

export const usePrototypeData = () => {
  // Committed state: what's currently "in the market"
  const [committedPositions, setCommittedPositions] =
    useState<MockPosition[]>(MOCK_POSITIONS)
  const [committedLeverage, setCommittedLeverage] = useState(1.0)

  // Target state: user's pending changes
  const [targetWeightOverrides, setTargetWeightOverrides] = useState<
    Map<string, number>
  >(new Map())
  const [targetLeverage, setTargetLeverage] = useState(1.0)

  const nav = 250000

  // Compute current weights from committed positions + overrides
  const currentWeights = useMemo(
    () => mergeWeights(committedPositions, targetWeightOverrides),
    [committedPositions, targetWeightOverrides],
  )

  // Computed staged trades from diff between committed and target
  const stagedTrades = useMemo(
    (): ComputedTrade[] =>
      computeStagedTradesFromDiff({
        committedPositions,
        targetWeights: currentWeights,
        committedLeverage,
        targetLeverage,
        nav,
      }),
    [
      committedPositions,
      currentWeights,
      committedLeverage,
      targetLeverage,
      nav,
    ],
  )

  // Weight adjustment (delta-based, for keyboard shortcuts)
  const adjustPositionWeight = useCallback(
    (symbol: string, delta: number) => {
      const current = currentWeights.get(symbol) ?? 0
      const newWeight = Math.max(0, Math.min(1, current + delta))
      const rebalanced = rebalanceWeights(currentWeights, symbol, newWeight)
      setTargetWeightOverrides(rebalanced)
    },
    [currentWeights],
  )

  // Direct weight update (for editable cells)
  const updateInstrumentWeight = useCallback(
    (symbol: string, newWeight: number) => {
      const clampedWeight = Math.max(0, Math.min(1, newWeight))
      const rebalanced = rebalanceWeights(currentWeights, symbol, clampedWeight)
      setTargetWeightOverrides(rebalanced)
    },
    [currentWeights],
  )

  // Update notional by converting to weight
  const updateInstrumentNotional = useCallback(
    (symbol: string, newNotional: number) => {
      // Convert notional back to weight: weight = notional / (nav × leverage)
      const effectiveLeverage = targetLeverage || 1
      const newWeight = newNotional / (nav * effectiveLeverage)
      const clampedWeight = Math.max(0, Math.min(1, newWeight))
      const rebalanced = rebalanceWeights(currentWeights, symbol, clampedWeight)
      setTargetWeightOverrides(rebalanced)
    },
    [nav, targetLeverage, currentWeights],
  )

  // Leverage setter that updates target leverage (supports both value and callback)
  const setLeverage = useCallback(
    (newLeverageOrCallback: number | ((prev: number) => number)) => {
      setTargetLeverage(newLeverageOrCallback)
    },
    [],
  )

  const instrumentCostsMap = useMemo(() => {
    const map = new Map<
      string,
      { fundingRate?: number; carryRate?: number; theta?: number }
    >()
    for (const cost of MOCK_INSTRUMENT_COSTS) {
      map.set(cost.symbol, {
        fundingRate: cost.fundingRate,
        carryRate: cost.carryRate,
        theta: cost.theta,
      })
    }
    return map
  }, [])

  // Derive positions with target weights applied
  const positionsByUnderlying = useMemo((): PositionsByUnderlying[] => {
    const grouped = new Map<string, PositionsByUnderlying["positions"]>()

    // Calculate total weight for percentage calculation
    const totalWeight = committedPositions.reduce((sum, p) => {
      const weight = currentWeights.get(p.symbol) ?? p.weight
      return sum + weight
    }, 0)

    for (const position of committedPositions) {
      if (!grouped.has(position.underlying)) {
        grouped.set(position.underlying, [])
      }

      const weight = currentWeights.get(position.symbol) ?? position.weight
      const notional = nav * weight * targetLeverage
      const percentage = totalWeight > 0 ? (weight / totalWeight) * 100 : 0
      const costs = instrumentCostsMap.get(position.symbol)

      grouped.get(position.underlying)?.push({
        symbol: position.symbol,
        side: position.side,
        weight,
        notional,
        percentage,
        fundingRate: costs?.fundingRate,
        carryRate: costs?.carryRate,
        theta: costs?.theta,
      })
    }

    return Array.from(grouped.entries())
      .map(([underlying, positionsInGroup]) => ({
        underlying,
        positions: positionsInGroup,
      }))
      .sort((a, b) => {
        const aTotal = a.positions.reduce((sum, p) => sum + p.notional, 0)
        const bTotal = b.positions.reduce((sum, p) => sum + p.notional, 0)
        return bTotal - aTotal
      })
  }, [
    committedPositions,
    currentWeights,
    nav,
    targetLeverage,
    instrumentCostsMap,
  ])

  const totalNotional = useMemo(() => {
    const totalWeight = committedPositions.reduce((sum, p) => {
      const weight = currentWeights.get(p.symbol) ?? p.weight
      return sum + weight
    }, 0)
    return nav * totalWeight * targetLeverage
  }, [committedPositions, currentWeights, nav, targetLeverage])

  // Effective leverage = total notional / NAV
  const effectiveLeverage = useMemo(
    () => totalNotional / nav,
    [totalNotional, nav],
  )

  // Execute staged trades: commit target → committed
  const executeStagedTrades = useCallback(() => {
    if (stagedTrades.length === 0) return

    // Apply target weights to positions
    const updatedPositions = committedPositions.map(p => ({
      ...p,
      weight: currentWeights.get(p.symbol) ?? p.weight,
    }))

    setCommittedPositions(updatedPositions)
    setCommittedLeverage(targetLeverage)
    setTargetWeightOverrides(new Map())
  }, [stagedTrades, committedPositions, currentWeights, targetLeverage])

  // Clear staged trades: revert target to committed
  const clearStagedTrades = useCallback(() => {
    setTargetWeightOverrides(new Map())
    setTargetLeverage(committedLeverage)
  }, [committedLeverage])

  // Legacy methods for compatibility (no longer used but keeping for API stability)
  const addStagedTrade = useCallback(
    (_symbol: string, _side: "buy" | "sell") => {
      // Manual trade staging is deprecated in favor of computed trades
    },
    [],
  )

  const removeStagedTrade = useCallback((_id: string) => {
    // Manual trade removal is deprecated
  }, [])

  return {
    nav,
    leverage: targetLeverage,
    setLeverage,
    effectiveLeverage,
    isLoading: false,

    positionsByUnderlying,
    totalNotional,
    adjustPositionWeight,
    updateInstrumentWeight,
    updateInstrumentNotional,
    greeks: MOCK_GREEKS,
    factorExposures: MOCK_FACTOR_EXPOSURES,
    assetAnalysis: MOCK_ASSET_ANALYSIS,

    stagedTrades,
    addStagedTrade,
    removeStagedTrade,
    clearStagedTrades,
    executeStagedTrades,

    // New properties for committed vs target state
    committedPositions,
    committedLeverage,
    targetLeverage,
    hasUnsavedChanges: stagedTrades.length > 0,

    correlationMatrix: MOCK_CORRELATION_MATRIX,
    correlationAssets: CORRELATION_ASSETS_LIST,
    factorDecomposition: MOCK_FACTOR_DECOMPOSITION,
    factorTargets: MOCK_FACTOR_TARGETS,
    riskMetrics: MOCK_RISK_METRICS,

    backtestData: MOCK_BACKTEST_DATA,
    performanceStats: MOCK_PERFORMANCE_STATS,
    monteCarloData: MOCK_MONTE_CARLO,
    stressTests: MOCK_STRESS_TESTS,

    factorHistoricalReturns: MOCK_FACTOR_HISTORICAL_RETURNS,
    factorAttribution: MOCK_FACTOR_ATTRIBUTION,
    concentrationMetrics: MOCK_CONCENTRATION_METRICS,
    drawdownData: MOCK_DRAWDOWN_DATA,
    returnDistribution: MOCK_RETURN_DISTRIBUTION,
  }
}
