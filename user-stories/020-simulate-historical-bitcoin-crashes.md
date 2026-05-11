---
status: planned
theme: crash-protection-and-simulation
---

# Simulate Historical Bitcoin Crashes

As a user, I want to simulate historical Bitcoin crashes so that I can see how
my portfolio and protective puts might behave in black swan scenarios.

## Acceptance Criteria

- [ ] The user can choose a historical Bitcoin crash scenario.
- [ ] The simulation applies the Bitcoin price move to the portfolio.
- [ ] Spot, perp, and manually entered put positions are included.
- [ ] The output shows projected portfolio value before and after the scenario.
- [ ] The output shows whether protective puts offset the drawdown.
- [ ] Protective puts are valued at intrinsic value only:
      `max(0, strike - scenarioPrice) * quantity * contractSize`, where
      `scenarioPrice` is the scenario end price at the scenario valuation
      timestamp. Time value and scenario volatility are excluded so the
      simulation is deterministic and reproducible. Put values are added to spot
      and perp position values when computing pre- and post-scenario portfolio
      value.
