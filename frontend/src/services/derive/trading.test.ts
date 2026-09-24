import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"

import { getErrorMessage } from "@/lib/error-message"

import type { DeriveCcxtExchange } from "./exchange"
import {
  fetchDeriveTickers,
  fetchDeriveFundingRates,
  placeAndMonitorDeriveOrders,
  cancelDeriveOrder,
  DerivePartialBatchFailure,
} from "./trading"

const exchangeBoundary = vi.hoisted(() => ({
  loadMarkets: vi.fn<DeriveCcxtExchange["loadMarkets"]>(),
  fetchTicker: vi.fn<DeriveCcxtExchange["fetchTicker"]>(),
  publicPostGetTicker: vi.fn<DeriveCcxtExchange["publicPostGetTicker"]>(),
  fetchFundingRate: vi.fn<DeriveCcxtExchange["fetchFundingRate"]>(),
  createOrder: vi.fn<DeriveCcxtExchange["createOrder"]>(),
  cancelOrder: vi.fn<DeriveCcxtExchange["cancelOrder"]>(),
  publicPostGetInstrument:
    vi.fn<DeriveCcxtExchange["publicPostGetInstrument"]>(),
  parseMarket: vi.fn<DeriveCcxtExchange["parseMarket"]>(),
  setMarkets: vi.fn<DeriveCcxtExchange["setMarkets"]>(),
}))

vi.mock("ccxt/derive", () => ({
  default: vi.fn(function DeriveMock(this: {
    setSandboxMode: ReturnType<typeof vi.fn>
    urls: { api: Record<string, string> }
    options: Record<string, unknown>
    markets?: Record<string, { symbol: string; swap?: boolean }>
    markets_by_id?: Record<string, { symbol: string; swap?: boolean }>
  }) {
    this.setSandboxMode = vi.fn()
    this.urls = { api: {} }
    this.options = {}
    Object.assign(this, exchangeBoundary, {
      markets: { "ETH-PERP": { symbol: "ETH-PERP", swap: true } },
      markets_by_id: { "ETH-PERP": { symbol: "ETH-PERP", swap: true } },
      market: () => ({ symbol: "ETH-PERP", swap: true }),
    })
    return this
  }),
}))

import {
  mapDeriveOrderForWatch,
  DeriveTradingClient,
  isCcxtRequestTimeout,
  snapToDeriveStep,
  DEFAULT_DERIVE_AMOUNT_STEP,
  type DeriveBatchOrderRequest,
  type DeriveSessionCredentials,
} from "@/services/derive/index"

const credentials = (): DeriveSessionCredentials => ({
  deriveWallet: "0x2625A865DeD8FA2C36183E299A1a358B64EE7238",
  sessionAddress: "0xA62eF13dF0037Ca5A95F7759b79202ce9eF2B7fd",
  sessionPrivateKey:
    "0x5b47181e772213c58ba3880a6e63a4458df76b3642209f95a817c697d5bf4548",
  networkMode: "testnet",
  subaccountId: 144457,
})

describe("isCcxtRequestTimeout", () => {
  it("matches CCXT RequestTimeout by name or message", () => {
    const named = new Error("boom")
    named.name = "RequestTimeout"
    expect(isCcxtRequestTimeout(named)).toBe(true)
    expect(
      isCcxtRequestTimeout(
        new Error("derive POST /private/order request timed out (10000 ms)"),
      ),
    ).toBe(true)
    expect(isCcxtRequestTimeout(new Error("insufficient margin"))).toBe(false)
  })
})

describe("snapToDeriveStep", () => {
  it("rounds contracts onto the venue amount_step", () => {
    expect(snapToDeriveStep(0.011866234, DEFAULT_DERIVE_AMOUNT_STEP)).toBe(
      0.01187,
    )
    expect(snapToDeriveStep(2, DEFAULT_DERIVE_AMOUNT_STEP)).toBe(2)
    expect(snapToDeriveStep(0, DEFAULT_DERIVE_AMOUNT_STEP)).toBe(0)
    expect(snapToDeriveStep(0.000025, 2.5e-5)).toBe(0.000025)
  })
})

