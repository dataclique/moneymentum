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
  it.each([
    { label: "missing pagination", pagination: undefined },
    { label: "null pagination", pagination: null },
    { label: "array pagination", pagination: [] },
    { label: "string pagination", pagination: "unexpected" },
    { label: "missing page count", pagination: {} },
    { label: "null page count", pagination: { num_pages: null } },
    { label: "string page count", pagination: { num_pages: "1" } },
    { label: "boolean page count", pagination: { num_pages: false } },
    { label: "object page count", pagination: { num_pages: {} } },
    { label: "fractional page count", pagination: { num_pages: 1.5 } },
    { label: "negative page count", pagination: { num_pages: -1 } },
    { label: "zero pages with an order", pagination: { num_pages: 0 } },
    {
      label: "unsafe page count",
      pagination: { num_pages: Number.MAX_SAFE_INTEGER + 1 },
    },
  ])(
    "rejects $label instead of reporting a complete snapshot",
    async ({ pagination }) => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const fetch = vi.fn().mockResolvedValue(
        Response.json({
          result: { orders: [validOrder], pagination },
        }),
      )
      vi.stubGlobal("fetch", fetch)
      const snapshot = await Effect.runPromise(
        Effect.either(fetchDeriveOpenOrders(session)),
      )
      expect(snapshot).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "DeriveRpcError",
          code: null,
          message: expect.stringContaining("pagination"),
        },
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )

  it.each([
    { label: "missing", pagination: undefined },
    { label: "shrinking", pagination: { num_pages: 1 } },
    { label: "zero", pagination: { num_pages: 0 } },
  ])(
    "rejects $label later-page metadata without returning the valid prefix",
    async ({ pagination }) => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const firstPageOrders = Array.from({ length: 500 }, (_unused, index) => ({
        ...validOrder,
        order_id: `first-page-${index}`,
      }))
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            result: {
              orders: firstPageOrders,
              pagination: { num_pages: 2, count: 501 },
            },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ result: { orders: [validOrder], pagination } }),
        )
      vi.stubGlobal("fetch", fetch)
      const snapshot = await Effect.runPromise(
        Effect.either(fetchDeriveOpenOrders(session)),
      )
      expect(snapshot).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "DeriveRpcError",
          code: null,
          message: expect.stringContaining("pagination"),
        },
      })
      expect(fetch).toHaveBeenCalledTimes(2)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )

  it("rejects an overflowing page count decoded from JSON", async () => {
    const consoleSpies = (
      ["debug", "info", "warn", "error", "log", "trace"] as const
    ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          '{"result":{"orders":[],"pagination":{"num_pages":1e999}}}',
          { headers: { "content-type": "application/json" } },
        ),
      )
    vi.stubGlobal("fetch", fetch)
    const snapshot = await Effect.runPromise(
      Effect.either(fetchDeriveOpenOrders(session)),
    )
    expect(snapshot).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "DeriveRpcError",
        code: null,
        message: expect.stringContaining("pagination"),
      },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    consoleSpies.forEach(consoleSpy => {
      expect(consoleSpy).not.toHaveBeenCalled()
    })
  })

  it.each([
    {
      label: "missing pagination",
      orderPage: { orders: [] },
      expectedTag: "Left",
    },
    {
      label: "explicit zero pages",
      orderPage: { orders: [], pagination: { num_pages: 0, count: 0 } },
      expectedTag: "Right",
    },
  ])(
    "distinguishes $label on an empty first page",
    async ({ orderPage, expectedTag }) => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const fetch = vi
        .fn()
        .mockResolvedValue(Response.json({ result: orderPage }))
      vi.stubGlobal("fetch", fetch)
      const snapshot = await Effect.runPromise(
        Effect.either(fetchDeriveOpenOrders(session)),
      )
      expect(snapshot._tag).toBe(expectedTag)
      if (snapshot._tag === "Right") {
        expect(snapshot.right).toEqual([])
      } else {
        expect(snapshot.left).toMatchObject({
          _tag: "DeriveRpcError",
          code: null,
          message: expect.stringContaining("pagination"),
        })
      }
      expect(fetch).toHaveBeenCalledTimes(1)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )

  it.each([
    { label: "null root", envelope: null },
    { label: "numeric root", envelope: 42 },
    { label: "string root", envelope: "unexpected" },
    { label: "boolean root", envelope: false },
    { label: "array root", envelope: [] },
    { label: "primitive error", envelope: { error: "unexpected" } },
    { label: "array error", envelope: { error: [] } },
    { label: "object error code", envelope: { error: { code: {} } } },
    { label: "array error code", envelope: { error: { code: [] } } },
    { label: "boolean error code", envelope: { error: { code: true } } },
    { label: "object error message", envelope: { error: { message: {} } } },
    { label: "array error message", envelope: { error: { message: [] } } },
    { label: "numeric error message", envelope: { error: { message: 42 } } },
  ])(
    "rejects $label without defects or malformed domain errors",
    async ({ envelope }) => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const fetch = vi.fn().mockResolvedValue(Response.json(envelope))
      vi.stubGlobal("fetch", fetch)

      const failure = await Effect.runPromise(
        Effect.flip(fetchDeriveOpenOrders(session)),
      )

      expect(failure).toMatchObject({
        _tag: "DeriveRpcError",
        code: null,
        message: expect.any(String),
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )

  it("rejects an overflowing error code parsed from a JSON response", async () => {
    const consoleSpies = (
      ["debug", "info", "warn", "error", "log", "trace"] as const
    ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    const fetch = vi.fn().mockResolvedValue(
      new Response('{"error":{"code":1e999,"message":"venue failure"}}', {
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetch)

    const failure = await Effect.runPromise(
      Effect.flip(fetchDeriveOpenOrders(session)),
    )

    expect(failure).toMatchObject({
      _tag: "DeriveRpcError",
      code: null,
      message: expect.any(String),
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    consoleSpies.forEach(consoleSpy => {
      expect(consoleSpy).not.toHaveBeenCalled()
    })
  })

  it.each([11009, "11009", null, undefined])(
    "preserves a valid venue error with code %j",
    async code => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code, message: "venue failure" } }),
        )
      vi.stubGlobal("fetch", fetch)

      const failure = await Effect.runPromise(
        Effect.flip(fetchDeriveOpenOrders(session)),
      )

      expect(failure).toMatchObject({
        _tag: "DeriveRpcError",
        code: code ?? null,
        message: "venue failure",
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )

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
    { initialPages: 3, laterPages: 2 },
    { initialPages: 2, laterPages: 3 },
  ])(
    "rejects a page-count change from $initialPages to $laterPages during collection",
    async ({ initialPages, laterPages }) => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      const pageResponse = (page: number, pageCount: number) =>
        Response.json({
          result: {
            orders: Array.from({ length: 500 }, (_unused, orderIndex) => ({
              ...validOrder,
              order_id: `order-${page}-${orderIndex}`,
            })),
            pagination: { num_pages: pageCount, count: pageCount * 500 },
          },
        })
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(pageResponse(1, initialPages))
        .mockResolvedValueOnce(pageResponse(2, laterPages))
        .mockResolvedValueOnce(pageResponse(3, laterPages))
      vi.stubGlobal("fetch", fetch)
      const snapshot = await Effect.runPromise(
        Effect.either(fetchDeriveOpenOrders(session)),
      )
      expect(snapshot).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "DeriveRpcError",
          code: null,
          message: expect.stringContaining("pagination"),
        },
      })
      expect(fetch).toHaveBeenCalledTimes(2)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )

  it.each([100, 101])(
    "never exposes an incomplete %i-page snapshot at the page limit",
    async reportedPages => {
      const consoleSpies = (
        ["debug", "info", "warn", "error", "log", "trace"] as const
      ).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
      let responsePage = 0
      const fetch = vi.fn(() => {
        responsePage += 1
        const orders = Array.from({ length: 500 }, (_unused, orderIndex) => ({
          ...validOrder,
          order_id: `order-${responsePage}-${orderIndex}`,
        }))
        return Promise.resolve(
          Response.json({
            result: {
              orders,
              pagination: {
                num_pages: reportedPages,
                count: reportedPages * 500,
              },
            },
          }),
        )
      })
      vi.stubGlobal("fetch", fetch)

      const snapshot = await Effect.runPromise(
        Effect.either(fetchDeriveOpenOrders(session)),
      )

      expect(snapshot._tag).toBe(reportedPages === 100 ? "Right" : "Left")
      if (snapshot._tag === "Right") {
        expect(snapshot.right).toHaveLength(50_000)
        expect(snapshot.right[49_999]?.order_id).toBe("order-100-499")
      } else {
        expect(snapshot.left).toMatchObject({
          _tag: "DeriveRpcError",
          code: null,
          message: expect.stringContaining("page limit"),
        })
      }
      expect(fetch).toHaveBeenCalledTimes(100)
      consoleSpies.forEach(consoleSpy => {
        expect(consoleSpy).not.toHaveBeenCalled()
      })
    },
  )

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
