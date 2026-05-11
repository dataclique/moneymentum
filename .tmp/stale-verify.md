# Stale Issue Verification Report

### #91 — Cannot fully close portfolio due to 100% weights validation

References: frontend/src/pages/Portfolio/hooks/usePortfolioState.ts, the weight
validation in hasTotalPercentBelow() (lines 773-774) Verdict: STILL VALID — the
validation blocks all-zero weights without special case Reason:
hasTotalPercentBelow() checks if derivedTotalPercent() < 100 - tolerance and
blocks submission; no exception for closing positions.

### #138 — Decide what to do with dead code on frontend

References: frontend/src/main.tsx routes; both "/" and "/prototype" are present
(lines 39, 42) Verdict: STALE — both routes are actively used and maintained
Reason: /prototype is defined at line 39-41 with PrototypePage, / at lines 42-46
with PortfolioPage; neither is dead code.

### #141 — Leverage panel crashes when leverage limits are not yet loaded

References: frontend/src/pages/Portfolio/components/PositionsPanel.tsx line 140,
sliderMaxLeverage() defaults to 1 Verdict: STALE — no crash occurs; UI
gracefully defaults to 1x leverage until limits load Reason: Line 140 has safe
fallback: typeof check returns 1 if maxLeverage undefined; no null-dref
possible.

### #147 — PositionsPanel status + leverage reactivity

References: frontend/src/pages/Portfolio/components/PositionsPanel.tsx status
usage; usePortfolioState.ts leverage limits derivation Verdict: STALE — the
exact TODOs cited (lines 112-113, 158) are gone; current status only has
idle/untouched/deleted/modified Reason: Status enum is now clean
(usePortfolioState line 22-27), no "changed/unchanged/new/closing" values;
leverage is accessed safely with map check.

### #149 — usePortfolioState refactor + non-precise mode

References: frontend/src/pages/Portfolio/hooks/usePortfolioState.ts line numbers
from issue (20, 40, 269, 324, 443, 520) Verdict: STALE — no TODO comments at
those lines; file has been refactored Reason: Inspecting the cited lines shows
no TODO comments; file structure has changed since March 2026 issue creation.

### #150 — hyperliquid-client order request typing + leverage action

References: frontend/src/services/hyperliquid-client.ts lines 197, 460 Verdict:
UNCLEAR — cannot verify exact line numbers as file is substantially different
Reason: hyperliquid-client.ts lacks createOrdersWs method and the line numbers
do not align; either refactored or moved to different file.

### #151 — MIN_USD filtering in portfolioRebalancer diff

References: portfolioRebalancer.ts which does not exist in current codebase
Verdict: STALE — portfolioRebalancer.ts file does not exist Reason: No
portfolioRebalancer file found; MIN_USD filtering logic likely moved into
usePortfolioState.

### #152 — PerformancePanel metrics + chart

References: frontend/src/pages/Portfolio/components/PerformancePanel.tsx lines
42-83, 88 Verdict: STILL VALID — all metric values are still "TODO" strings and
chart is placeholder Reason: Lines 42-83 show all metrics as "TODO" string
literal, line 88 shows "TODO: performance chart".

### #153 — ScreenerPanel funding rates loading/processing

References: frontend/src/pages/Portfolio/components/ScreenerPanel.tsx line 8, 65
Verdict: STALE — no TODO comments found in those lines Reason: ScreenerPanel.tsx
line 8 is fundingRatesByBaseSymbol param (no TODO); funding is computed cleanly
at lines 79-84.

### #154 — RiskPanel placeholders + Monte Carlo wiring

References: frontend/src/pages/Portfolio/components/RiskPanel.tsx
mockRiskMetrics, mockStressTests, lines 116, 139 Verdict: STILL VALID — all
metrics are "TODO" strings, Monte Carlo and Correlation sections label as TODO
Reason: Lines 3-14 show mockRiskMetrics/mockStressTests with "TODO" values;
lines 116 and 139 have "TODO" in labels.

### #155 — Prototype RiskTab Monte Carlo wiring + percentiles

References: frontend/src/pages/Prototype/components/RiskTab.tsx lines 281, 297,
335 Verdict: STILL VALID — Monte Carlo controls are disabled with TODO comments,
percentiles are hardcoded Reason: Line 281-283 has TODO and disabled select,
line 297 has TODO, line 335 has TODO; percentiles at lines 339/343 are hardcoded
(-22.5%, +8.2%).

### #156 — Refactor LeverageDialog: new design + apply/cancel + accessibility

References: frontend/src/pages/Portfolio/components/PositionsPanel.tsx lines
150-188 (inline leverage dialog) Verdict: STILL VALID — dialog changes leverage
immediately; no Apply/Cancel workflow, no focus trap, no aria-dialog Reason:
Line 177-178 calls onLeverageChange on every slider change; no separate Apply
button; no accessibility (role, aria-modal, focus trap).

### #157 — Review useBeta: optimize beta requests by reusing totalNotional

References: frontend/src/pages/Portfolio/hooks/useBeta.ts weightsFromTokens
function (line 11-40) Verdict: STILL VALID — useBeta recomputes normalized
weights instead of accepting totalNotional Reason: weightsFromTokens still
computes weights from token array without taking totalNotional; does not reuse
computed notionals from usePortfolioState.
