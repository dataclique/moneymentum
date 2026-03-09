import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { Skeleton } from "@/components/ui/skeleton"

interface FactorExposure {
  name: string
  value: string // should be a number or decimal in future
}

interface FactorAttribution {
  factor: string
  contribution: string // should be a number or decimal in future
}

interface ConcentrationMetric {
  metric: string
  value: string // should be a number or decimal in future
}

const mockExposures: FactorExposure[] = [
  { name: "β to SPY", value: "TODO" },
  { name: "Momentum", value: "TODO" },
  { name: "Carry", value: "TODO" },
  { name: "Volatility", value: "TODO" },
]

const mockAttribution: FactorAttribution[] = [
  { factor: "β to BTC", contribution: "TODO" },
  { factor: "β to SPY", contribution: "TODO" },
  { factor: "Momentum", contribution: "TODO" },
  { factor: "Carry", contribution: "TODO" },
  { factor: "Volatility", contribution: "TODO" },
  { factor: "Idiosyncratic", contribution: "TODO" },
]

const mockConcentration: ConcentrationMetric[] = [
  { metric: "Top Position", value: "TODO" },
  { metric: "Top 3 Positions", value: "TODO" },
  { metric: "Top 5 Positions", value: "TODO" },
  { metric: "Herfindahl Index", value: "TODO" },
  { metric: "Effective Positions", value: "TODO" },
]

interface FactorsPanelProps {
  beta: number | null
  isBetaLoading: boolean
}

export const FactorsPanel = ({ beta, isBetaLoading }: FactorsPanelProps) => {
  return (
    <div className="shrink-0 border border-border rounded flex flex-col min-w-[25%] relative">
      <div className="px-2 py-1 border-b border-border bg-muted/30 font-medium flex items-center justify-between">
        <span>FACTORS</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
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
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground truncate">β to BTC</span>
            <span className="font-mono">
              {isBetaLoading ? (
                <Skeleton className="inline-block h-3 w-10 align-middle" />
              ) : beta !== null ? (
                <span
                  className={twMerge(
                    clsx(
                      beta > 0 && "text-green-500",
                      beta < 0 && "text-red-500",
                    ),
                  )}
                >
                  {beta >= 0 ? "+" : ""}
                  {beta.toFixed(2)}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
          </div>
          {mockExposures.map(exposure => (
            <div
              key={exposure.name}
              className="flex items-center justify-between"
            >
              <span className="text-muted-foreground truncate">
                {exposure.name}
              </span>
              <span className="font-mono">{exposure.value}</span>
            </div>
          ))}
        </div>

        {/* Attribution */}
        <div className="border-t border-border/50 pt-2">
          <div className="text-[10px] text-muted-foreground font-medium mb-1.5">
            Attribution
          </div>
          {mockAttribution.map(attribution => (
            <div
              key={attribution.factor}
              className="flex items-center justify-between mb-1"
            >
              <span className="text-muted-foreground truncate">
                {attribution.factor}
              </span>
              <span className={twMerge(clsx("w-14 text-right font-mono"))}>
                {attribution.contribution}
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
            {mockConcentration.map(metric => (
              <div
                key={metric.metric}
                className="flex items-center justify-between"
              >
                <span className="text-muted-foreground">{metric.metric}</span>
                <span className="font-mono">{metric.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