describe("mapDeriveOrderForWatch", () => {
  it("maps filled order_status to filled", () => {
    expect(
      mapDeriveOrderForWatch({
        status: "closed",
        info: { order_status: "filled" },
      }),
    ).toEqual({ status: "filled", message: null })
  })

  it("maps open order_status to working", () => {
    expect(
      mapDeriveOrderForWatch({
        status: "open",
        info: { order_status: "open" },
      }),
    ).toEqual({ status: "working", message: null })
  })

  it("maps cancelled order_status to failed", () => {
    expect(
      mapDeriveOrderForWatch({
        status: "canceled",
        info: { order_status: "cancelled" },
      }),
    ).toEqual({ status: "failed", message: "Order cancelled" })
  })

  it("keeps unrecognized statuses working with a diagnostic", () => {
    expect(
      mapDeriveOrderForWatch({
        status: "open",
        info: { order_status: "partially_filled" },
      }),
    ).toEqual({
      status: "working",
      message: "Unknown order status: partially_filled",
    })
  })
})

describe("DeriveTradingClient typed effects", () => {
  it.each([
    "resolveSymbol",
    "fetchTickers",
    "fetchFundingRates",
    "createOrdersBatch",
    "placeAndMonitorOrders",
    "fetchOpenOrders",
    "cancelOrder",
  ] as const)(
    "constructs a lazy %s operation without starting exchange I/O",
    async method => {
      const client = new DeriveTradingClient(credentials())
      const market = { symbol: "ETH-PERP", swap: true }
      const exchangeMock = {
        loadMarkets: vi.fn().mockResolvedValue({}),
        markets: { "ETH-PERP": market },
        markets_by_id: { "ETH-PERP": market },
        market: vi.fn().mockReturnValue(market),
        publicPostGetInstrument: vi.fn(),
        parseMarket: vi.fn(),
        setMarkets: vi.fn(),
        fetchTicker: vi.fn().mockResolvedValue({ bid: 2000, ask: 2001 }),
        publicPostGetTicker: vi.fn().mockResolvedValue({
          result: {
            best_bid_price: "2000",
            best_ask_price: "2001",
            mark_price: "2000.5",
          },
        }),
        fetchFundingRate: vi.fn().mockResolvedValue({ fundingRate: 0.001 }),
        createOrder: vi
          .fn()
          .mockResolvedValue({ id: "created", status: "open" }),
        fetchOpenOrders: vi.fn().mockResolvedValue([]),
        cancelOrder: vi
          .fn()
          .mockResolvedValue({ id: "cancelled", status: "cancelled" }),
      }
      const exchange = (client as unknown as { exchange: typeof exchangeMock })
        .exchange
      Object.assign(exchange, exchangeMock)
      const requests: DeriveBatchOrderRequest[] = [
        { symbol: "ETH-PERP", side: "buy", amount: 0.01, price: 2000 },
      ]
      const operations = {
        resolveSymbol: () => client.resolveSymbol("ETH-PERP"),
        fetchTickers: () => client.fetchTickers(["ETH-PERP"]),
        fetchFundingRates: () => client.fetchFundingRates(["ETH-PERP"]),
        createOrdersBatch: () => client.createOrdersBatch(requests),
        placeAndMonitorOrders: () => client.placeAndMonitorOrders(requests),
        fetchOpenOrders: () => client.fetchOpenOrders(),
        cancelOrder: () => client.cancelOrder("order", "ETH-PERP"),
      }
      const operation = operations[method]()
      // Settle the old eager Promise implementation before asserting its contract.
      if (operation instanceof Promise) {
        await operation
      }

      expect(Effect.isEffect(operation)).toBe(true)
      expect(exchangeMock.loadMarkets).not.toHaveBeenCalled()
      expect(exchangeMock.publicPostGetInstrument).not.toHaveBeenCalled()
      expect(exchangeMock.createOrder).not.toHaveBeenCalled()
      expect(exchangeMock.cancelOrder).not.toHaveBeenCalled()
    },
  )
})

