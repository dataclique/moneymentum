import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"

import {
  cashFlowEventsFromDeriveHistory,
  equityPointsFromDeriveValueHistory,
} from "./performance"

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

describe("cashFlowEventsFromDeriveHistory", () => {
  it("keeps settled usd deposits and skips pending or non-usd", async () => {
    const events = await Effect.runPromise(
      cashFlowEventsFromDeriveHistory("deposit", [
        {
          amount: "100",
          asset: "USDC",
          timestamp: 1_700_000_000_000,
          tx_hash: "0xabc",
          tx_status: "settled",
        },
        {
          amount: "50",
          asset: "USDC",
          timestamp: 1_700_000_100_000,
          tx_hash: "0xdef",
          tx_status: "pending",
        },
        {
          amount: "2",
          asset: "ETH",
          timestamp: 1_700_000_200_000,
          tx_hash: "0xeth",
          tx_status: "settled",
        },
      ]),
    )
    expect(events).toEqual([
      {
        kind: "deposit",
        timestamp_ms: 1_700_000_000_000,
        amount_usd: "100",
        source_id: "0xabc",
      },
    ])
  })
})
