import { afterEach, describe, expect, it, vi } from "vitest"
import * as Effect from "effect/Effect"

import { getErrorMessage } from "@/lib/error-message"
import { HttpStatusError } from "@/lib/http"
import { syncDerivePerformanceToCache } from "./performance"
import type { DeriveSessionCredentials } from "./session"

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({
    signMessage: async () => "0xtest-signature",
  }),
}))

const testSession: DeriveSessionCredentials = {
  deriveWallet: "0x1111111111111111111111111111111111111111",
  sessionAddress: "0x2222222222222222222222222222222222222222",
  sessionPrivateKey: "0x00",
  networkMode: "testnet",
  subaccountId: 42,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("syncDerivePerformanceToCache", () => {
  it("keeps cache rejection distinct from a Derive RPC failure", async () => {
    const observedAtSeconds = Math.floor(Date.now() / 1000) - 3600
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async requestTarget => {
        const url =
          typeof requestTarget === "string"
            ? requestTarget
            : requestTarget instanceof URL
              ? requestTarget.href
              : requestTarget.url

        switch (url) {
          case "/derive-api-demo/private/get_subaccount_value_history":
            return Response.json({
              result: {
                subaccount_value_history: [
                  {
                    timestamp: observedAtSeconds,
                    subaccount_value: "100.25",
                  },
                ],
              },
            })
          case "/derive-api-demo/private/get_deposit_history":
          case "/derive-api-demo/private/get_withdrawal_history":
            return Response.json({ result: { events: [] } })
          case `/api/performance/${testSession.deriveWallet}/derive`:
            return new Response("invalid equity history", { status: 422 })
          default:
            return expect.fail(`Unexpected request: ${url}`)
        }
      })
    vi.stubGlobal("fetch", fetch)
    const controller = new AbortController()

    const failure = await Effect.runPromise(
      Effect.flip(syncDerivePerformanceToCache(testSession, controller.signal)),
    )

    expect(failure).toBeInstanceOf(HttpStatusError)
    expect(failure._tag).toBe("HttpStatusError")
    expect(failure).toMatchObject({
      status: 422,
      detail: "invalid equity history",
    })
    expect(getErrorMessage(failure)).toBe("invalid equity history")
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/performance/${testSession.deriveWallet}/derive`,
      expect.objectContaining({ method: "PUT", signal: controller.signal }),
    )
  })
})
