import { afterEach, describe, expect, it, vi } from "vitest"
import * as Effect from "effect/Effect"

import { fetchDeriveOpenOrders } from "./account"
import type { DeriveSessionCredentials } from "./session"

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({ signMessage: async () => "0xtest-signature" }),
}))

const session: DeriveSessionCredentials = {
  deriveWallet: "0x1111111111111111111111111111111111111111",
  sessionAddress: "0x2222222222222222222222222222222222222222",
  sessionPrivateKey: "0x00",
  networkMode: "testnet",
  subaccountId: 42,
}

const validOrder = { order_id: "order-1", instrument_name: "ETH-PERP" }

const malformedResults = [
  { label: "null result", result: null },
  { label: "null order", result: { orders: [null] } },
  { label: "primitive order", result: { orders: [42] } },
  {
    label: "missing identifier",
    result: { orders: [{ instrument_name: "ETH-PERP" }] },
  },
  {
    label: "blank identifier",
    result: { orders: [{ ...validOrder, order_id: "  " }] },
  },
  {
    label: "missing instrument",
    result: { orders: [{ order_id: "order-1" }] },
  },
  {
    label: "blank instrument",
    result: { orders: [{ ...validOrder, instrument_name: "" }] },
  },
  {
    label: "invalid amount shape",
    result: { orders: [{ ...validOrder, amount: {} }] },
  },
  {
    label: "invalid status shape",
    result: { orders: [{ ...validOrder, order_status: 42 }] },
  },
  {
    label: "numeric prefix with trailing junk",
    result: { orders: [{ ...validOrder, amount: "1lot" }] },
  },
  {
    label: "empty numeric field",
    result: { orders: [{ ...validOrder, average_price: "" }] },
  },
  {
    label: "non-finite numeric string",
    result: { orders: [{ ...validOrder, limit_price: "Infinity" }] },
  },
  {
    label: "partially valid snapshot",
    result: { orders: [validOrder, null] },
  },
] as const

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Derive open-order response validation", () => {
  it.each(malformedResults)(
    "rejects $label through the typed RPC failure channel",
    async ({ result }) => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const fetch = vi.fn().mockResolvedValue(Response.json({ result }))
      vi.stubGlobal("fetch", fetch)

      const failure = await Effect.runPromise(
        Effect.flip(fetchDeriveOpenOrders(session)),
      )

      expect(failure).toMatchObject({ _tag: "DeriveRpcError", code: null })
      expect(fetch).toHaveBeenCalledTimes(1)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )

  it("rejects a malformed later page without exposing the valid prefix", async () => {
    const consoleSpies = (
      ["debug", "info", "warn", "error", "log", "trace"] as const
    ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    const firstPageOrders = Array.from({ length: 500 }, (_unused, index) => ({
      ...validOrder,
      order_id: `order-${index}`,
    }))
    const pagination = { num_pages: 2, count: 501 }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ result: { orders: firstPageOrders, pagination } }),
      )
      .mockResolvedValueOnce(
        Response.json({ result: { orders: [null], pagination } }),
      )
    vi.stubGlobal("fetch", fetch)

    const failure = await Effect.runPromise(
      Effect.flip(fetchDeriveOpenOrders(session)),
    )

    expect(failure).toMatchObject({ _tag: "DeriveRpcError", code: null })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith(
      "/derive-api-demo/private/get_orders",
      expect.objectContaining({ body: expect.stringContaining('"page":2') }),
    )
    consoleSpies.forEach(consoleSpy => {
      expect(consoleSpy).not.toHaveBeenCalled()
    })
  })

  it.each([
    { label: "empty", orders: [] },
    {
      label: "populated",
      orders: [
        {
          ...validOrder,
          direction: "buy",
          amount: "1.2500000000000000001",
          filled_amount: 0,
          order_status: "open",
        },
      ],
    },
  ])("preserves a valid $label order list", async ({ orders }) => {
    const consoleSpies = (
      ["debug", "info", "warn", "error", "log", "trace"] as const
    ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        result: {
          orders,
          pagination: { num_pages: 1, count: orders.length },
        },
      }),
    )
    vi.stubGlobal("fetch", fetch)
    const controller = new AbortController()

    expect(
      await Effect.runPromise(
        fetchDeriveOpenOrders(session, controller.signal),
      ),
    ).toEqual(orders)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/derive-api-demo/private/get_orders",
      expect.objectContaining({ method: "POST", signal: controller.signal }),
    )
    consoleSpies.forEach(consoleSpy => {
      expect(consoleSpy).not.toHaveBeenCalled()
    })
  })
})