describe("public trading operation interruption", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each(["tickers", "fundingRates", "placeOrders", "cancelOrder"] as const)(
    "does not continue %s exchange I/O after cancellation during instrument hydrate",
    async operationName => {
      const loading = Effect.runSync(Deferred.make<void>())
      const loaded = Effect.runSync(
        Deferred.make<{ result: { instrument_name: string } }>(),
      )
      exchangeBoundary.publicPostGetInstrument.mockImplementation(() => {
        Effect.runSync(Deferred.succeed(loading, undefined))
        return Effect.runPromise(Deferred.await(loaded))
      })
      exchangeBoundary.publicPostGetTicker.mockReset().mockResolvedValue({
        result: {
          best_bid_price: "2000",
          best_ask_price: "2001",
          mark_price: "2000.5",
        },
      })
      exchangeBoundary.fetchFundingRate
        .mockReset()
        .mockResolvedValue({ fundingRate: 0.001 })
      exchangeBoundary.createOrder
        .mockReset()
        .mockResolvedValue({ id: "accepted", status: "open" })
      exchangeBoundary.cancelOrder
        .mockReset()
        .mockResolvedValue({ id: "cancelled", status: "cancelled" })
      const debug = vi
        .spyOn(console, "debug")
        .mockImplementation(() => undefined)
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
      const accountIds = {
        tickers: 900001,
        fundingRates: 900002,
        placeOrders: 900003,
        cancelOrder: 900004,
      }
      const session = {
        ...credentials(),
        subaccountId: accountIds[operationName],
      }
      const unknownInstrument = "ETH-20260925-2000-C"
      const operations = {
        tickers: () => fetchDeriveTickers(session, [unknownInstrument]),
        fundingRates: () =>
          fetchDeriveFundingRates(session, [unknownInstrument]),
        placeOrders: () =>
          placeAndMonitorDeriveOrders(session, [
            {
              symbol: unknownInstrument,
              side: "buy",
              amount: 0.01,
              price: 2000,
            },
          ]),
        cancelOrder: () =>
          cancelDeriveOrder(session, {
            id: "order",
            symbol: unknownInstrument,
          }),
      }
      const operation: Effect.Effect<unknown, unknown> =
        operations[operationName]()
      const fiber = Effect.runFork(operation)
      await Effect.runPromise(Deferred.await(loading))
      const exit = await Effect.runPromise(Fiber.interrupt(fiber))
      expect(Exit.isInterrupted(exit)).toBe(true)

      Effect.runSync(
        Deferred.succeed(loaded, {
          result: { instrument_name: unknownInstrument },
        }),
      )
      // Pending Promise can settle; drain its microtasks before checking dispatch.
      await new Promise<void>(resolve => {
        setTimeout(resolve, 0)
      })

      expect(exchangeBoundary.publicPostGetTicker).not.toHaveBeenCalled()
      expect(exchangeBoundary.fetchTicker).not.toHaveBeenCalled()
      expect(exchangeBoundary.fetchFundingRate).not.toHaveBeenCalled()
      expect(exchangeBoundary.createOrder).not.toHaveBeenCalled()
      expect(exchangeBoundary.cancelOrder).not.toHaveBeenCalled()
      expect(info).not.toHaveBeenCalledWith(
        expect.stringContaining("createOrder accepted"),
        expect.anything(),
      )
      expect(debug).toHaveBeenCalledWith(
        "[derive] trading operation interrupted",
        { operation: operationName },
      )
    },
  )
})

describe("DeriveTradingClient.fetchTickers", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("quotes via public get_ticker without CCXT fetchTicker or loadMarkets", async () => {
    exchangeBoundary.publicPostGetTicker.mockReset().mockResolvedValue({
      result: {
        best_bid_price: "1999.5",
        best_ask_price: "2000.5",
        mark_price: "2000",
      },
    })
    exchangeBoundary.fetchTicker.mockReset()
    exchangeBoundary.loadMarkets.mockReset()

    const quotes = await Effect.runPromise(
      fetchDeriveTickers(credentials(), ["ETH-PERP"]),
    )

    expect(quotes["ETH-PERP"]).toEqual({
      symbol: "ETH-PERP",
      bid: 1999.5,
      ask: 2000.5,
      last: null,
      mark: 2000,
    })
    expect(exchangeBoundary.publicPostGetTicker).toHaveBeenCalledWith({
      instrument_name: "ETH-PERP",
    })
    expect(exchangeBoundary.fetchTicker).not.toHaveBeenCalled()
    expect(exchangeBoundary.loadMarkets).not.toHaveBeenCalled()
  })
})

