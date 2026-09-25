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
  LineSeries,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts"
import { useWallet } from "@/hooks/useWallet"
import { getErrorMessage } from "@/lib/error-message"
import { MetricSelector } from "../../Prototype/components/MetricSelector"
import {
  fetchWalletPerformance,
  refreshHyperliquidPerformance,
  type VenuePerformanceSeries,
} from "@/services/account-performance"
import { syncDerivePerformanceToCache } from "@/services/derive/performance"
import {
  isPerformanceSyncStale,
  writePerformanceSyncedAt,
} from "@/services/performance-sync-cookie"
import {
  dollarSeries,
  equityPriceScaleRange,
  forwardFillMergeEquity,
  prepareVenueEquity,
  twrPercentSeries,
  underwaterDrawdownSeries,
  type ChartScaleMode,
  type PerformancePeriod,
  type TimedValue,
} from "./performanceSeries"

const PERIODS: PerformancePeriod[] = ["24h", "7d", "30d", "all-time"]

const VENUE_COLORS = {
  total: "#22c55e",
  hyperliquid: "#3b82f6",
  derive: "#f59e0b",
} as const

const UNSUPPORTED = "—"

const formatUsd = (value: number): string =>
  value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  })

const formatPct = (value: number): string => {
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(2)}%`
}

type HoverBreakdown = {
  x: number
  y: number
  timeLabel: string
  rows: { label: string; color: string; dollars: string; percent: string }[]
}

const timedToChartData = (series: readonly TimedValue[]) =>
  series.map(sample => ({
    time: Math.floor(sample.timestamp_ms / 1000) as Time,
    value: sample.value,
  }))

const lastTimedValue = (series: readonly TimedValue[]): number | null => {
  let last: TimedValue | undefined
  for (const sample of series) {
    last = sample
  }
  return last === undefined ? null : last.value
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
  const [period, setPeriod] = createSignal<PerformancePeriod>("30d")
  const [scaleMode, setScaleMode] = createSignal<ChartScaleMode>("percent")
  const [includeHyperliquid, setIncludeHyperliquid] = createSignal(true)
  const [includeDerive, setIncludeDerive] = createSignal(true)
  const [hoverBreakdown, setHoverBreakdown] =
    createSignal<HoverBreakdown | null>(null)

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

  const prepared = createMemo(() => {
    const selectedPeriod = period()
    return (performanceQuery.data ?? []).map(series => {
      const { equity, events } = prepareVenueEquity(series, selectedPeriod)
      return {
        venue: series.venue,
        equity,
        events,
        dollars: dollarSeries(equity),
        percent: twrPercentSeries(equity, events),
      }
    })
  })

  const totalPrepared = createMemo(() => {
    const venues = prepared()
    if (venues.length === 0) {
      return {
        equity: [] as ReturnType<typeof forwardFillMergeEquity>,
        events: [],
        dollars: [] as TimedValue[],
        percent: [] as TimedValue[],
        drawdown: [] as TimedValue[],
      }
    }
    const asSeries: VenuePerformanceSeries[] = venues.map(venue => ({
      venue: venue.venue,
      equity_points: venue.equity,
      events: venue.events,
      fetched_at: new Date().toISOString(),
      coverage_start_ms: null,
      coverage_end_ms: null,
    }))
    const equity = forwardFillMergeEquity(asSeries)
    const events = venues
      .flatMap(venue => venue.events)
      .sort((left, right) => left.timestamp_ms - right.timestamp_ms)
    return {
      equity,
      events,
      dollars: dollarSeries(equity),
      percent: twrPercentSeries(equity, events),
      drawdown: underwaterDrawdownSeries(equity, events),
    }
  })

  const endingDollars = createMemo(() =>
    lastTimedValue(totalPrepared().dollars),
  )
  const endingPercent = createMemo(() =>
    lastTimedValue(totalPrepared().percent),
  )

  // Imperative chart: series and panes must sync to Solid signals via createEffect.
  createEffect(() => {
    const host = chartHost
    if (host === undefined) return

    const isLoading = performanceQuery.isLoading
    const error = performanceQuery.error
    const enabled = performanceQuery.isEnabled
    const mode = scaleMode()
    const venues = prepared()
    const total = totalPrepared()

    if (chartApi !== undefined) {
      chartApi.remove()
      chartApi = undefined
    }
    setHoverBreakdown(null)

    if (!enabled || isLoading || error !== null) {
      return
    }

    const mainSeries = mode === "percent" ? total.percent : total.dollars
    if (mainSeries.length === 0) {
      return
    }

    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: { background: { color: "transparent" }, textColor: "#888" },
      grid: { vertLines: { color: "#222" }, horzLines: { color: "#222" } },
      timeScale: { borderColor: "#333", timeVisible: true },
      rightPriceScale: {
        borderColor: "#333",
        scaleMargins: { top: 0.08, bottom: 0.35 },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { labelVisible: true },
        horzLine: { labelVisible: true },
      },
    })
    chartApi = chart

    const priceRange = equityPriceScaleRange(
      mainSeries.map(sample => sample.value),
    )
    const totalLine = chart.addSeries(LineSeries, {
      color: VENUE_COLORS.total,
      lineWidth: 2,
      title: "Total",
      priceLineVisible: mode === "percent",
      lastValueVisible: true,
      autoscaleInfoProvider: () =>
        priceRange === null ? null : { priceRange },
    })
    totalLine.setData(timedToChartData(mainSeries))

    if (mode === "percent") {
      totalLine.createPriceLine({
        price: 0,
        color: "#64748b",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "0%",
      })
    }

    const venueSeriesApis: {
      venue: string
      api: ISeriesApi<"Line">
      dollars: TimedValue[]
      percent: TimedValue[]
    }[] = []

    for (const venue of venues) {
      const color =
        venue.venue === "hyperliquid"
          ? VENUE_COLORS.hyperliquid
          : VENUE_COLORS.derive
      const data = mode === "percent" ? venue.percent : venue.dollars
      if (data.length === 0) continue
      const line = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        title: venue.venue === "hyperliquid" ? "HL" : "Derive",
        lastValueVisible: true,
      })
      line.setData(timedToChartData(data))
      venueSeriesApis.push({
        venue: venue.venue,
        api: line,
        dollars: venue.dollars,
        percent: venue.percent,
      })
    }

    const drawdownPane = chart.addSeries(AreaSeries, {
      lineColor: "#ef4444",
      topColor: "rgba(239, 68, 68, 0.05)",
      bottomColor: "rgba(239, 68, 68, 0.45)",
      lineWidth: 1,
      priceScaleId: "drawdown",
      title: "Drawdown",
    })
    chart.priceScale("drawdown").applyOptions({
      scaleMargins: { top: 0.72, bottom: 0.02 },
      borderVisible: false,
    })
    drawdownPane.setData(timedToChartData(total.drawdown))
    drawdownPane.createPriceLine({
      price: 0,
      color: "#64748b",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    })

    chart.timeScale().fitContent()

    const lookupAtTime = (
      series: readonly TimedValue[],
      timestampMs: number,
    ): number | null => {
      let match: TimedValue | undefined
      for (const sample of series) {
        if (sample.timestamp_ms <= timestampMs) {
          match = sample
        } else {
          break
        }
      }
      return match === undefined ? null : match.value
    }

    const onCrosshairMove = (param: MouseEventParams) => {
      if (
        param.point === undefined ||
        param.time === undefined ||
        param.point.x < 0 ||
        param.point.y < 0
      ) {
        setHoverBreakdown(null)
        return
      }
      const timeSeconds =
        typeof param.time === "number" ? param.time : Number(param.time)
      if (!Number.isFinite(timeSeconds)) {
        setHoverBreakdown(null)
        return
      }
      const timestampMs = timeSeconds * 1000
      const rows: HoverBreakdown["rows"] = []
      const totalDollars = lookupAtTime(total.dollars, timestampMs)
      const totalPercent = lookupAtTime(total.percent, timestampMs)
      if (totalDollars !== null && totalPercent !== null) {
        rows.push({
          label: "Total",
          color: VENUE_COLORS.total,
          dollars: formatUsd(totalDollars),
          percent: formatPct(totalPercent),
        })
      }
      for (const venue of venueSeriesApis) {
        const dollars = lookupAtTime(venue.dollars, timestampMs)
        const percent = lookupAtTime(venue.percent, timestampMs)
        if (dollars === null || percent === null) continue
        rows.push({
          label: venue.venue === "hyperliquid" ? "HL" : "Derive",
          color:
            venue.venue === "hyperliquid"
              ? VENUE_COLORS.hyperliquid
              : VENUE_COLORS.derive,
          dollars: formatUsd(dollars),
          percent: formatPct(percent),
        })
      }
      if (rows.length === 0) {
        setHoverBreakdown(null)
        return
      }
      setHoverBreakdown({
        x: param.point.x,
        y: param.point.y,
        timeLabel: new Date(timestampMs).toLocaleString(),
        rows,
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
      setHoverBreakdown(null)
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
            <span class="font-mono text-right">
              {(() => {
                const dollars = endingDollars()
                const percent = endingPercent()
                if (dollars === null || percent === null) return UNSUPPORTED
                return `${formatUsd(dollars)} (${formatPct(percent)})`
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
          <div class="flex items-center justify-between shrink-0 px-1 gap-2">
            <div class="flex gap-1 text-[9px]">
              <button
                type="button"
                class={`px-1.5 py-0.5 rounded ${
                  scaleMode() === "percent"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
                onClick={() => {
                  setScaleMode("percent")
                }}
              >
                %
              </button>
              <button
                type="button"
                class={`px-1.5 py-0.5 rounded ${
                  scaleMode() === "dollars"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
                onClick={() => {
                  setScaleMode("dollars")
                }}
              >
                $
              </button>
            </div>
            <div class="flex items-center gap-2 text-[9px] text-muted-foreground">
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
              <select
                class="bg-transparent border border-border/40 rounded px-1 py-0.5 text-foreground"
                value={period()}
                onChange={event => {
                  setPeriod(event.currentTarget.value as PerformancePeriod)
                }}
              >
                <For each={PERIODS}>
                  {option => <option value={option}>{option}</option>}
                </For>
              </select>
            </div>
          </div>

          <div class="relative flex-1 min-h-0">
            <div ref={chartHost} class="absolute inset-0" />
            <Show when={hoverBreakdown()}>
              {label => (
                <div
                  class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded bg-background/95 px-2 py-1 text-[10px] text-foreground shadow border border-border/60 min-w-[140px]"
                  style={{
                    left: `${label().x}px`,
                    top: `${Math.max(label().y - 8, 4)}px`,
                  }}
                >
                  <div class="text-muted-foreground mb-0.5">
                    {label().timeLabel}
                  </div>
                  <For each={label().rows}>
                    {row => (
                      <div class="flex justify-between gap-2 font-mono">
                        <span style={{ color: row.color }}>{row.label}</span>
                        <span>
                          {row.dollars} ({row.percent})
                        </span>
                      </div>
                    )}
                  </For>
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
                totalPrepared().dollars.length === 0
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

// Re-export merge helpers used by older tests / callers.
export {
  forwardFillMergeEquity as mergeEquitySeries,
  chartableEquityPoints,
  equityPriceScaleRange,
} from "./performanceSeries"
