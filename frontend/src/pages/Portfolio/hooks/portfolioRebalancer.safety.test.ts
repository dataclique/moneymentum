import { afterEach, describe, expect, it, vi } from "vitest"
import * as Effect from "effect/Effect"

import {
  deriveActionsToOrderRequests,
  type OptionPortfolioPosition,
} from "./portfolioRebalancer"

const instrument = "ETH-20260925-1800-P"
const heldOption: OptionPortfolioPosition = {
  kind: "option",
  venue: "derive",
  symbol: instrument,
  side: "buy",
  notional: 100,
  contracts: 0,
  markPrice: 0,
  entryPrice: 0,
}
const emptyTicker = {
  symbol: instrument,
  bid: null,
  ask: null,
  last: null,
  mark: null,
}
const observeConsole = () =>
  (["debug", "info", "warn", "error", "log", "trace"] as const).map(level =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  )

afterEach(() => vi.restoreAllMocks())

describe("Derive rebalance preflight safety", () => {
  it("refuses a meaningful close whose contract amount cannot be determined", () => {
    const consoleSpies = observeConsole()
    const preflight = Effect.runSync(
      Effect.either(
        deriveActionsToOrderRequests(
          [
            {
              kind: "close",
              symbol: instrument,
              side: "buy",
              positionKind: "option",
              venue: "derive",
            },
          ],
          { [instrument]: heldOption },
          { [instrument]: emptyTicker },
        ),
      ),
    )

    expect(preflight._tag).toBe("Left")
    if (preflight._tag === "Left") {
      expect(preflight.left).toMatchObject({
        _tag: "DeriveOrderMappingFailed",
        reason: expect.stringContaining("contract amount"),
      })
    }
    consoleSpies.forEach(consoleSpy => {
      expect(consoleSpy).not.toHaveBeenCalled()
    })
  })

  it.each([
    { side: "buy" as const, signedNotionalDelta: 50 },
    { side: "sell" as const, signedNotionalDelta: -50 },
  ])(
    "refuses a $side expansion priced only from the stored position",
    ({ side, signedNotionalDelta }) => {
      const consoleSpies = observeConsole()
      const preflight = Effect.runSync(
        Effect.either(
          deriveActionsToOrderRequests(
            [
              {
                kind: "rebalance",
                symbol: instrument,
                signedNotionalDelta,
                leverage: 1,
                leverageChanged: false,
                positionKind: "option",
                venue: "derive",
              },
            ],
            {
              [instrument]: {
                ...heldOption,
                side,
                contracts: 2,
                markPrice: 50,
                entryPrice: 45,
              },
            },
            { [instrument]: emptyTicker },
          ),
        ),
      )

      expect(preflight._tag).toBe("Left")
      if (preflight._tag === "Left") {
        expect(preflight.left).toMatchObject({
          _tag: "DeriveOrderMappingFailed",
          reason: expect.stringContaining("No usable Derive price"),
        })
      }
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )
})
