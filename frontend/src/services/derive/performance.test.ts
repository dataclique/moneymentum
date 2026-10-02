import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"

import { equityPointsFromDeriveValueHistory } from "./performance"

describe("equityPointsFromDeriveValueHistory", () => {
  it("converts second timestamps to milliseconds and sorts", async () => {
    const points = await Effect.runPromise(
      equityPointsFromDeriveValueHistory([
        { timestamp: 2_000, subaccount_value: "20" },
        { timestamp: 1_000, subaccount_value: "10.5" },
      ]),
    )
    expect(points).toEqual([
      { timestamp_ms: 1_000_000, value_usd: "10.5" },
      { timestamp_ms: 2_000_000, value_usd: "20" },
    ])
  })

  it("rejects missing values", async () => {
    const exit = await Effect.runPromiseExit(
      equityPointsFromDeriveValueHistory([{ timestamp: 1_000 }]),
    )
    expect(exit._tag).toBe("Failure")
  })
})
