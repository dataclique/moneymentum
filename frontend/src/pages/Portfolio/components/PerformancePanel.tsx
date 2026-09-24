import {
  createSignal,
  createMemo,
  createEffect,
  Show,
  For,
  onCleanup,
} from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import * as Effect from "effect/Effect"
import {
  createChart,
  AreaSeries,
  CrosshairMode,
  type IChartApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts"
import { useWallet } from "@/hooks/useWallet"
import { getErrorMessage } from "@/lib/error-message"
import { MetricSelector } from "../../Prototype/components/MetricSelector"
import {
  fetchWalletPerformance,
  refreshHyperliquidPerformance,
  type EquityPoint,
  type VenuePerformanceSeries,
} from "@/services/account-performance"
import { syncDerivePerformanceToCache } from "@/services/derive/performance"
import {
  isPerformanceSyncStale,
  writePerformanceSyncedAt,
} from "@/services/performance-sync-cookie"

type Period = "1M" | "3M" | "6M" | "1Y" | "All"

const PERIODS: Period[] = ["1M", "3M", "6M", "1Y", "All"]
const PERIOD_DAYS: Record<Period, number> = {
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "1Y": 365,
  "All": Infinity,
}

/** Minimum visible equity span as a fraction of mid price (avoids mountain noise). */
const MIN_SCALE_FRACTION = 0.05
/** Floor for that span in USD so tiny accounts still get a calm axis. */
const MIN_SCALE_USD = 100
/** Extra padding around the chosen span. */
const SCALE_PAD_FRACTION = 0.1

const UNSUPPORTED = "—"

const formatUsd = (value: number): string =>
  value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  })

