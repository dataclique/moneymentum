import { afterEach, describe, expect, it, vi } from "vitest"
import derive from "ccxt/derive"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"

import type { DeriveCcxtExchange, DeriveCcxtOrder } from "./exchange"
import type { DeriveSessionCredentials } from "./session"
import {
  placeAndMonitorDeriveOrders,
  type DeriveBatchOrderRequest,
} from "./trading"

const exchangeBoundary = vi.hoisted(() => {
  const market = {
    symbol: "ETH-PERP",
    swap: true,
    precision: { amount: 0.00001, price: 0.1 },
  }
  const options: Record<string, unknown> = {}
  return {
    setSandboxMode: vi.fn(),
    urls: { api: {} },
    options,
    markets: { "ETH-PERP": market },
    markets_by_id: { "ETH-PERP": market },
    market: () => market,
    createOrder: vi.fn<DeriveCcxtExchange["createOrder"]>(),
  }
})

vi.mock("ccxt/derive", () => ({
  default: vi.fn(function DeriveExchangeMock() {
    return exchangeBoundary
  }),
}))

const session: DeriveSessionCredentials = {
  deriveWallet: "0x1111111111111111111111111111111111111111",
  sessionAddress: "0x2222222222222222222222222222222222222222",
  sessionPrivateKey: "0x00",
  networkMode: "testnet",
  subaccountId: 42,
}

const request: DeriveBatchOrderRequest = {
  symbol: "ETH-PERP",
  side: "buy",
  amount: 1,
  price: 100,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Derive batch session isolation", () => {
  it("keeps each live guard while concurrent batches share the exchange", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    let firstSessionCurrent = true
    const firstOrderStarted = await Effect.runPromise(Deferred.make<void>())
    const firstOrderResponse = await Effect.runPromise(
      Deferred.make<DeriveCcxtOrder>(),
    )
    exchangeBoundary.createOrder
      .mockImplementationOnce(() => {
        Effect.runSync(Deferred.succeed(firstOrderStarted, undefined))
        return Effect.runPromise(Deferred.await(firstOrderResponse))
      })
      .mockResolvedValueOnce({ id: "second-batch-first", status: "open" })
      .mockResolvedValueOnce({ id: "second-batch-second", status: "open" })
      .mockResolvedValue({ id: "unexpected-order", status: "open" })
    const secondSessionGuard = { isSessionCurrent: vi.fn(() => true) }

    const batches = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstBatch = yield* Effect.forkScoped(
            placeAndMonitorDeriveOrders(
              session,
              [request, { ...request, amount: 2 }],
              { isSessionCurrent: () => firstSessionCurrent },
            ),
          )
          yield* Deferred.await(firstOrderStarted)
          firstSessionCurrent = false
          const secondBatch = yield* placeAndMonitorDeriveOrders(
            session,
            [
              { ...request, amount: 3 },
              { ...request, amount: 4 },
            ],
            secondSessionGuard,
          )
          yield* Deferred.succeed(firstOrderResponse, {
            id: "first-batch-prefix",
            status: "open",
          })
          return { first: yield* Fiber.join(firstBatch), second: secondBatch }
        }),
      ),
    )

    expect(batches.first).toMatchObject({
      terminal: "cancelled",
      outcomes: [{ kind: "accepted", orderId: "first-batch-prefix" }],
    })
    expect(batches.second).toEqual([
      { symbol: "ETH-PERP", side: "buy", status: "working", message: null },
      { symbol: "ETH-PERP", side: "buy", status: "working", message: null },
    ])
    expect(secondSessionGuard.isSessionCurrent).toHaveBeenCalledTimes(1)
    expect(exchangeBoundary.createOrder).toHaveBeenCalledTimes(3)
    expect(derive).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledWith("[derive] order batch stopped", {
      terminal: "cancelled",
      accepted: 1,
      unattemptedCount: 1,
    })
  })
})
