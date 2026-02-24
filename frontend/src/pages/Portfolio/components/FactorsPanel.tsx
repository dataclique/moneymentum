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

const totalAttribution = mockAttribution.reduce(
  (sum, f) => sum + Math.abs(f.contribution),
  0,
)

export const FactorsPanel = () => {
  return (
    <div className="shrink-0 border border-border rounded flex flex-col min-w-0 relative">
      <div className="px-2 py-1 border-b border-border bg-muted/30 font-medium flex items-center justify-between">
        <span>FACTORS</span>
        <div className="flex items-center gap-2">
          <button
            className="text-muted-foreground hover:text-foreground"
            title="Configure factors (f)"
          >
            {/* TODO: factor config button */}
          </button>
          <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">
            f
          </kbd>
        </div>
      </div>
      <div className="flex-1 flex flex-col p-2 gap-3 overflow-auto scrollbar-hide">
        {/* Exposures */}
        <div className="space-y-1.5">
          <div className="text-[10px] text-muted-foreground font-medium">
            Exposures
          </div>
          {mockExposures.map(f => (
            <div key={f.name} className="flex items-center justify-between">
              <span className="text-muted-foreground truncate">{f.name}</span>
              <span className="font-mono">
                {f.value >= 0 ? "+" : ""}
                {f.value.toFixed(2)}
              </span>
            </div>
          ))}
        </div>

        {/* Attribution */}
        <div className="border-t border-border/50 pt-2">
          <div className="text-[10px] text-muted-foreground font-medium mb-1.5">
            Attribution
          </div>
          {mockAttribution.map(f => (
            <div
              key={f.factor}
              className="flex items-center justify-between mb-1"
            >
              <span className="text-muted-foreground truncate">{f.factor}</span>
              <span
                className={twMerge(
                  clsx(
                    "w-14 text-right font-mono",
                    f.contribution >= 0 ? "text-green-500" : "text-red-500",
                  ),
                )}
              >
                {f.contribution >= 0 ? "+" : ""}
                {(f.contribution * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>

        {/* Concentration */}
        <div className="border-t border-border/50 pt-2">
          <div className="text-[10px] text-muted-foreground font-medium mb-1.5">
            Concentration
          </div>
          <div className="space-y-1">
            {mockConcentration.map(m => (
              <div key={m.metric} className="flex items-center justify-between">
                <span className="text-muted-foreground">{m.metric}</span>
                <span className="font-mono">
                  {m.value <= 1
                    ? `${(m.value * 100).toFixed(0)}%`
                    : m.value.toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
