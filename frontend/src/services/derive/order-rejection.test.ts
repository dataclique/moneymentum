import { describe, expect, it } from "vitest"

import { isDeriveZeroLiquidityOrderError } from "./trading"

const requestContext: { failure?: unknown } = {}
const circularRejection = { code: "ECONNRESET", request: requestContext }
requestContext.failure = circularRejection

describe("Derive zero-liquidity rejection classification", () => {
  it.each([
    { name: "missing rejection", rejection: undefined },
    { name: "bigint metadata", rejection: { requestId: 1n } },
    { name: "circular request metadata", rejection: circularRejection },
    { name: "opaque symbol", rejection: Symbol("transport failure") },
  ])(
    "keeps $name unclassified rather than replacing the failure",
    ({ rejection }) => {
      expect(isDeriveZeroLiquidityOrderError(rejection)).toBe(false)
    },
  )

  it.each([
    new Error('derive {"error":{"code":"11009"}}'),
    { error: { code: "11009" } },
    "Zero liquidity for market or IOC/FOK order",
  ])("recognizes an existing zero-liquidity rejection shape", rejection => {
    expect(isDeriveZeroLiquidityOrderError(rejection)).toBe(true)
  })

  it("does not mistake request metadata for the exchange rejection", () => {
    expect(
      isDeriveZeroLiquidityOrderError({
        error: { code: "11024" },
        request: { code: "11009" },
      }),
    ).toBe(false)
  })
})
