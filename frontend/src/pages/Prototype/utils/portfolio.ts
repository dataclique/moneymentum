import type { CorrelationEntry, Greeks, FactorAttribution } from "../mockData"
import type { PositionsByUnderlying } from "../hooks/usePrototypeData"

export interface AggregatedGreeks {
  delta: number
  gamma: number
  theta: number
}

export const aggregateGreeks = (greeks: Greeks[]): AggregatedGreeks =>
  greeks.reduce(
    (acc, g) => ({
      delta: acc.delta + g.delta,
      gamma: acc.gamma + g.gamma,
      theta: acc.theta + g.theta,
    }),
    { delta: 0, gamma: 0, theta: 0 },
  )

export const calculateTotalNotional = (
  groups: PositionsByUnderlying[],
): number =>
  groups.reduce(
    (sum, group) => sum + group.positions.reduce((s, p) => s + p.notional, 0),
    0,
  )

export const calculateGroupNotional = (
  positions: PositionsByUnderlying["positions"],
): number => positions.reduce((sum, p) => sum + p.notional, 0)

export const calculateGroupWeight = (
  positions: PositionsByUnderlying["positions"],
): number => positions.reduce((sum, p) => sum + p.weight, 0)

export const calculateNetSide = (
  positions: PositionsByUnderlying["positions"],
): "long" | "short" | "neutral" => {
  const totalLong = positions
    .filter(p => p.side === "long")
    .reduce((sum, p) => sum + p.notional, 0)
  const totalShort = positions
    .filter(p => p.side === "short")
    .reduce((sum, p) => sum + p.notional, 0)

  const netExposure = totalLong - totalShort
  const grossExposure = totalLong + totalShort

  // Consider neutral if net exposure is <10% of gross exposure (delta-neutral strategies)
  if (grossExposure > 0 && Math.abs(netExposure) / grossExposure < 0.1) {
    return "neutral"
  }

  return netExposure >= 0 ? "long" : "short"
}

export const calculatePositionWeight = (
  posNotional: number,
  groupNotional: number,
): number => (groupNotional === 0 ? 0 : posNotional / groupNotional)

interface AssetWithSharpe {
  ticker: string
  sharpe: number
}

export const filterAssetsByQuery = <T extends AssetWithSharpe>(
  assets: T[],
  query: string,
): T[] => {
  if (!query) return assets
  const q = query.toLowerCase()
  return assets.filter(a => a.ticker.toLowerCase().includes(q))
}

export const sortAssetsBySharpe = <T extends AssetWithSharpe>(
  assets: T[],
): T[] => [...assets].sort((a, b) => b.sharpe - a.sharpe)

export const lookupCorrelation = (
  matrix: CorrelationEntry[],
  asset1: string,
  asset2: string,
): number => {
  const entry = matrix.find(
    e =>
      (e.asset1 === asset1 && e.asset2 === asset2) ||
      (e.asset1 === asset2 && e.asset2 === asset1),
  )
  return entry?.correlation ?? 0
}

export const getCorrelationColor = (correlation: number): string => {
  if (correlation >= 0.7) return "bg-green-600"
  if (correlation >= 0.3) return "bg-green-500/60"
  if (correlation >= 0) return "bg-green-500/30"
  if (correlation >= -0.3) return "bg-red-500/30"
  if (correlation >= -0.7) return "bg-red-500/60"
  return "bg-red-600"
}

export const calculateTotalAttribution = (
  attributions: FactorAttribution[],
): number => attributions.reduce((sum, f) => sum + f.contribution, 0)

export const FACTOR_COLORS: Record<string, string> = {
  "β to BTC": "#3b82f6",
  "β to SPY": "#22c55e",
  "Momentum": "#f59e0b",
  "Carry": "#ef4444",
  "Volatility": "#8b5cf6",
  "Idiosyncratic": "#888888",
}
