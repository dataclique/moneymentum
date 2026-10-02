import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import * as Effect from "effect/Effect"

import {
  HttpStatusError,
  JsonParseError,
  NetworkError,
  type JsonSerializeError,
} from "@/lib/http"
import {
  fetchWalletPerformance,
  refreshHyperliquidPerformance,
  upsertVenuePerformance,
  type VenuePerformanceSeries,
  type WalletPerformanceCache,
} from "./account-performance"

const walletAddress = "0x1111111111111111111111111111111111111111"
const cacheRequest = {
  equity_points: [{ timestamp_ms: 1_700_000_000_000, value_usd: "100.25" }],
  events: [],
  fetched_at: "2023-11-14T22:13:20Z",
  coverage_start_ms: 1_700_000_000_000,
  coverage_end_ms: 1_700_000_000_000,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("performance cache failure contracts", () => {
  it("preserves cache rejection status and detail", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ detail: "invalid equity history" }, { status: 422 }),
      )
    vi.stubGlobal("fetch", fetch)
    const controller = new AbortController()
    const request = upsertVenuePerformance(
      walletAddress,
      "derive",
      cacheRequest,
      controller.signal,
    )

    expectTypeOf(request).toEqualTypeOf<
      Effect.Effect<
        VenuePerformanceSeries,
        NetworkError | HttpStatusError | JsonParseError | JsonSerializeError
      >
    >()
    const failure = await Effect.runPromise(Effect.flip(request))

    expect(failure).toBeInstanceOf(HttpStatusError)
    expect(failure).toMatchObject({
      _tag: "HttpStatusError",
      status: 422,
      detail: "invalid equity history",
    })
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/performance/${walletAddress}/derive`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify(cacheRequest),
        signal: controller.signal,
      }),
    )
  })

  it("preserves the network failure when reading cached history", async () => {
    const cause = new TypeError("Failed to fetch")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause))
    const request = fetchWalletPerformance(walletAddress)

    expectTypeOf(request).toEqualTypeOf<
      Effect.Effect<
        WalletPerformanceCache,
        NetworkError | HttpStatusError | JsonParseError
      >
    >()
    const failure = await Effect.runPromise(Effect.flip(request))

    expect(failure).toBeInstanceOf(NetworkError)
    expect(failure).toMatchObject({ _tag: "NetworkError", cause })
  })

  it("preserves invalid cache JSON as a parsing failure after refresh", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("not JSON", { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const request = refreshHyperliquidPerformance(walletAddress, "testnet")

    expectTypeOf(request).toEqualTypeOf<
      Effect.Effect<
        VenuePerformanceSeries,
        NetworkError | HttpStatusError | JsonParseError | JsonSerializeError
      >
    >()
    const failure = await Effect.runPromise(Effect.flip(request))

    expect(failure).toBeInstanceOf(JsonParseError)
    expect(failure).toMatchObject({
      _tag: "JsonParseError",
      cause: expect.any(SyntaxError),
    })
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/performance/${walletAddress}/hyperliquid/refresh?network=testnet`,
      expect.objectContaining({ method: "POST", body: "{}" }),
    )
  })
})
