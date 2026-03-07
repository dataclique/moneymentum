import { For } from "solid-js"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

interface FactorExposure {
  name: string
  value: number
}

interface FactorAttribution {
  factor: string
  contribution: number
}

interface ConcentrationMetric {
  metric: string
  value: number
}

const mockExposures: FactorExposure[] = [
  { name: "β to BTC", value: 0.85 },
  { name: "β to SPY", value: 0.42 },
  { name: "Momentum", value: 0.28 },
  { name: "Carry", value: -0.15 },
  { name: "Volatility", value: 0.12 },
]

const mockAttribution: FactorAttribution[] = [
  { factor: "β to BTC", contribution: 0.156 },
  { factor: "β to SPY", contribution: 0.042 },
  { factor: "Momentum", contribution: 0.098 },
  { factor: "Carry", contribution: -0.023 },
  { factor: "Volatility", contribution: 0.025 },
  { factor: "Idiosyncratic", contribution: 0.044 },
]

const mockConcentration: ConcentrationMetric[] = [
  { metric: "Top Position", value: 0.23 },
  { metric: "Top 3 Positions", value: 0.46 },
  { metric: "Top 5 Positions", value: 0.59 },
  { metric: "Herfindahl Index", value: 0.12 },
  { metric: "Effective Positions", value: 8.3 },
]

export const FactorsPanel = () => {
  return (
    <div class="shrink-0 border border-border rounded flex flex-col min-w-0 relative">
      <div class="px-2 py-1 border-b border-border bg-muted/30 font-medium flex items-center justify-between">
        <span>FACTORS</span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground"
            title="Configure factors (f)"
          >
            {/* TODO: factor config button */}
          </button>
          <kbd class="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
            f
          </kbd>
        </div>
      </div>
      <div class="flex-1 flex flex-col p-2 gap-3 overflow-auto scrollbar-hide">
        {/* Exposures */}
        <div class="space-y-1.5">
          <div class="text-[10px] text-muted-foreground font-medium">
            Exposures
          </div>
          <For each={mockExposures}>
            {exposure => (
              <div class="flex items-center justify-between">
                <span class="text-muted-foreground truncate">
                  {exposure.name}
                </span>
                <span class="font-mono">
                  {exposure.value >= 0 ? "+" : ""}
                  {exposure.value.toFixed(2)}
                </span>
              </div>
            )}
          </For>
        </div>

        {/* Attribution */}
        <div class="border-t border-border/50 pt-2">
          <div class="text-[10px] text-muted-foreground font-medium mb-1.5">
            Attribution
          </div>
          <For each={mockAttribution}>
            {attribution => (
              <div class="flex items-center justify-between mb-1">
                <span class="text-muted-foreground truncate">
                  {attribution.factor}
                </span>
                <span
                  class={twMerge(
                    clsx(
                      "w-14 text-right font-mono",
                      attribution.contribution >= 0
                        ? "text-green-500"
                        : "text-red-500",
                    ),
                  )}
                >
                  {attribution.contribution >= 0 ? "+" : ""}
                  {(attribution.contribution * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </For>
        </div>

        {/* Concentration */}
        <div class="border-t border-border/50 pt-2">
          <div class="text-[10px] text-muted-foreground font-medium mb-1.5">
            Concentration
          </div>
          <div class="space-y-1">
            <For each={mockConcentration}>
              {metric => (
                <div class="flex items-center justify-between">
                  <span class="text-muted-foreground">{metric.metric}</span>
                  <span class="font-mono">
                    {metric.value <= 1
                      ? `${(metric.value * 100).toFixed(0)}%`
                      : metric.value.toFixed(1)}
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
