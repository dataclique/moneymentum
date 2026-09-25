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

export interface PeriodWindow {
  readonly startMs: number
  readonly endMs: number
  readonly bucketMs: number
  readonly gridTimes: readonly number[]
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

export const resampleBucketMs = (period: PerformancePeriod): number => {
  if (period === "24h" || period === "7d") return HOUR_MS
  return DAY_MS
}

/** Bucket close timestamps covering [startMs, endMs]. */
export const buildPeriodGrid = (
  startMs: number,
  endMs: number,
  bucketMs: number,
): number[] => {
  if (!(endMs >= startMs) || bucketMs <= 0) return []
  const firstBucket = Math.floor(startMs / bucketMs) * bucketMs
  const lastBucket = Math.floor(endMs / bucketMs) * bucketMs
  const times: number[] = []
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += bucketMs) {
    times.push(bucket + bucketMs - 1)
  }
  return times
}

/**
 * Shared chart window for the selected period. End is max(now, latest sample)
 * so a 7d window always ends at "today" even when a venue is sparse.
 */
export const computePeriodWindow = (
  period: PerformancePeriod,
  seriesList: readonly VenuePerformanceSeries[],
  nowMs: number,
): PeriodWindow => {
  const bucketMs = resampleBucketMs(period)
  let dataStart = Number.POSITIVE_INFINITY
  let dataEnd = Number.NEGATIVE_INFINITY

  for (const series of seriesList) {
    for (const point of series.equity_points) {
      if (!isPositiveEquity(pointValue(point))) continue
      dataStart = Math.min(dataStart, point.timestamp_ms)
      dataEnd = Math.max(dataEnd, point.timestamp_ms)
    }
  }

  const hasData = Number.isFinite(dataStart) && Number.isFinite(dataEnd)
  const endMs = hasData ? Math.max(dataEnd, nowMs) : nowMs
  const startMs =
    period === "all-time"
      ? hasData
        ? dataStart
        : endMs - DAY_MS
      : endMs - PERIOD_LOOKBACK_MS[period]

  return {
    startMs,
    endMs,
    bucketMs,
    gridTimes: buildPeriodGrid(startMs, endMs, bucketMs),
  }
}

/**
 * Carry the last positive equity onto each grid close. Leading buckets before
 * the first observation stay empty so we do not invent pre-history.
 */
export const forwardFillOntoGrid = (
  points: readonly EquityPoint[],
  gridTimes: readonly number[],
): EquityPoint[] => {
  if (gridTimes.length === 0) return []
  const sorted = [...points].sort(
    (left, right) => left.timestamp_ms - right.timestamp_ms,
  )
  let index = 0
  let lastValue: string | undefined
  const filled: EquityPoint[] = []

  for (const time of gridTimes) {
    for (const sample of sorted.slice(index)) {
      if (sample.timestamp_ms > time) break
      const value = pointValue(sample)
      if (isPositiveEquity(value)) {
        lastValue = sample.value_usd
      }
      index += 1
    }
    if (lastValue !== undefined) {
      filled.push({ timestamp_ms: time, value_usd: lastValue })
    }
  }
  return filled
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

/**
 * If venue equity history starts without a recorded deposit, treat the first
 * positive mark as an external opening deposit so connecting a funded venue
 * does not look like investment return on Total.
 */
export const withImpliedOpeningDeposit = (
  equityPoints: readonly EquityPoint[],
  events: readonly AccountPerformanceEvent[],
): AccountPerformanceEvent[] => {
  const chartable = chartableEquityPoints(equityPoints)
  let first: EquityPoint | undefined
  for (const point of chartable) {
    first = point
    break
  }
  if (first === undefined) return [...events]

  const hasOpeningDeposit = events.some(
    event =>
      event.kind === "deposit" && event.timestamp_ms <= first.timestamp_ms,
  )
  if (hasOpeningDeposit) return [...events]

  const opening: AccountPerformanceEvent = {
    kind: "deposit",
    timestamp_ms: first.timestamp_ms,
    amount_usd: first.value_usd,
    source_id: `implied-open:${String(first.timestamp_ms)}`,
  }
  return [...events, opening].sort(
    (left, right) => left.timestamp_ms - right.timestamp_ms,
  )
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

  const flows = withImpliedOpeningDeposit(points, events)
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

  const flows = withImpliedOpeningDeposit(points, events)
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

const eventsInWindow = (
  events: readonly AccountPerformanceEvent[],
  startMs: number,
  endMs: number,
): AccountPerformanceEvent[] =>
  events.filter(
    event => event.timestamp_ms >= startMs && event.timestamp_ms <= endMs,
  )

/**
 * Clean, grid-align, and attach cash-flow events for one venue on a shared
 * period window so every hour/day in the selected range is hoverable.
 */
export const prepareVenueEquity = (
  series: VenuePerformanceSeries,
  window: PeriodWindow,
): { equity: EquityPoint[]; events: AccountPerformanceEvent[] } => {
  const withoutOutliers = filterEquityOutliers(series.equity_points)
  // Keep one bucket of pre-window history so the first grid cell can fill.
  const seedCutoff = window.startMs - window.bucketMs
  const seeded = withoutOutliers.filter(
    point => point.timestamp_ms >= seedCutoff,
  )
  const equity = forwardFillOntoGrid(seeded, window.gridTimes)
  const events = withImpliedOpeningDeposit(
    equity,
    eventsInWindow(series.events, window.startMs, window.endMs),
  )
  return { equity, events }
}
