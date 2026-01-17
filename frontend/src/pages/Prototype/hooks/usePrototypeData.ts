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
  MOCK_FACTOR_HISTORICAL_RETURNS,
  MOCK_FACTOR_ATTRIBUTION,
  MOCK_CONCENTRATION_METRICS,
  MOCK_DRAWDOWN_DATA,
  MOCK_RETURN_DISTRIBUTION,
  type StagedTrade,
} from "../mockData"

export interface PositionsByUnderlying {
  underlying: string
  positions: Array<{
    symbol: string
    side: "long" | "short"
    notional: number
    percentage: number
  }>
}

export const usePrototypeData = () => {
  const [stagedTrades, setStagedTrades] = useState<StagedTrade[]>([])

  const nav = 250000

  const positionsByUnderlying = useMemo((): PositionsByUnderlying[] => {
    const grouped = new Map<string, PositionsByUnderlying["positions"]>()

    for (const position of MOCK_POSITIONS) {
      if (!grouped.has(position.underlying)) {
        grouped.set(position.underlying, [])
      }

      grouped.get(position.underlying)?.push({
        symbol: position.symbol,
        side: position.side,
        notional: position.notional,
        percentage: position.percentage,
      })
    }

    return Array.from(grouped.entries())
      .map(([underlying, positions]) => ({ underlying, positions }))
      .sort((a, b) => {
        const aTotal = a.positions.reduce((sum, p) => sum + p.notional, 0)
        const bTotal = b.positions.reduce((sum, p) => sum + p.notional, 0)
        return bTotal - aTotal
      })
  }, [])

  const totalNotional = useMemo(() => {
    return MOCK_POSITIONS.reduce((sum, p) => sum + p.notional, 0)
  }, [])

  const addStagedTrade = useCallback((symbol: string, side: "buy" | "sell") => {
    const newTrade: StagedTrade = {
      id: `${symbol}-${side}-${Date.now()}`,
      symbol,
      side,
      notional: 1000,
      leverage: 3,
    }
    setStagedTrades(prev => [...prev, newTrade])
  }, [])

  const removeStagedTrade = useCallback((id: string) => {
    setStagedTrades(prev => prev.filter(t => t.id !== id))
  }, [])

  const clearStagedTrades = useCallback(() => {
    setStagedTrades([])
  }, [])

  const executeStagedTrades = useCallback(() => {
    setStagedTrades([])
  }, [])

  return {
    nav,
    isLoading: false,

    positionsByUnderlying,
    totalNotional,
    greeks: MOCK_GREEKS,
    factorExposures: MOCK_FACTOR_EXPOSURES,
    assetAnalysis: MOCK_ASSET_ANALYSIS,

    stagedTrades,
    addStagedTrade,
    removeStagedTrade,
    clearStagedTrades,
    executeStagedTrades,

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