describe("DeriveTradingClient.createOrdersBatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite order amount %s before venue submission",
    async amount => {
      const debug = vi
        .spyOn(console, "debug")
        .mockImplementation(() => undefined)
      exchangeBoundary.createOrder.mockReset().mockResolvedValue({
        id: "must-not-submit",
        symbol: "ETH-PERP",
        side: "buy",
        status: "open",
      })
      const client = new DeriveTradingClient(credentials())
      vi.spyOn(client, "resolveSymbol").mockReturnValue(
        Effect.succeed("ETH-PERP"),
      )
      const outcome = await Effect.runPromise(
        Effect.either(
          client.createOrdersBatch([
            { symbol: "ETH-PERP", side: "buy", amount, price: 2000 },
          ]),
        ),
      )

      expect(outcome).toMatchObject({
        _tag: "Left",
        left: { _tag: "DeriveOrderSizeInvalid" },
      })
      expect(exchangeBoundary.createOrder).not.toHaveBeenCalled()
      expect(debug).toHaveBeenCalledWith("[derive] order rejected locally", {
        index: 0,
        total: 1,
        field: "amount",
      })
    },
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite order price %s before venue submission",
    async price => {
      const debug = vi
        .spyOn(console, "debug")
        .mockImplementation(() => undefined)
      exchangeBoundary.createOrder.mockReset().mockResolvedValue({
        id: "must-not-submit",
        symbol: "ETH-PERP",
        side: "buy",
        status: "open",
      })
      const client = new DeriveTradingClient(credentials())
      vi.spyOn(client, "resolveSymbol").mockReturnValue(
        Effect.succeed("ETH-PERP"),
      )
      const outcome = await Effect.runPromise(
        Effect.either(
          client.createOrdersBatch([
            { symbol: "ETH-PERP", side: "buy", amount: 0.01, price },
          ]),
        ),
      )

      expect(outcome).toMatchObject({
        _tag: "Left",
        left: { _tag: "DeriveOrderPriceInvalid", price },
      })
      expect(exchangeBoundary.createOrder).not.toHaveBeenCalled()
      expect(debug).toHaveBeenCalledWith("[derive] order rejected locally", {
        index: 0,
        total: 1,
        field: "price",
      })
    },
  )

  it.each([
    { operation: "createOrdersBatch", failure: "venue" },
    { operation: "createOrdersBatch", failure: "local" },
    { operation: "placeAndMonitorOrders", failure: "venue" },
    { operation: "placeAndMonitorOrders", failure: "local" },
  ] as const)(
    "$operation retains prior responses after a later $failure failure",
    async ({ operation, failure }) => {
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined)
      const transportFailure = new Error("submission response lost")
      const receivedOrder = {
        id: "first-order",
        symbol: "ETH-PERP",
        side: "buy",
        status: "open",
      }
      exchangeBoundary.loadMarkets.mockReset().mockResolvedValue({})
      exchangeBoundary.createOrder
        .mockReset()
        .mockResolvedValueOnce(receivedOrder)
        .mockRejectedValueOnce(transportFailure)
      const client = new DeriveTradingClient(credentials())
      const firstRequest: DeriveBatchOrderRequest = {
        symbol: "ETH-PERP",
        side: "buy",
        amount: 0.01,
        price: 2000,
      }
      const failedRequest: DeriveBatchOrderRequest = {
        symbol: "ETH-PERP",
        side: "sell",
        amount: failure === "local" ? 0 : 0.02,
        price: 2100,
      }
      const untouchedRequest: DeriveBatchOrderRequest = {
        symbol: "ETH-PERP",
        side: "buy",
        amount: 0.03,
        price: 2200,
      }
      const outcome = await Effect.runPromise(
        client[operation]([firstRequest, failedRequest, untouchedRequest]).pipe(
          Effect.either,
        ),
      )

      expect(outcome._tag).toBe("Left")
      if (outcome._tag !== "Left") {
        throw new Error("expected a partial batch failure")
      }
      expect(outcome.left).toBeInstanceOf(DerivePartialBatchFailure)
      if (!(outcome.left instanceof DerivePartialBatchFailure)) {
        throw new Error("expected retained submission responses")
      }
      expect(outcome.left.submittedOrders).toEqual([
        { request: firstRequest, order: receivedOrder },
      ])
      expect(outcome.left.failedRequest).toEqual(failedRequest)
      expect(outcome.left.unattemptedRequests).toEqual([untouchedRequest])
      const causeTag =
        failure === "venue" ? "ExchangeRequestError" : "DeriveOrderSizeInvalid"
      expect(outcome.left.cause._tag).toBe(causeTag)
      if (failure === "venue") {
        expect(outcome.left.cause).toMatchObject({ cause: transportFailure })
      }
      expect(exchangeBoundary.createOrder).toHaveBeenCalledTimes(
        failure === "venue" ? 2 : 1,
      )
      expect(exchangeBoundary.createOrder).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        untouchedRequest.amount,
        expect.anything(),
        expect.anything(),
      )
      expect(warning).toHaveBeenCalledWith("[derive] order batch stopped", {
        submittedCount: 1,
        failedIndex: 1,
        unattemptedCount: 1,
        causeTag,
      })
      const message = await Effect.runPromise(Effect.fail(outcome.left)).catch(
        getErrorMessage,
      )
      expect(message).toBe(
        "Some Derive orders were submitted before the batch stopped. Reconcile order and account state before retrying.",
      )
    },
  )

  it("creates orders sequentially with max_fee and subaccount_id", async () => {
    const createOrder = vi
      .fn()
      .mockResolvedValueOnce({ id: "1", symbol: "ETH/USD:USDC", side: "buy" })
      .mockResolvedValueOnce({ id: "2", symbol: "ETH/USD:USDC", side: "sell" })

    const client = new DeriveTradingClient(credentials())
    const exchange = (
      client as unknown as {
        exchange: {
          loadMarkets: () => Promise<Record<string, never>>
          markets: Record<string, { symbol: string; swap: boolean }>
          markets_by_id: Record<string, { symbol: string }>
          createOrder: typeof createOrder
          resolveSymbol?: unknown
        }
      }
    ).exchange

    exchange.loadMarkets = vi.fn().mockResolvedValue({})
    exchange.markets = {
      "ETH/USD:USDC": { symbol: "ETH/USD:USDC", swap: true },
    }
    exchange.markets_by_id = {
      "ETH-PERP": { symbol: "ETH/USD:USDC" },
    }
    exchange.createOrder = createOrder

    vi.spyOn(client, "resolveSymbol").mockReturnValue(
      Effect.succeed("ETH/USD:USDC"),
    )

    const requests: DeriveBatchOrderRequest[] = [
      {
        symbol: "ETH-PERP",
        side: "buy",
        amount: 0.01,
        price: 2000,
      },
      {
        symbol: "ETH-PERP",
        side: "sell",
        amount: 0.01,
        price: 2100,
        maxFee: 50,
      },
    ]

    const orders = await Effect.runPromise(client.createOrdersBatch(requests))

    expect(orders).toHaveLength(2)
    expect(createOrder).toHaveBeenCalledTimes(2)
    expect(createOrder.mock.calls[0]).toEqual([
      "ETH/USD:USDC",
      "limit",
      "buy",
      0.01,
      2000,
      { subaccount_id: 144457, max_fee: 40 },
    ])
    expect(createOrder.mock.calls[1]).toEqual([
      "ETH/USD:USDC",
      "limit",
      "sell",
      0.01,
      2100,
      { subaccount_id: 144457, max_fee: 50 },
    ])
  })

  it("recovers a timed-out createOrder from a matching open order", async () => {
    const timeout = new Error(
      "derive POST /derive-api-demo/private/order request timed out (10000 ms)",
    )
    timeout.name = "RequestTimeout"
    const createOrder = vi.fn().mockRejectedValue(timeout)

    const client = new DeriveTradingClient(credentials())
    const exchange = (
      client as unknown as {
        exchange: {
          createOrder: typeof createOrder
        }
      }
    ).exchange
    exchange.createOrder = createOrder
    vi.spyOn(client, "resolveSymbol").mockReturnValue(
      Effect.succeed("ETH/USD:USDC"),
    )
    vi.spyOn(client, "fetchOpenOrders").mockReturnValue(
      Effect.succeed([
        {
          id: "recovered",
          symbol: "ETH/USD:USDC",
          side: "buy",
          amount: 0.01,
          price: 2000,
          status: "open",
          info: { instrument_name: "ETH-PERP" },
        },
      ]),
    )

    const orders = await Effect.runPromise(
      client.createOrdersBatch([
        { symbol: "ETH-PERP", side: "buy", amount: 0.01, price: 2000 },
      ]),
    )

    expect(orders).toEqual([
      expect.objectContaining({ id: "recovered", status: "open" }),
    ])
    expect(client.fetchOpenOrders).toHaveBeenCalled()
  })

  it("does not recover an open order whose symbol only overlaps by substring", async () => {
    const timeout = new Error(
      "derive POST /derive-api-demo/private/order request timed out (10000 ms)",
    )
    timeout.name = "RequestTimeout"
    const createOrder = vi.fn().mockRejectedValue(timeout)

    const client = new DeriveTradingClient(credentials())
    const exchange = (
      client as unknown as {
        exchange: {
          createOrder: typeof createOrder
        }
      }
    ).exchange
    exchange.createOrder = createOrder
    vi.spyOn(client, "resolveSymbol").mockReturnValue(
      Effect.succeed("ETH/USD:USDC"),
    )
    vi.spyOn(client, "fetchOpenOrders").mockReturnValue(
      Effect.succeed([
        {
          id: "other",
          symbol: "ETH/USD:USDC-260925-2000-C",
          side: "buy",
          amount: 0.01,
          price: 2000,
          status: "open",
          info: { instrument_name: "ETH-20260925-2000-C" },
        },
      ]),
    )

    const outcome = await Effect.runPromise(
      Effect.either(
        client.createOrdersBatch([
          { symbol: "ETH-PERP", side: "buy", amount: 0.01, price: 2000 },
        ]),
      ),
    )
    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { _tag: "ExchangeRequestError", cause: timeout },
    })
  })

  it("snaps amount and price to market steps before createOrder", async () => {
    const createOrder = vi.fn().mockResolvedValue({
      id: "snapped",
      symbol: "BTC/USD:USDC-260816-64000-C",
      side: "buy",
    })
    const client = new DeriveTradingClient(credentials())
    const exchange = (
      client as unknown as {
        exchange: {
          createOrder: typeof createOrder
          market: (symbol: string) => {
            symbol: string
            option: boolean
            precision: { amount: number; price: number }
            info: { amount_step: string; tick_size: string }
          }
        }
      }
    ).exchange
    exchange.createOrder = createOrder
    exchange.market = () => ({
      symbol: "BTC/USD:USDC-260816-64000-C",
      option: true,
      precision: { amount: 0.00001, price: 0.1 },
      info: { amount_step: "0.00001", tick_size: "0.1" },
    })
    vi.spyOn(client, "resolveSymbol").mockReturnValue(
      Effect.succeed("BTC/USD:USDC-260816-64000-C"),
    )

    await Effect.runPromise(
      client.createOrdersBatch([
        {
          symbol: "BTC-20260816-64000-C",
          side: "buy",
          amount: 0.011866234,
          price: 927.04,
        },
      ]),
    )

    expect(createOrder).toHaveBeenCalledWith(
      "BTC/USD:USDC-260816-64000-C",
      "limit",
      "buy",
      0.01187,
      927,
      {
        subaccount_id: 144457,
        max_fee: 927 * 0.01187 * 2,
      },
    )
  })

  it("sends IOC timeInForce with reduce-only closes (Derive 11024)", async () => {
    const createOrder = vi.fn().mockResolvedValue({
      id: "close-1",
      symbol: "ETH/USD:USDC-260925-1800-P",
      side: "sell",
      status: "closed",
    })
    const client = new DeriveTradingClient(credentials())
    const exchange = (
      client as unknown as {
        exchange: { createOrder: typeof createOrder }
      }
    ).exchange
    exchange.createOrder = createOrder
    vi.spyOn(client, "resolveSymbol").mockReturnValue(
      Effect.succeed("ETH/USD:USDC-260925-1800-P"),
    )

    await Effect.runPromise(
      client.createOrdersBatch([
        {
          symbol: "ETH-20260925-1800-P",
          side: "sell",
          amount: 2,
          price: 0.0001,
          reduceOnly: true,
        },
      ]),
    )

    expect(createOrder).toHaveBeenCalledWith(
      "ETH/USD:USDC-260925-1800-P",
      "limit",
      "sell",
      2,
      0.0001,
      {
        subaccount_id: 144457,
        max_fee: 0.0001 * 2 * 2,
        reduceOnly: true,
        timeInForce: "ioc",
      },
    )
  })

  it("rejects trading when subaccount id is missing", async () => {
    const client = new DeriveTradingClient({
      ...credentials(),
      subaccountId: null,
    })
    vi.spyOn(client, "resolveSymbol").mockReturnValue(
      Effect.succeed("ETH/USD:USDC"),
    )

    const outcome = await Effect.runPromise(
      Effect.either(
        client.createOrdersBatch([
          { symbol: "ETH-PERP", side: "buy", amount: 1, price: 10 },
        ]),
      ),
    )
    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { _tag: "DeriveSubaccountMissing" },
    })
  })
})

