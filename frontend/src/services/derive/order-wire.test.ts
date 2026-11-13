import { afterEach, describe, expect, it, vi } from "vitest"
import Derive from "ccxt/derive"
import * as Effect from "effect/Effect"
import { privateKeyToAccount } from "viem/accounts"

import type { DeriveSessionCredentials } from "./session"
import { DeriveTradingClient } from "./trading"

const syntheticPrivateKey = `0x${"0".repeat(63)}1` as const
const session: DeriveSessionCredentials = {
  deriveWallet: "0x1111111111111111111111111111111111111111",
  sessionAddress: privateKeyToAccount(syntheticPrivateKey).address,
  sessionPrivateKey: syntheticPrivateKey,
  networkMode: "testnet",
  subaccountId: 42,
}
const expirySeconds = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
const expiryDate = new Date(expirySeconds * 1000)
  .toISOString()
  .slice(0, 10)
  .replace(/-/g, "")
const instrumentName = `ETH-${expiryDate}-1800-P`
const syntheticOption = {
  instrument_name: instrumentName,
  instrument_type: "option",
  base_currency: "ETH",
  quote_currency: "USD",
  is_active: true,
  amount_step: "0.01",
  tick_size: "0.1",
  minimum_amount: "0.01",
  maximum_amount: "1000",
  maker_fee_rate: "0",
  taker_fee_rate: "0",
  option_details: { expiry: expirySeconds, strike: "1800", option_type: "P" },
  base_asset_address: "0x3333333333333333333333333333333333333333",
  base_asset_sub_id: "39614108744922863198558842368",
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Derive order wire contract through the pinned CCXT implementation", () => {
  it.each([
    { intent: "long reduction", side: "sell", reduceOnly: true },
    { intent: "short reduction", side: "buy", reduceOnly: true },
    { intent: "nonreducing order", side: "buy", reduceOnly: false },
  ] as const)(
    "serializes $intent without changing execution intent",
    async ({ side, reduceOnly }) => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
      const quietConsole = (
        ["info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const networkGuard = vi.fn(() =>
        expect.fail("Wire tests must not perform real HTTP requests"),
      )
      vi.stubGlobal("fetch", networkGuard)
      const requests: { url: string; body: unknown }[] = []
      const abiEncode = vi.spyOn(Derive.prototype, "ethAbiEncode")
      const transport = vi
        .spyOn(Derive.prototype, "fetch")
        .mockImplementation(
          async (
            url: unknown,
            method?: string,
            _headers?: unknown,
            body?: unknown,
          ) => {
            if (typeof url !== "string" || typeof body !== "string") {
              expect.fail(
                "Expected the SDK to serialize an HTTP URL and JSON body",
              )
            }
            expect(method).toBe("POST")
            const wireBody: unknown = JSON.parse(body)
            requests.push({ url, body: wireBody })
            if (url === "/derive-api-demo/public/get_instrument") {
              expect(wireBody).toEqual({ instrument_name: instrumentName })
              return { result: syntheticOption }
            }
            if (url !== "/derive-api-demo/private/order") {
              expect.fail(`Unexpected SDK transport endpoint: ${url}`)
            }
            return {
              result: {
                order: {
                  order_id: "synthetic-order",
                  instrument_name: instrumentName,
                  direction: side,
                  order_type: "limit",
                  order_status: "filled",
                  amount: "2",
                  filled_amount: "2",
                  limit_price: "50",
                  average_price: "50",
                  order_fee: "0",
                  creation_timestamp: Date.now(),
                  last_update_timestamp: Date.now(),
                },
              },
            }
          },
        )
      const orders = await Effect.runPromise(
        new DeriveTradingClient(session).createOrdersBatch([
          {
            symbol: instrumentName,
            side,
            type: "limit",
            amount: 2,
            price: 50,
            maxFee: 1,
            reduceOnly,
          },
        ]),
      )

      expect(orders).toHaveLength(1)
      expect(orders[0]?.id).toBe("synthetic-order")
      expect(transport).toHaveBeenCalledTimes(2)
      expect(abiEncode).toHaveBeenCalledWith(
        ["address", "uint", "int", "int", "uint", "uint", "bool"],
        [
          syntheticOption.base_asset_address,
          39614108744922863198558842368n,
          expect.anything(),
          expect.anything(),
          expect.anything(),
          42,
          side === "buy",
        ],
      )
      expect(requests.map(request => request.url)).toEqual([
        "/derive-api-demo/public/get_instrument",
        "/derive-api-demo/private/order",
      ])
      const submitted = requests.find(
        request => request.url === "/derive-api-demo/private/order",
      )
      expect(submitted?.body).toMatchObject({
        instrument_name: instrumentName,
        subaccount_id: 42,
        direction: side,
        order_type: "limit",
        amount: "2",
        limit_price: "50",
        max_fee: "1",
        signer: session.sessionAddress,
        signature: expect.stringMatching(/^0x[0-9a-f]{130}$/i),
      })
      expect(submitted?.body).not.toHaveProperty("reduceOnly")
      expect(submitted?.body).not.toHaveProperty("timeInForce")
      if (reduceOnly) {
        expect(submitted?.body).toMatchObject({
          reduce_only: true,
          time_in_force: "ioc",
        })
      } else {
        expect(submitted?.body).not.toHaveProperty("reduce_only")
        expect(submitted?.body).not.toHaveProperty("time_in_force")
      }
      expect(debug).toHaveBeenNthCalledWith(1, "[derive] order accepted", {
        index: 0,
        total: 1,
      })
      expect(debug).toHaveBeenNthCalledWith(
        2,
        "[derive] order batch completed",
        { count: 1 },
      )
      expect(debug).toHaveBeenCalledTimes(2)
      quietConsole.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
      expect(networkGuard).not.toHaveBeenCalled()
    },
  )
})
