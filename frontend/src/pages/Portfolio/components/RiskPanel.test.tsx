import { describe, expect, it } from "vitest"
import { render, screen } from "@solidjs/testing-library"

import { RiskPanel } from "./RiskPanel"
import type { RiskReport, RiskResult } from "../hooks/useRisk"

const riskReport: RiskReport = {
  contract: {
    window: { lookbackDays: 90 },
    samplingFrequency: "daily",
    confidenceLevels: [0.9, 0.95, 0.99],
  },
  tailRisk: [
    { confidenceLevel: 0.9, var: 0.021, cvar: 0.034 },
    { confidenceLevel: 0.95, var: 0.029, cvar: 0.041 },
    { confidenceLevel: 0.99, var: 0.052, cvar: 0.052 },
  ],
  drawdown: { maxDrawdown: 0.18, peakToTroughPeriods: 12 },
  correlation: {
    tickers: ["BTC", "ETH"],
    matrix: [
      [1, 0.82],
      [0.82, 1],
    ],
    shrinkageIntensity: 0.07,
  },
  effectiveBets: {
    meucci: 1.4,
    stressedMeucci: 1.1,
    inverseHerfindahl: 1.92,
  },
}

const riskResultWith = (overrides: Partial<RiskResult>): RiskResult => ({
  report: null,
  isLoading: false,
  error: null,
  ...overrides,
})

describe("RiskPanel", () => {
  it("shows every shipped metric and the measurement contract", () => {
    render(() => <RiskPanel risk={riskResultWith({ report: riskReport })} />)

    // The contract baseline is visible alongside the metrics.
    expect(screen.getByText("90d · daily")).toBeInTheDocument()

    // VaR/CVaR at each configured confidence level.
    expect(screen.getByText("90%")).toBeInTheDocument()
    expect(screen.getByText("95%")).toBeInTheDocument()
    expect(screen.getByText("99%")).toBeInTheDocument()
    expect(screen.getByText("2.1%")).toBeInTheDocument()
    expect(screen.getByText("3.4%")).toBeInTheDocument()
    expect(screen.getByText("2.9%")).toBeInTheDocument()
    expect(screen.getByText("4.1%")).toBeInTheDocument()

    // Drawdown depth and length.
    expect(screen.getByText("18.0%")).toBeInTheDocument()
    expect(screen.getByText("12p")).toBeInTheDocument()

    // Effective number of bets with its stressed and 1/HHI companions.
    expect(screen.getByText("1.40")).toBeInTheDocument()
    expect(screen.getByText("1.10")).toBeInTheDocument()
    expect(screen.getByText("1.92")).toBeInTheDocument()

    // Correlation heatmap over the held tickers, labelled as shrunk.
    expect(screen.getByText("Correlation (shrunk 7.0%)")).toBeInTheDocument()
    expect(screen.getAllByText("BTC")).toHaveLength(2)
    expect(screen.getAllByText("ETH")).toHaveLength(2)
    expect(screen.getAllByText("0.8")).toHaveLength(2)
  })

  it("shows a loading state while the risk query is in flight", () => {
    render(() => <RiskPanel risk={riskResultWith({ isLoading: true })} />)

    expect(screen.getByTestId("risk-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("risk-error")).not.toBeInTheDocument()
  })

  it("shows the failure reason when the risk query errors", () => {
    render(() => (
      <RiskPanel
        risk={riskResultWith({
          error: new Error("no candle data for DOGE in the measurement window"),
        })}
      />
    ))

    expect(screen.getByTestId("risk-error")).toHaveTextContent(
      "Risk metrics unavailable: no candle data for DOGE in the measurement window",
    )
  })

  it("prompts for positions when there is nothing to measure", () => {
    render(() => <RiskPanel risk={riskResultWith({})} />)

    expect(
      screen.getByText("Add positions to see risk metrics"),
    ).toBeInTheDocument()
  })
})