describe("DeriveTradingClient.placeAndMonitorOrders", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("returns open createOrder results as working without watching fills", async () => {
    const createOrder = vi.fn().mockResolvedValue({
      id: "order-1",
      symbol: "ETH/USD:USDC",
      side: "buy",
      status: "open",
      info: { order_status: "open" },
    })

    const client = new DeriveTradingClient(credentials())
    const exchange = (
      client as unknown as {
        exchange: {
          loadMarkets: () => Promise<Record<string, never>>
          markets: Record<string, { symbol: string; swap: boolean }>
          markets_by_id: Record<string, { symbol: string }>
          createOrder: typeof createOrder
          watchOrders?: unknown
        }
      }
    ).exchange

    exchange.loadMarkets = vi.fn().mockResolvedValue({})
    exchange.markets = {
      "ETH/USD:USDC": { symbol: "ETH/USD:USDC", swap: true },
    }
    exchange.markets_by_id = {}
    exchange.createOrder = createOrder
    exchange.watchOrders = vi.fn()
    vi.spyOn(client, "resolveSymbol").mockReturnValue(
      Effect.succeed("ETH/USD:USDC"),
    )

    const results = await Effect.runPromise(
      client.placeAndMonitorOrders([
        { symbol: "ETH-PERP", side: "buy", amount: 0.01, price: 2000 },
      ]),
    )

    expect(results).toEqual([
      {
        symbol: "ETH-PERP",
        side: "buy",
        status: "working",
        message: null,
      },
    ])
    expect(exchange.watchOrders).not.toHaveBeenCalled()
  })
})

