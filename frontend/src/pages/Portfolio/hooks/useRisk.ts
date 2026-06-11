import { useQuery } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import type { PortfolioInterface } from "./usePortfolioState"
import type { ReadonlyBetaPosition } from "./useReadonlyPortfolioState"
import { queryKeyFromWeights, weightsFromPortfolio } from "./useBeta"

export interface RiskMeasurementWindow {
  lookbackDays?: number
  startDate?: string
  endDate?: string
}

export interface RiskMeasurementContract {
  window: RiskMeasurementWindow
  samplingFrequency: "daily" | "weekly"
  confidenceLevels: number[]
}

export interface TailRiskMetric {
  confidenceLevel: number
  var: number
  cvar: number
}

export interface RiskDrawdown {
  maxDrawdown: number
  peakToTroughPeriods: number
}

export interface RiskCorrelation {
  tickers: string[]
  matrix: number[][]
  shrinkageIntensity: number
}

export interface RiskEffectiveBets {
  meucci: number
  stressedMeucci: number
  inverseHerfindahl: number
}

export interface RiskReport {
  contract: RiskMeasurementContract
  tailRisk: TailRiskMetric[]
  drawdown: RiskDrawdown
  correlation: RiskCorrelation
  effectiveBets: RiskEffectiveBets
}

const fetchRisk = async (
  weights: Record<string, number>,
  signal?: AbortSignal,
): Promise<RiskReport> => {
  const res = await fetch(`${import.meta.env.BASE_URL}api/risk`, {
    method: "POST",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weights }),
  })
  if (!res.ok) {
    const failure = (await res.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(failure?.error ?? `risk request failed: ${res.status}`)
  }
  return res.json() as Promise<RiskReport>
}

export const useRisk = (
  portfolio: () => Record<string, PortfolioInterface | undefined>,
  portfolioTotalNotional: () => number,
  readonlyPositions: () => ReadonlyBetaPosition[],
) => {
  const weights = createMemo(() =>
    weightsFromPortfolio(
      portfolio(),
      portfolioTotalNotional(),
      readonlyPositions(),
    ),
  )
  const weightsKey = createMemo(() => queryKeyFromWeights(weights()))

  const query = useQuery(() => {
    const currentWeights = weights()
    const currentWeightsKey = weightsKey()
    const hasData = Object.keys(currentWeights).length > 0

    return {
      queryKey: ["risk", currentWeightsKey] as const,
      queryFn: (ctx: { signal: AbortSignal }) =>
        fetchRisk(currentWeights, ctx.signal),
      enabled: hasData,
      retry: 2,
    }
  })

  return {
    get report() {
      return query.data ?? null
    },
    get isLoading() {
      return query.isLoading
    },
    get error() {
      return query.error
    },
  }
}

export type RiskResult = ReturnType<typeof useRisk>
