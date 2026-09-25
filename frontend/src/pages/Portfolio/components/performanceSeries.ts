/**
 * Pure performance series transforms: outliers, resample, merge, TWR %, drawdown.
 */

import type {
  AccountPerformanceEvent,
  EquityPoint,
  VenuePerformanceSeries,
} from "@/services/account-performance"

export type PerformancePeriod = "24h" | "7d" | "30d" | "all-time"

export type ChartScaleMode = "percent" | "dollars"

export interface TimedValue {
  readonly timestamp_ms: number
  readonly value: number
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const PERIOD_LOOKBACK_MS: Record<PerformancePeriod, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "all-time": Number.POSITIVE_INFINITY,
}

/** Relative drop that marks a single-point API glitch when followed by recovery. */
export const OUTLIER_DROP_FRACTION = 0.99

export const pointValue = (point: EquityPoint): number => {
  const parsed = Number.parseFloat(point.value_usd)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export const isPositiveEquity = (value: number): boolean =>
  Number.isFinite(value) && value > 0

export const eventTimestampMs = (event: AccountPerformanceEvent): number =>
  event.timestamp_ms

export const eventSignedFlowUsd = (event: AccountPerformanceEvent): number => {
  const amount = Number.parseFloat(event.amount_usd)
  if (!Number.isFinite(amount)) return 0
  return event.kind === "deposit" ? Math.abs(amount) : -Math.abs(amount)
}

export const filterPointsByPeriod = (
  points: readonly EquityPoint[],
  period: PerformancePeriod,
): EquityPoint[] => {
  if (period === "all-time" || points.length === 0) return [...points]
  const maxTime = Math.max(...points.map(point => point.timestamp_ms))
  const cutoff = maxTime - PERIOD_LOOKBACK_MS[period]
  return points.filter(point => point.timestamp_ms >= cutoff)
}

export const filterEventsByPeriod = (
  events: readonly AccountPerformanceEvent[],
  period: PerformancePeriod,
  equityPoints: readonly EquityPoint[],
): AccountPerformanceEvent[] => {
  if (period === "all-time" || equityPoints.length === 0) return [...events]
  const maxTime = Math.max(...equityPoints.map(point => point.timestamp_ms))
  const cutoff = maxTime - PERIOD_LOOKBACK_MS[period]
  return events.filter(event => event.timestamp_ms >= cutoff)
}

export const chartableEquityPoints = (
  points: readonly EquityPoint[],
): EquityPoint[] => points.filter(point => isPositiveEquity(pointValue(point)))

/**
 * Drop a single sample that collapses by OUTLIER_DROP_FRACTION vs neighbors
 * then recovers; forward-fill the previous good value across the hole.
 */
export const filterEquityOutliers = (
  points: readonly EquityPoint[],
): EquityPoint[] => {
  const chartable = chartableEquityPoints(points)
  if (chartable.length < 3) {
    return chartable
  }

  const values = chartable.map(pointValue)
  const kept: EquityPoint[] = []
  let previousGood: EquityPoint | undefined

  for (const [index, point] of chartable.entries()) {
    const value = values[index] ?? Number.NaN
    if (!isPositiveEquity(value)) continue

    const previous = index > 0 ? values[index - 1] : undefined
    const next = index + 1 < values.length ? values[index + 1] : undefined
    const isSpike =
      previous !== undefined &&
      next !== undefined &&
      isPositiveEquity(previous) &&
      isPositiveEquity(next) &&
      value <= previous * (1 - OUTLIER_DROP_FRACTION) &&
      next >= previous * (1 - OUTLIER_DROP_FRACTION * 0.5)

    if (isSpike) {
      if (previousGood !== undefined) {
        kept.push({
          timestamp_ms: point.timestamp_ms,
          value_usd: previousGood.value_usd,
        })
      }
      continue
    }

    kept.push(point)
    previousGood = point
  }

  return kept
}

export const resampleBucketMs = (period: PerformancePeriod): number => {
  if (period === "24h" || period === "7d") return HOUR_MS
  return DAY_MS
}

/** Last sample in each time bucket (hour or day). */
export const resampleEquityPoints = (
  points: readonly EquityPoint[],
  bucketMs: number,
): EquityPoint[] => {
  if (points.length === 0) return []
  const byBucket = new Map<number, { sourceMs: number; point: EquityPoint }>()
  for (const point of points) {
    const bucket = Math.floor(point.timestamp_ms / bucketMs) * bucketMs
    const existing = byBucket.get(bucket)
    if (existing === undefined || point.timestamp_ms >= existing.sourceMs) {
      byBucket.set(bucket, {
        sourceMs: point.timestamp_ms,
        point: {
          timestamp_ms: bucket + bucketMs - 1,
          value_usd: point.value_usd,
        },
      })
    }
  }
  return [...byBucket.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, entry]) => entry.point)
}