const pointValue = (point: EquityPoint): number => {
  const parsed = Number.parseFloat(point.value_usd)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

const isChartableEquity = (value: number): boolean =>
  Number.isFinite(value) && value > 0

const filterPointsByPeriod = (
  points: readonly EquityPoint[],
  period: Period,
): EquityPoint[] => {
  if (period === "All" || points.length === 0) return [...points]
  const maxTime = Math.max(...points.map(point => point.timestamp_ms))
  const cutoff = maxTime - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000
  return points.filter(point => point.timestamp_ms >= cutoff)
}

/** Drop zero/NaN venue samples that collapse the Y scale to the origin. */
export const chartableEquityPoints = (
  points: readonly EquityPoint[],
): EquityPoint[] => points.filter(point => isChartableEquity(pointValue(point)))

/**
 * Stable price range: expand tiny swings to at least 5% of mid (or $100),
 * so the chart does not flip between a flat line and exaggerated mountains.
 */
export const equityPriceScaleRange = (
  values: readonly number[],
): { minValue: number; maxValue: number } | null => {
  const usable = values.filter(isChartableEquity)
  if (usable.length === 0) return null

  const minValue = Math.min(...usable)
  const maxValue = Math.max(...usable)
  const mid = (minValue + maxValue) / 2
  const observed = maxValue - minValue
  const minSpan = Math.max(mid * MIN_SCALE_FRACTION, MIN_SCALE_USD)
  const span = Math.max(observed, minSpan)
  const pad = span * SCALE_PAD_FRACTION
  return {
    minValue: mid - span / 2 - pad,
    maxValue: mid + span / 2 + pad,
  }
}

/** Merge venue series onto a shared timeline (sum values at matching second buckets). */
export const mergeEquitySeries = (
  seriesList: readonly VenuePerformanceSeries[],
): EquityPoint[] => {
  const bySecond = new Map<number, number>()
  for (const series of seriesList) {
    for (const point of series.equity_points) {
      const value = pointValue(point)
      if (!isChartableEquity(value)) continue
      const second = Math.floor(point.timestamp_ms / 1000)
      const previous = bySecond.get(second) ?? 0
      bySecond.set(second, previous + value)
    }
  }
  return [...bySecond.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([second, value]) => ({
      timestamp_ms: second * 1000,
      value_usd: value.toString(),
    }))
}

type HoverEquityLabel = {
  x: number
  y: number
  text: string
}

export const PerformancePanel = () => {
  const {
    mainAddress,
    networkMode,
    deriveCredentials,
    isHyperliquidConnected,
    isDeriveConnected,
    isDeriveLocked,
  } = useWallet()

  const [selectedMetricIds, setSelectedMetricIds] = createSignal<string[]>([])
  const [selectedWindowId, setSelectedWindowId] = createSignal<string>("1m")
  const [isMetricSelectorOpen, setIsMetricSelectorOpen] = createSignal(false)
  const [period, setPeriod] = createSignal<Period>("All")
  const [includeHyperliquid, setIncludeHyperliquid] = createSignal(true)
  const [includeDerive, setIncludeDerive] = createSignal(true)
  const [hoverLabel, setHoverLabel] = createSignal<HoverEquityLabel | null>(
    null,
  )

  let chartHost: HTMLDivElement | undefined
  let chartApi: IChartApi | undefined

  const performanceQuery = useQuery(() => {
    const hlAddress = mainAddress()
    const deriveSession = deriveCredentials()
    const deriveAddress = deriveSession?.deriveWallet ?? null
    const network = networkMode()
    const wantHl = isHyperliquidConnected() && includeHyperliquid()
    const wantDerive =
      isDeriveConnected() && !isDeriveLocked() && includeDerive()

    return {
      queryKey: [
        "account-performance",
        hlAddress,
        deriveAddress,
        network,
        wantHl,
        wantDerive,
      ] as const,
      enabled: wantHl || wantDerive,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        if (wantHl && hlAddress !== null && isPerformanceSyncStale(hlAddress)) {
          await Effect.runPromise(
            refreshHyperliquidPerformance(hlAddress, network, signal),
          )
          writePerformanceSyncedAt(hlAddress)
        }
        if (
          wantDerive &&
          deriveSession !== null &&
          isPerformanceSyncStale(deriveSession.deriveWallet)
        ) {
          await Effect.runPromise(
            syncDerivePerformanceToCache(deriveSession, signal),
          )
          writePerformanceSyncedAt(deriveSession.deriveWallet)
        }

        const series: VenuePerformanceSeries[] = []
        if (wantHl && hlAddress !== null) {
          const cache = await Effect.runPromise(
            fetchWalletPerformance(hlAddress, signal),
          )
          for (const venueSeries of cache.venues) {
            if (venueSeries.venue === "hyperliquid") {
              series.push(venueSeries)
            }
          }
        }
        if (wantDerive && deriveAddress !== null) {
          const cache = await Effect.runPromise(
            fetchWalletPerformance(deriveAddress, signal),
          )
          for (const venueSeries of cache.venues) {
            if (venueSeries.venue === "derive") {
              series.push(venueSeries)
            }
          }
        }
        return series
      },
    }
  })

  const mergedPoints = createMemo(() =>
    mergeEquitySeries(performanceQuery.data ?? []),
  )

  const periodPoints = createMemo(() =>
    chartableEquityPoints(filterPointsByPeriod(mergedPoints(), period())),
  )

  const endingEquity = createMemo(() => {
    const points = periodPoints()
    let lastPoint: EquityPoint | undefined
    for (const point of points) {
      lastPoint = point
    }
    if (lastPoint === undefined) return null
    const value = pointValue(lastPoint)
    return isChartableEquity(value) ? value : null
  })

  // Imperative lightweight-charts mount: must create/destroy the chart when
  // series data or host size inputs change (not expressible as createMemo).
  createEffect(() => {
    const host = chartHost
    if (host === undefined) return

    const points = periodPoints()
    const isLoading = performanceQuery.isLoading
    const error = performanceQuery.error
    const enabled = performanceQuery.isEnabled

    if (chartApi !== undefined) {
      chartApi.remove()
      chartApi = undefined
    }
    setHoverLabel(null)

    if (!enabled || isLoading || error !== null || points.length === 0) {
      return
    }

    const chartValues = points.map(pointValue).filter(isChartableEquity)
    const priceRange = equityPriceScaleRange(chartValues)

    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: { background: { color: "transparent" }, textColor: "#888" },
      grid: { vertLines: { color: "#222" }, horzLines: { color: "#222" } },
      timeScale: { borderColor: "#333", timeVisible: false },
      rightPriceScale: {
        borderColor: "#333",
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          labelVisible: true,
        },
        horzLine: {
          labelVisible: true,
        },
      },
    })
    chartApi = chart

    const area = chart.addSeries(AreaSeries, {
      lineColor: "#22c55e",
      topColor: "rgba(34, 197, 94, 0.3)",
      bottomColor: "rgba(34, 197, 94, 0)",
      lineWidth: 1,
      autoscaleInfoProvider: () =>
        priceRange === null
          ? null
          : {
              priceRange,
            },
    })
    area.setData(
      points.map(point => ({
        time: Math.floor(point.timestamp_ms / 1000) as Time,
        value: pointValue(point),
      })),
    )
    chart.timeScale().fitContent()

    const onCrosshairMove = (param: MouseEventParams) => {
      if (
        param.point === undefined ||
        param.time === undefined ||
        param.point.x < 0 ||
        param.point.y < 0
      ) {
        setHoverLabel(null)
        return
      }
      const sample = param.seriesData.get(area)
      if (
        sample === undefined ||
        !("value" in sample) ||
        typeof sample.value !== "number" ||
        !isChartableEquity(sample.value)
      ) {
        setHoverLabel(null)
        return
      }
      setHoverLabel({
        x: param.point.x,
        y: param.point.y,
        text: formatUsd(sample.value),
      })
    }
    chart.subscribeCrosshairMove(onCrosshairMove)

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    resizeObserver.observe(host)

    onCleanup(() => {
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      resizeObserver.disconnect()
      chart.remove()
      if (chartApi === chart) {
        chartApi = undefined
      }
      setHoverLabel(null)
    })
  })

  return (
    <div class="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div class="flex min-h-0 flex-1">
        <div class="w-[180px] shrink-0 border-r border-border/30 p-3 overflow-auto scrollbar-hide flex flex-col gap-2">
          <MetricSelector
            selectedMetricIds={selectedMetricIds()}
            selectedWindowId={selectedWindowId()}
            onMetricToggle={id => {
              setSelectedMetricIds(previousSelectedMetricIds =>
                previousSelectedMetricIds.includes(id)
                  ? previousSelectedMetricIds.filter(
                      removedMetricId => removedMetricId !== id,
                    )
                  : [...previousSelectedMetricIds, id],
              )
            }}
            onWindowChange={setSelectedWindowId}
            isOpen={isMetricSelectorOpen()}
            onOpenChange={setIsMetricSelectorOpen}
            isFocused={false}
          />
          <div class="flex justify-between pb-2 border-b border-border/30">
            <span class="text-muted-foreground">Total Return</span>
            <span class="font-mono">
              {(() => {
                const equity = endingEquity()
                return equity === null ? UNSUPPORTED : formatUsd(equity)
              })()}
            </span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Sharpe</span>
            <span class="font-mono">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Sortino</span>
            <span class="font-mono">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Calmar</span>
            <span class="font-mono">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Max Drawdown</span>
            <span class="font-mono text-red-400">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Win Rate</span>
            <span class="font-mono">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Profit Factor</span>
            <span class="font-mono">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Volatility</span>
            <span class="font-mono">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">Beta</span>
            <span class="font-mono">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">VaR 95%</span>
            <span class="font-mono text-red-400">{UNSUPPORTED}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted-foreground">VaR 99%</span>
            <span class="font-mono text-red-400">{UNSUPPORTED}</span>
          </div>
        </div>

        <div class="flex-1 min-w-0 p-2 flex flex-col gap-1">
          <div class="flex items-center justify-between shrink-0 px-1">
            <div class="flex gap-1">
              <For each={PERIODS}>
                {chip => (
                  <button
                    type="button"
                    onClick={() => {
                      setPeriod(chip)
                    }}
                    class={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                      period() === chip
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {chip}
                  </button>
                )}
              </For>
            </div>
            <div class="flex gap-2 text-[9px] text-muted-foreground">
              <label class="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeHyperliquid()}
                  disabled={!isHyperliquidConnected()}
                  onChange={event => {
                    setIncludeHyperliquid(event.currentTarget.checked)
                  }}
                />
                HL
              </label>
              <label class="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDerive()}
                  disabled={!isDeriveConnected() || isDeriveLocked()}
                  onChange={event => {
                    setIncludeDerive(event.currentTarget.checked)
                  }}
                />
                Derive
              </label>
            </div>
          </div>

          <div class="relative flex-1 min-h-0">
            <div ref={chartHost} class="absolute inset-0" />
            <Show when={hoverLabel()}>
              {label => (
                <div
                  class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded bg-background/90 px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow border border-border/60"
                  style={{
                    left: `${label().x}px`,
                    top: `${Math.max(label().y - 8, 4)}px`,
                  }}
                >
                  {label().text}
                </div>
              )}
            </Show>
            <Show when={!performanceQuery.isEnabled}>
              <div class="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground border border-dashed border-border/50 rounded">
                Connect Hyperliquid or Derive to load equity
              </div>
            </Show>
            <Show
              when={performanceQuery.isEnabled && performanceQuery.isLoading}
            >
              <div class="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground border border-dashed border-border/50 rounded">
                Loading equity…
              </div>
            </Show>
            <Show when={performanceQuery.error}>
              <div class="absolute inset-0 flex items-center justify-center text-[10px] text-red-400 border border-dashed border-border/50 rounded px-2 text-center">
                {getErrorMessage(performanceQuery.error)}
              </div>
            </Show>
            <Show
              when={
                performanceQuery.isEnabled &&
                !performanceQuery.isLoading &&
                !performanceQuery.isError &&
                periodPoints().length === 0
              }
            >
              <div class="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground border border-dashed border-border/50 rounded">
                No equity history in cache for the selected venues
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
