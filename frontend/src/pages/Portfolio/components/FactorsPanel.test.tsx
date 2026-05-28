import { describe, expect, it } from "vitest"
import { render, screen } from "@solidjs/testing-library"

import { FactorsPanel } from "./FactorsPanel"

describe("FactorsPanel", () => {
  it("warns when beta data is stale", () => {
    render(() => (
      <FactorsPanel
        beta={0.59}
        isBetaLoading={false}
        betaError={null}
        excludedBetaSymbols={[]}
        betaDataAgeHours={26}
        isBetaDataStale={true}
        betaMethodology={{
          benchmark: "BTC perpetual on Hyperliquid",
          interval: "daily log returns",
          lookback: "365 calendar days",
        }}
      />
    ))

    expect(screen.getByText("Beta data is 26h old")).toBeInTheDocument()
  })
})