/**
 * Merge venue equity onto a shared timeline by carrying each venue's last
 * known positive equity forward, then summing.
 */
export const forwardFillMergeEquity = (
  seriesList: readonly VenuePerformanceSeries[],
): EquityPoint[] => {
  const cleaned = seriesList.map(series => ({
    venue: series.venue,
    points: filterEquityOutliers(series.equity_points),
  }))

  const timestamps = new Set<number>()
  for (const series of cleaned) {
    for (const point of series.points) {
      timestamps.add(point.timestamp_ms)
    }
  }
  const sortedTimes = [...timestamps].sort((left, right) => left - right)
  if (sortedTimes.length === 0) return []

  const cursors = cleaned.map(series => ({
    points: series.points,
    index: 0,
    last: undefined as number | undefined,
  }))

  const merged: EquityPoint[] = []
  for (const time of sortedTimes) {
    let total = 0
    let hasAny = false
    for (const cursor of cursors) {
      for (const sample of cursor.points.slice(cursor.index)) {
        if (sample.timestamp_ms > time) break
        cursor.last = pointValue(sample)
        cursor.index += 1
      }
      if (cursor.last !== undefined && isPositiveEquity(cursor.last)) {
        total += cursor.last
        hasAny = true
      }
    }
    if (hasAny) {
      merged.push({ timestamp_ms: time, value_usd: total.toString() })
    }
  }
  return merged
}

const applyFlowsAtEquity = (
  equity: number,
  units: number,
  flows: readonly AccountPerformanceEvent[],
  flowIndex: number,
  timestampMs: number,
): { units: number; flowIndex: number } => {
  let nextUnits = units
  let nextFlowIndex = flowIndex
  for (const flow of flows.slice(nextFlowIndex)) {
    if (flow.timestamp_ms > timestampMs) break
    nextFlowIndex += 1
    if (nextUnits <= 0) continue
    const signed = eventSignedFlowUsd(flow)
    const equityBeforeFlow = equity - signed
    if (!isPositiveEquity(equityBeforeFlow)) continue
    nextUnits = (nextUnits * equity) / equityBeforeFlow
    if (nextUnits < 0) nextUnits = 0
  }
  return { units: nextUnits, flowIndex: nextFlowIndex }
}

/**
 * Build a continuous TWR percent series from equity samples and external flows.
 *
 * Uses a unit-trust model: deposits buy units at the current mark, withdrawals
 * redeem units, so external cash does not appear as return.
 */
export const twrPercentSeries = (
  equityPoints: readonly EquityPoint[],
  events: readonly AccountPerformanceEvent[],
): TimedValue[] => {
  const points = chartableEquityPoints(equityPoints)
  if (points.length === 0) return []

  const flows = [...events].sort(
    (left, right) => left.timestamp_ms - right.timestamp_ms,
  )
  let flowIndex = 0
  let units = 0
  let baseNavPerUnit: number | undefined
  const output: TimedValue[] = []

  for (const point of points) {
    const equity = pointValue(point)
    if (!isPositiveEquity(equity)) continue

    const adjusted = applyFlowsAtEquity(
      equity,
      units,
      flows,
      flowIndex,
      point.timestamp_ms,
    )
    units = adjusted.units
    flowIndex = adjusted.flowIndex

    if (units <= 0) {
      units = 1
      baseNavPerUnit = equity
    }

    const navPerUnit = equity / units
    baseNavPerUnit ??= navPerUnit
    if (!isPositiveEquity(baseNavPerUnit) || !isPositiveEquity(navPerUnit)) {
      continue
    }

    output.push({
      timestamp_ms: point.timestamp_ms,
      value: (navPerUnit / baseNavPerUnit - 1) * 100,
    })
  }

  return output
}

