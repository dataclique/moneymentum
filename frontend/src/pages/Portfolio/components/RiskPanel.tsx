import { For, Match, Show, Switch } from "solid-js"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  RiskMeasurementContract,
  RiskReport,
  RiskResult,
} from "../hooks/useRisk"

const mockStressTests = [
  { scenario: "BTC -20%", portfolioImpact: "TODO" },
  { scenario: "SPX -10%", portfolioImpact: "TODO" },
  { scenario: "Rates +200bps", portfolioImpact: "TODO" },
]

const formatPercent = (fraction: number): string =>
  `${(fraction * 100).toFixed(1)}%`

const formatConfidence = (confidenceLevel: number): string =>
  `${Math.round(confidenceLevel * 100)}%`

const describeContract = (contract: RiskMeasurementContract): string => {
  const window =
    contract.window.lookbackDays !== undefined
      ? `${contract.window.lookbackDays}d`
      : `${contract.window.startDate ?? "?"} → ${contract.window.endDate ?? "?"}`

  return `${window} · ${contract.samplingFrequency}`
}

const getCorrelationColor = (value: number): string => {
  if (value >= 0.75) return "bg-emerald-500/70 text-emerald-50"
  if (value >= 0.5) return "bg-emerald-500/40 text-emerald-50"
  if (value >= 0.25) return "bg-emerald-500/20 text-emerald-900"
  if (value <= -0.75) return "bg-red-500/70 text-red-50"
  if (value <= -0.5) return "bg-red-500/40 text-red-50"
  if (value <= -0.25) return "bg-red-500/20 text-red-900"
  return "bg-muted text-foreground"
}

const RiskMetrics = (props: { report: RiskReport }) => (
  <>
    {/* Tail risk at each contract confidence level */}
    <table class="w-full">
      <thead>
        <tr>
          <th class="p-0.5 text-[10px] text-muted-foreground font-medium text-left">
            Level
          </th>
          <th class="p-0.5 text-[10px] text-muted-foreground font-medium text-right">
            VaR
          </th>
          <th class="p-0.5 text-[10px] text-muted-foreground font-medium text-right">
            CVaR
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={props.report.tailRisk}>
          {tailRisk => (
            <tr>
              <td class="p-0.5 text-muted-foreground">
                {formatConfidence(tailRisk.confidenceLevel)}
              </td>
              <td class="p-0.5 text-right text-red-400 font-mono">
                {formatPercent(tailRisk.var)}
              </td>
              <td class="p-0.5 text-right text-red-400 font-mono">
                {formatPercent(tailRisk.cvar)}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>

    {/* Drawdown and diversification */}
    <div class="border-t border-border/50 pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
      <div class="flex justify-between">
        <span class="text-muted-foreground">Max DD</span>
        <span class="text-red-400 font-mono">
          {formatPercent(props.report.drawdown.maxDrawdown)}
        </span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">DD Length</span>
        <span class="font-mono">
          {props.report.drawdown.peakToTroughPeriods}p
        </span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">Bets</span>
        <span class="font-mono">
          {props.report.effectiveBets.meucci.toFixed(2)}
        </span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">Bets (stress)</span>
        <span class="font-mono">
          {props.report.effectiveBets.stressedMeucci.toFixed(2)}
        </span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">1/HHI</span>
        <span class="font-mono">
          {props.report.effectiveBets.inverseHerfindahl.toFixed(2)}
        </span>
      </div>
    </div>

    {/* Correlation heatmap (Ledoit-Wolf shrunk) */}
    <div class="border-t border-border/50 pt-2">
      <div class="text-[10px] text-muted-foreground font-medium mb-1.5">
        Correlation (shrunk{" "}
        {formatPercent(props.report.correlation.shrinkageIntensity)})
      </div>
      <table class="w-full">
        <thead>
          <tr>
            <th class="p-0.5" />
            <For each={props.report.correlation.tickers}>
              {columnTicker => (
                <th class="p-0.5 text-[10px] text-muted-foreground font-medium text-center">
                  {columnTicker}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.report.correlation.matrix}>
            {(matrixRow, rowIndex) => (
              <tr>
                <td class="p-0.5 text-[10px] text-muted-foreground font-medium">
                  {props.report.correlation.tickers[rowIndex()]}
                </td>
                <For each={matrixRow}>
                  {(correlation, columnIndex) => (
                    <td class="p-0.5 text-center">
                      <div
                        class={`w-full h-4 flex items-center justify-center rounded text-[9px] font-mono ${getCorrelationColor(
                          correlation,
                        )} ${rowIndex() === columnIndex() ? "opacity-40" : ""}`}
                      >
                        {correlation.toFixed(1)}
                      </div>
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </>
)

export const RiskPanel = (props: { risk: RiskResult }) => {
  return (
    <div class="flex-1 border border-border rounded flex flex-col min-w-0">
      <div class="px-2 py-1 border-b border-border bg-muted/30 font-medium flex items-center justify-between">
        <span>RISK</span>
        <Show when={props.risk.report}>
          {report => (
            <span class="text-[10px] text-muted-foreground font-normal">
              {describeContract(report().contract)}
            </span>
          )}
        </Show>
      </div>
      <div class="flex-1 flex flex-col p-2 gap-3 overflow-auto scrollbar-hide">
        <Switch>
          <Match when={props.risk.isLoading}>
            <div class="space-y-2" data-testid="risk-loading">
              <Skeleton class="h-4 w-full" />
              <Skeleton class="h-4 w-3/4" />
              <Skeleton class="h-4 w-5/6" />
            </div>
          </Match>
          <Match when={props.risk.error}>
            {error => (
              <div class="text-red-400" data-testid="risk-error">
                Risk metrics unavailable: {error().message}
              </div>
            )}
          </Match>
          <Match when={props.risk.report}>
            {report => <RiskMetrics report={report()} />}
          </Match>
          <Match when={true}>
            <div class="text-muted-foreground">
              Add positions to see risk metrics
            </div>
          </Match>
        </Switch>

        {/* Stress tests (not implemented in the backend yet) */}
        <div class="border-t border-border/50 pt-2">
          <div class="text-[10px] text-muted-foreground font-medium mb-1.5">
            Stress Tests TODO
          </div>
          <div class="space-y-1">
            <For each={mockStressTests}>
              {stressTest => (
                <div class="flex items-center justify-between">
                  <span class="text-muted-foreground truncate">
                    {stressTest.scenario}
                  </span>
                  <span class="text-foreground font-mono">
                    {stressTest.portfolioImpact}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}