describe("DeriveTradingClient.cancelOrder", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("cancels by id with subaccount params and resolved symbol", async () => {
    const cancelOrder = vi.fn().mockResolvedValue({
      id: "order-1",
      symbol: "ETH/USD:USDC-250925-2000-C",
      status: "canceled",
    })

    const client = new DeriveTradingClient(credentials())
    const exchange = (
      client as unknown as {
        exchange: {
          loadMarkets: () => Promise<Record<string, never>>
          markets: Record<string, { symbol: string }>
          markets_by_id: Record<string, { symbol: string }>
          cancelOrder: typeof cancelOrder
        }
      }
    ).exchange

    exchange.loadMarkets = vi.fn().mockResolvedValue({})
    exchange.markets = {
      "ETH/USD:USDC-250925-2000-C": { symbol: "ETH/USD:USDC-250925-2000-C" },
    }
    exchange.markets_by_id = {}
    exchange.cancelOrder = cancelOrder
    vi.spyOn(client, "resolveSymbol").mockReturnValue(
      Effect.succeed("ETH/USD:USDC-250925-2000-C"),
    )

    await Effect.runPromise(
      client.cancelOrder("order-1", "ETH-20250925-2000-C"),
    )

    expect(cancelOrder).toHaveBeenCalledWith(
      "order-1",
      "ETH/USD:USDC-250925-2000-C",
      { subaccount_id: 144457 },
    )
  })
})