/** Simple percent from first point (no cash-flow adjustment). */
export const simplePercentSeries = (
  equityPoints: readonly EquityPoint[],
): TimedValue[] => {
  const points = chartableEquityPoints(equityPoints)
  if (points.length === 0) return []
  const [firstPoint] = points
  const first = pointValue(firstPoint)
  if (!isPositiveEquity(first)) return []
  return points.map(point => ({
    timestamp_ms: point.timestamp_ms,
    value: (pointValue(point) / first - 1) * 100,
  }))
}

export const dollarSeries = (
  equityPoints: readonly EquityPoint[],
): TimedValue[] =>
  chartableEquityPoints(equityPoints).map(point => ({
    timestamp_ms: point.timestamp_ms,
    value: pointValue(point),
  }))

/**
 * Underwater drawdown on TWR nav-per-unit, as percent below the running peak.
 */
export const underwaterDrawdownSeries = (
  equityPoints: readonly EquityPoint[],
  events: readonly AccountPerformanceEvent[],
): TimedValue[] => {
  const points = chartableEquityPoints(equityPoints)
  if (points.length === 0) return []

  const flows = [...events].sort(
    (left, right) => left.timestamp_ms - right.timestamp_ms,
  )
  let flowIndex = 0
  let units = 0
  let peakNav = Number.NEGATIVE_INFINITY
  const output: TimedValue[] = []

  for (const point of points) {
    const equity = pointValue(point)
    if (!isPositiveEquity(equity)) continue

    const adjusted = applyFlowsAtEquity(
      equity,
      units,
      flows,
      flowIndex,
      point.timestamp_ms,
    )
    units = adjusted.units
    flowIndex = adjusted.flowIndex

    if (units <= 0) {
      units = 1
    }

    const navPerUnit = equity / units
    if (!isPositiveEquity(navPerUnit)) continue
    if (navPerUnit > peakNav) peakNav = navPerUnit
    const drawdown = peakNav > 0 ? (navPerUnit / peakNav - 1) * 100 : 0
    output.push({ timestamp_ms: point.timestamp_ms, value: drawdown })
  }

  return output
}

export const equityPriceScaleRange = (
  values: readonly number[],
): { minValue: number; maxValue: number } | null => {
  const usable = values.filter(Number.isFinite)
  if (usable.length === 0) return null

  const minValue = Math.min(...usable)
  const maxValue = Math.max(...usable)
  const mid = (minValue + maxValue) / 2
  const observed = maxValue - minValue
  const minSpan =
    Math.abs(mid) > 1
      ? Math.max(Math.abs(mid) * 0.05, 1)
      : Math.max(observed, 1)
  const span = Math.max(observed, minSpan)
  const pad = span * 0.1
  return {
    minValue: mid - span / 2 - pad,
    maxValue: mid + span / 2 + pad,
  }
}

export const prepareVenueEquity = (
  series: VenuePerformanceSeries,
  period: PerformancePeriod,
): { equity: EquityPoint[]; events: AccountPerformanceEvent[] } => {
  const filtered = filterPointsByPeriod(series.equity_points, period)
  const withoutOutliers = filterEquityOutliers(filtered)
  const resampled = resampleEquityPoints(
    withoutOutliers,
    resampleBucketMs(period),
  )
  const events = filterEventsByPeriod(series.events, period, resampled)
  return { equity: resampled, events }
}
