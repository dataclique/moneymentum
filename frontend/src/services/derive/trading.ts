import * as EffectArray from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

import { ExchangeRequestError } from "@/services/hyperliquid"
import type { OrderResult, OrderSide } from "@/services/hyperliquid-client"

import {
  createDeriveExchange,
  type DeriveCcxtExchange,
  type DeriveCcxtMarket,
  type DeriveCcxtOrder,
  type DeriveCcxtTicker,
} from "./exchange"
import {
  parseDeriveNumeric,
  requireDeriveSession,
  type DeriveSessionCredentials,
  DeriveSessionMissing,
  DeriveSubaccountMissing,
} from "./session"

export class DeriveInstrumentNotFound extends Data.TaggedError(
  "DeriveInstrumentNotFound",
)<{
  readonly instrument: string
}> {}

export class DeriveOrderSizeInvalid extends Data.TaggedError(
  "DeriveOrderSizeInvalid",
)<{
  readonly symbol: string
  readonly amount: number
  readonly amountStep: number
}> {}

export class DeriveOrderPriceInvalid extends Data.TaggedError(
  "DeriveOrderPriceInvalid",
)<{
  readonly symbol: string
  readonly price: number
}> {}

const DERIVE_ORDER_NONCE_GAP_MS = 2
/** Derive always requires max_fee; ~2x notional matches the UI default for options. */
const DEFAULT_MAX_FEE_NOTIONAL_MULTIPLIER = 2
/** Venue error 11012: amount must be a multiple of this step when market metadata is missing. */
export const DEFAULT_DERIVE_AMOUNT_STEP = 0.00001

const FILLED_STATUSES = new Set(["filled", "closed"])
const OPEN_STATUSES = new Set(["open", "triggered", "untriggered", "working"])

export interface DeriveBatchOrderRequest {
  /** CCXT unified symbol or Derive instrument_name (e.g. ETH-20260925-2000-C). */
  symbol: string
  side: OrderSide
  amount: number
  price: number
  type?: "limit" | "market"
  maxFee?: number
  reduceOnly?: boolean
}

/** A received submission response, not confirmation of fills or settlement. */
export interface DeriveSubmittedOrder {
  readonly request: Readonly<DeriveBatchOrderRequest>
  readonly order: Readonly<DeriveCcxtOrder>
}

/** Retains prior responses and the unattempted suffix when a batch stops. */
export class DerivePartialBatchFailure extends Data.TaggedError(
  "DerivePartialBatchFailure",
)<{
  readonly submittedOrders: readonly [
    DeriveSubmittedOrder,
    ...DeriveSubmittedOrder[],
  ]
  readonly failedRequest: Readonly<DeriveBatchOrderRequest>
  readonly unattemptedRequests: readonly Readonly<DeriveBatchOrderRequest>[]
  readonly cause: TradingExchangeFailure
}> {}

/** Accepted prefix retained when wallet/session context changes mid-batch. */
export class DeriveBatchSessionCancelled extends Data.TaggedError(
  "DeriveBatchSessionCancelled",
)<{
  readonly submittedOrders: readonly [
    DeriveSubmittedOrder,
    ...DeriveSubmittedOrder[],
  ]
  readonly unattemptedRequests: readonly Readonly<DeriveBatchOrderRequest>[]
}> {}

export type DeriveOrderBatchAccepted = {
  readonly kind: "accepted"
  readonly orderId: string
}

/** Mutation result when a live session guard stops further submissions. */
export type DeriveCancelledOrderBatch = {
  readonly terminal: "cancelled"
  readonly outcomes: readonly DeriveOrderBatchAccepted[]
  readonly orders: readonly OrderResult[]
}

export type DerivePlaceOrdersResult = OrderResult[] | DeriveCancelledOrderBatch

export const isDeriveCancelledOrderBatch = (
  value: DerivePlaceOrdersResult,
): value is DeriveCancelledOrderBatch => !Array.isArray(value)

/** Optional live check; default keeps the batch running to completion. */
export type DeriveSessionGuard = {
  readonly isSessionCurrent: () => boolean
}

export interface DeriveTickerQuote {
  symbol: string
  bid: number | null
  ask: number | null
  last: number | null
  mark: number | null
}

export interface DeriveFundingRateQuote {
  symbol: string
  fundingRate: number
}

export const isCcxtRequestTimeout = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false
  }
  const name =
    "name" in error && typeof error.name === "string" ? error.name : ""
  const message = error instanceof Error ? error.message : ""
  return (
    name === "RequestTimeout" ||
    message.includes("timed out") ||
    message.includes("request timed out")
  )
}

const amountsMatch = (left: number, right: number): boolean =>
  Math.abs(left - right) <= Math.max(1e-8, Math.abs(right) * 1e-8)

const pricesMatch = (left: number, right: number): boolean =>
  Math.abs(left - right) <= Math.max(1e-6, Math.abs(right) * 1e-6)

const orderMarketId = (order: DeriveCcxtOrder): string => {
  const instrumentName = order.info?.instrument_name
  return typeof instrumentName === "string" && instrumentName.length > 0
    ? instrumentName
    : ""
}

const orderMatchesRequest = (
  order: DeriveCcxtOrder,
  symbol: string,
  request: DeriveBatchOrderRequest,
  marketId: string,
): boolean => {
  const orderSymbol = typeof order.symbol === "string" ? order.symbol : ""
  if (orderSymbol !== symbol || orderSymbol !== request.symbol) {
    return false
  }
  if (marketId.length > 0 && orderMarketId(order) !== marketId) {
    return false
  }
  if (order.side !== request.side) {
    return false
  }
  if (
    order.amount !== undefined &&
    !amountsMatch(order.amount, request.amount)
  ) {
    return false
  }
  if (order.price !== undefined && !pricesMatch(order.price, request.price)) {
    return false
  }
  return true
}

const positivePriceOrNull = (
  value: number | null | undefined,
): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null

const decimalPlacesFromStep = (step: number): number => {
  const exponential = step.toExponential()
  const scientific = /^(-?\d+(?:\.\d+)?)e-(\d+)$/i.exec(exponential)
  if (scientific !== null) {
    const mantissa = scientific[1]
    const exponent = Number(scientific[2])
    const fractionalDigits = mantissa.includes(".")
      ? mantissa.split(".")[1].length
      : 0
    const digits = exponent + fractionalDigits
    return Number.isFinite(digits) ? digits : 8
  }
  const fraction = String(step).split(".")
  return fraction.length < 2 ? 0 : (fraction[1] ?? "").length
}

/** Round `value` to the nearest multiple of `step` (Derive amount_step / tick). */
export const snapToDeriveStep = (value: number, step: number): number => {
  if (!(value > 0) || !(step > 0)) {
    return 0
  }
  const units = Math.round(value / step)
  return Number((units * step).toFixed(decimalPlacesFromStep(step)))
}

const readMarketAmountStep = (market: DeriveCcxtMarket | undefined): number => {
  const fromPrecision = market?.precision?.amount
  if (typeof fromPrecision === "number" && fromPrecision > 0) {
    return fromPrecision
  }
  const fromInfo = parseDeriveNumeric(market?.info?.amount_step, Number.NaN)
  return fromInfo > 0 ? fromInfo : DEFAULT_DERIVE_AMOUNT_STEP
}

const readMarketPriceStep = (
  market: DeriveCcxtMarket | undefined,
): number | null => {
  const fromPrecision = market?.precision?.price
  if (typeof fromPrecision === "number" && fromPrecision > 0) {
    return fromPrecision
  }
  const fromInfo = parseDeriveNumeric(market?.info?.tick_size, Number.NaN)
  return fromInfo > 0 ? fromInfo : null
}

const readOrderStatus = (order: DeriveCcxtOrder): string => {
  const info: unknown = order.info
  if (typeof info === "object" && info !== null) {
    const orderStatus = (info as { order_status?: unknown }).order_status
    if (typeof orderStatus === "string" && orderStatus.length > 0) {
      return orderStatus
    }
    const status = (info as { status?: unknown }).status
    if (typeof status === "string" && status.length > 0) {
      return status
    }
  }
  return typeof order.status === "string" ? order.status : ""
}

export const mapDeriveOrderForWatch = (
  order: DeriveCcxtOrder,
): { status: OrderResult["status"]; message: string | null } => {
  const status = readOrderStatus(order).toLowerCase()

  if (FILLED_STATUSES.has(status)) {
    return { status: "filled", message: null }
  }

  if (
    status === "cancelled" ||
    status === "canceled" ||
    status === "rejected" ||
    status === "expired"
  ) {
    return {
      status: "failed",
      message: `Order ${status}`,
    }
  }

  if (OPEN_STATUSES.has(status) || status === "") {
    return { status: "working", message: null }
  }

  return {
    status: "working",
    message: `Unknown order status: ${status}`,
  }
}

const defaultMaxFee = (price: number, amount: number): number =>
  Math.abs(price * amount * DEFAULT_MAX_FEE_NOTIONAL_MULTIPLIER)

const requireSubaccountId = (
  credentials: DeriveSessionCredentials,
): Effect.Effect<number, DeriveSubaccountMissing> =>
  credentials.subaccountId === null
    ? Effect.fail(new DeriveSubaccountMissing())
    : Effect.succeed(credentials.subaccountId)

/** Lazy, interruptible sequencing around CCXT's external Promise boundaries. */
export class DeriveTradingClient {
  private readonly exchange: DeriveCcxtExchange
  private readonly credentials: DeriveSessionCredentials
  private readonly isSessionCurrent: () => boolean
  private marketsLoad: Promise<void> | null = null

  constructor(
    credentials: DeriveSessionCredentials,
    sessionGuard?: DeriveSessionGuard,
  ) {
    this.credentials = credentials
    this.exchange = createDeriveExchange(credentials)
    this.isSessionCurrent = sessionGuard?.isSessionCurrent ?? (() => true)
  }

  private subaccountParams(): Effect.Effect<
    { subaccount_id: number },
    DeriveSubaccountMissing
  > {
    return requireSubaccountId(this.credentials).pipe(
      Effect.map(subaccount_id => ({ subaccount_id })),
    )
  }

  private ensureMarketsLoaded(): Effect.Effect<void, TradingExchangeFailure> {
    return wrapExchange(() => {
      this.marketsLoad ??= this.exchange.loadMarkets().then(
        () => undefined,
        (cause: unknown) => {
          this.marketsLoad = null
          return Promise.reject(tradingFailure(cause))
        },
      )
      return this.marketsLoad
    })
  }

  private marketsByIdEntry(
    instrumentName: string,
  ): DeriveCcxtMarket | undefined {
    const entry = this.exchange.markets_by_id?.[instrumentName]
    if (entry === undefined) {
      return undefined
    }
    return Array.isArray(entry) ? entry[0] : entry
  }

  /** Resolve an existing symbol or hydrate an option beyond CCXT's first page. */
  resolveSymbol(
    instrumentOrSymbol: string,
  ): Effect.Effect<string, TradingExchangeFailure> {
    return Effect.gen(this, function* () {
      yield* this.ensureMarketsLoaded()
      const markets = this.exchange.markets ?? {}
      if (instrumentOrSymbol in markets) {
        return instrumentOrSymbol
      }
      const byId = this.marketsByIdEntry(instrumentOrSymbol)
      if (byId !== undefined) {
        return byId.symbol
      }
      const response = yield* wrapExchange(() =>
        this.exchange.publicPostGetInstrument({
          instrument_name: instrumentOrSymbol,
        }),
      )
      if (response.result === undefined || response.result === null) {
        return yield* Effect.fail(
          new DeriveInstrumentNotFound({ instrument: instrumentOrSymbol }),
        )
      }
      const market = yield* wrapExchangeSync(() =>
        this.exchange.parseMarket(response.result),
      )
      yield* wrapExchangeSync(() => {
        this.exchange.setMarkets([...Object.values(markets), market])
      })
      return market.symbol
    })
  }

  fetchTickers(
    instrumentsOrSymbols: string[],
  ): Effect.Effect<Record<string, DeriveTickerQuote>, TradingExchangeFailure> {
    return Effect.forEach(
      [...new Set(instrumentsOrSymbols)],
      instrumentOrSymbol =>
        Effect.gen(this, function* () {
          const symbol = yield* this.resolveSymbol(instrumentOrSymbol)
          const ticker: DeriveCcxtTicker = yield* wrapExchange(() =>
            this.exchange.fetchTicker(symbol),
          )
          const info = ticker.info as
            | {
                mark_price?: unknown
                option_pricing?: { m?: unknown; mark_price?: unknown }
              }
            | undefined
          const markFromInfo = parseDeriveNumeric(info?.mark_price, Number.NaN)
          const modelMark = parseDeriveNumeric(
            info?.option_pricing?.m ?? info?.option_pricing?.mark_price,
            Number.NaN,
          )
          const quote: DeriveTickerQuote = {
            symbol,
            bid: positivePriceOrNull(ticker.bid),
            ask: positivePriceOrNull(ticker.ask),
            last: positivePriceOrNull(ticker.last ?? ticker.close ?? null),
            mark:
              positivePriceOrNull(ticker.mark) ??
              positivePriceOrNull(markFromInfo) ??
              positivePriceOrNull(modelMark),
          }
          return [instrumentOrSymbol, quote] as const
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.map(entries => Object.fromEntries(entries)))
  }

  /** Hourly funding for perps; option instruments have no funding rate. */
  fetchFundingRates(
    instrumentsOrSymbols: string[],
  ): Effect.Effect<
    Record<string, DeriveFundingRateQuote>,
    TradingExchangeFailure
  > {
    return Effect.forEach(
      [...new Set(instrumentsOrSymbols)],
      instrumentOrSymbol =>
        Effect.gen(this, function* () {
          const symbol = yield* this.resolveSymbol(instrumentOrSymbol)
          const market = yield* wrapExchangeSync(() =>
            this.exchange.market(symbol),
          )
          if (market.option === true || market.swap !== true) {
            return null
          }
          const funding = yield* wrapExchange(() =>
            this.exchange.fetchFundingRate(symbol),
          )
          const rate = funding.fundingRate
          if (rate === undefined || !Number.isFinite(rate)) {
            return null
          }
          return [
            instrumentOrSymbol,
            { symbol, fundingRate: rate } satisfies DeriveFundingRateQuote,
          ] as const
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(entries =>
        Object.fromEntries(
          entries.flatMap(entry => (entry === null ? [] : [entry])),
        ),
      ),
    )
  }

  private lookupMarket(symbol: string): DeriveCcxtMarket | undefined {
    if (typeof this.exchange.market !== "function") {
      return undefined
    }
    try {
      return this.exchange.market(symbol)
    } catch {
      return undefined
    }
  }

  private createOne(
    request: DeriveBatchOrderRequest,
    index: number,
    total: number,
  ): Effect.Effect<DeriveCcxtOrder, TradingExchangeFailure> {
    return Effect.gen(this, function* () {
      const symbol = yield* this.resolveSymbol(request.symbol)
      const market = this.lookupMarket(symbol)
      const amountStep = readMarketAmountStep(market)
      const amount = snapToDeriveStep(request.amount, amountStep)
      const priceStep = readMarketPriceStep(market)
      const price =
        priceStep === null
          ? request.price
          : snapToDeriveStep(request.price, priceStep)
      if (!Number.isFinite(amount) || !(amount > 0)) {
        console.debug("[derive] order rejected locally", {
          index,
          total,
          field: "amount",
        })
        return yield* Effect.fail(
          new DeriveOrderSizeInvalid({
            symbol: request.symbol,
            amount: request.amount,
            amountStep,
          }),
        )
      }
      if (!Number.isFinite(price) || !(price > 0)) {
        console.debug("[derive] order rejected locally", {
          index,
          total,
          field: "price",
        })
        return yield* Effect.fail(
          new DeriveOrderPriceInvalid({
            symbol: request.symbol,
            price: request.price,
          }),
        )
      }
      const maxFee = request.maxFee ?? defaultMaxFee(price, amount)
      const subaccount = yield* this.subaccountParams()
      const params = {
        ...subaccount,
        max_fee: maxFee,
        ...(request.reduceOnly === true ? { reduceOnly: true } : {}),
      }
      const sent: DeriveBatchOrderRequest = {
        ...request,
        symbol,
        amount,
        price,
        maxFee,
      }
      const created = yield* wrapExchange(() =>
        this.exchange.createOrder(
          symbol,
          request.type ?? "limit",
          request.side,
          amount,
          price,
          params,
        ),
      ).pipe(
        Effect.catchAll(error => {
          const cause =
            error instanceof ExchangeRequestError ? error.cause : error
          if (!isCcxtRequestTimeout(cause)) {
            return Effect.fail(error)
          }
          return this.recoverTimedOutOrder(symbol, sent, market?.id ?? "").pipe(
            Effect.flatMap(recovered =>
              recovered === null
                ? Effect.fail(error)
                : Effect.succeed(recovered),
            ),
          )
        }),
      )
      console.debug("[derive] order accepted", { index, total })
      return created
    })
  }

  private recoverTimedOutOrder(
    symbol: string,
    request: DeriveBatchOrderRequest,
    marketId: string,
  ): Effect.Effect<DeriveCcxtOrder | null, TradingExchangeFailure> {
    return this.fetchOpenOrders().pipe(
      Effect.map(
        openOrders =>
          openOrders.find(order =>
            orderMatchesRequest(order, symbol, request, marketId),
          ) ?? null,
      ),
    )
  }

  private submitBatch(
    requests: DeriveBatchOrderRequest[],
  ): Effect.Effect<
    Array<{ request: DeriveBatchOrderRequest; order: DeriveCcxtOrder }>,
    TradingBatchFailure | DeriveBatchSessionCancelled
  > {
    return Effect.gen(this, function* () {
      if (requests.length === 0) {
        return []
      }
      yield* requireSubaccountId(this.credentials)
      const initial: Array<{
        request: DeriveBatchOrderRequest
        order: DeriveCcxtOrder
      }> = []
      const submitted = yield* Effect.reduce(
        requests,
        initial,
        (responses, request) =>
          Effect.gen(this, function* () {
            const index = responses.length
            if (index > 0) {
              const sessionCurrent = yield* Effect.sync(() =>
                this.isSessionCurrent(),
              )
              if (!sessionCurrent && EffectArray.isNonEmptyArray(responses)) {
                const unattemptedRequests = requests.slice(index)
                yield* Effect.sync(() => {
                  console.debug("[derive] order batch stopped", {
                    terminal: "cancelled",
                    accepted: responses.length,
                    unattemptedCount: unattemptedRequests.length,
                  })
                })
                return yield* Effect.fail(
                  new DeriveBatchSessionCancelled({
                    submittedOrders: responses,
                    unattemptedRequests,
                  }),
                )
              }
              yield* Effect.sleep(DERIVE_ORDER_NONCE_GAP_MS)
            }
            const order = yield* this.createOne(
              request,
              index,
              requests.length,
            ).pipe(
              Effect.catchAll(
                (
                  cause,
                ): Effect.Effect<
                  never,
                  TradingBatchFailure | DeriveBatchSessionCancelled
                > => {
                  if (!EffectArray.isNonEmptyArray(responses)) {
                    return Effect.fail(cause)
                  }
                  const unattemptedRequests = requests.slice(index + 1)
                  return Effect.sync(() => {
                    console.warn("[derive] order batch stopped", {
                      submittedCount: responses.length,
                      failedIndex: index,
                      unattemptedCount: unattemptedRequests.length,
                      causeTag: cause._tag,
                    })
                  }).pipe(
                    Effect.zipRight(
                      Effect.fail(
                        new DerivePartialBatchFailure({
                          submittedOrders: responses,
                          failedRequest: request,
                          unattemptedRequests,
                          cause,
                        }),
                      ),
                    ),
                  )
                },
              ),
            )
            return [...responses, { request, order }]
          }),
      )
      console.debug("[derive] order batch completed", {
        count: submitted.length,
      })
      return submitted
    })
  }

  /** Sequential placement with interruptible gaps between venue nonces. */
  createOrdersBatch(
    requests: DeriveBatchOrderRequest[],
  ): Effect.Effect<
    DeriveCcxtOrder[],
    TradingBatchFailure | DeriveBatchSessionCancelled
  > {
    return this.submitBatch(requests).pipe(
      Effect.map(submitted => submitted.map(({ order }) => order)),
    )
  }

  private orderResultFromCreated(
    order: DeriveCcxtOrder,
    request: DeriveBatchOrderRequest,
  ): OrderResult {
    const mapped = mapDeriveOrderForWatch(order)
    const side =
      order.side === "buy" || order.side === "sell" ? order.side : request.side
    return {
      symbol: request.symbol,
      side,
      status: mapped.status,
      message: mapped.message,
    }
  }

  /** Return create responses without treating working orders as confirmed fills. */
  placeAndMonitorOrders(
    requests: DeriveBatchOrderRequest[],
  ): Effect.Effect<
    OrderResult[],
    TradingBatchFailure | DeriveBatchSessionCancelled
  > {
    return this.submitBatch(requests).pipe(
      Effect.map(submitted =>
        submitted.map(({ order, request }) =>
          this.orderResultFromCreated(order, request),
        ),
      ),
    )
  }

  fetchOpenOrders(): Effect.Effect<DeriveCcxtOrder[], TradingExchangeFailure> {
    return this.subaccountParams().pipe(
      Effect.flatMap(params =>
        wrapExchange(() =>
          this.exchange.fetchOpenOrders(
            undefined,
            undefined,
            undefined,
            params,
          ),
        ),
      ),
    )
  }

  cancelOrder(
    id: string,
    symbol: string,
  ): Effect.Effect<DeriveCcxtOrder, TradingExchangeFailure> {
    return Effect.gen(this, function* () {
      const resolvedSymbol = yield* this.resolveSymbol(symbol)
      const params = yield* this.subaccountParams()
      return yield* wrapExchange(() =>
        this.exchange.cancelOrder(id, resolvedSymbol, params),
      )
    })
  }
}

type TradingExchangeFailure =
  | ExchangeRequestError
  | DeriveSubaccountMissing
  | DeriveInstrumentNotFound
  | DeriveOrderSizeInvalid
  | DeriveOrderPriceInvalid

type TradingBatchFailure = TradingExchangeFailure | DerivePartialBatchFailure

const tradingFailure = (cause: unknown): TradingExchangeFailure =>
  cause instanceof ExchangeRequestError ||
  cause instanceof DeriveSubaccountMissing ||
  cause instanceof DeriveInstrumentNotFound ||
  cause instanceof DeriveOrderSizeInvalid ||
  cause instanceof DeriveOrderPriceInvalid
    ? cause
    : new ExchangeRequestError({ cause })

const wrapExchange = <Value>(
  run: () => Promise<Value>,
): Effect.Effect<Value, TradingExchangeFailure> =>
  Effect.tryPromise({ try: run, catch: tradingFailure })

const wrapExchangeSync = <Value>(
  run: () => Value,
): Effect.Effect<Value, TradingExchangeFailure> =>
  Effect.try({ try: run, catch: tradingFailure })

const observeInterruption = <Value, Failure>(
  operation:
    | "tickers"
    | "fundingRates"
    | "placeOrders"
    | "openOrders"
    | "cancelOrder",
  program: Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure> =>
  program.pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        console.debug("[derive] trading operation interrupted", { operation })
      }),
    ),
  )

let cachedTradingClient: {
  key: string
  client: DeriveTradingClient
  sessionGuard: DeriveSessionGuard | undefined
} | null = null

const tradingClientCacheKey = (session: DeriveSessionCredentials): string =>
  [
    session.networkMode,
    session.deriveWallet,
    session.sessionAddress,
    session.sessionPrivateKey,
    String(session.subaccountId),
  ].join(":")

const tradingClientFor = (
  session: DeriveSessionCredentials,
  sessionGuard?: DeriveSessionGuard,
): DeriveTradingClient => {
  const key = tradingClientCacheKey(session)
  if (
    cachedTradingClient !== null &&
    cachedTradingClient.key === key &&
    cachedTradingClient.sessionGuard === sessionGuard
  ) {
    return cachedTradingClient.client
  }
  const client = new DeriveTradingClient(session, sessionGuard)
  cachedTradingClient = { key, client, sessionGuard }
  return client
}

export const fetchDeriveTickers = (
  credentials: DeriveSessionCredentials | null,
  instrumentsOrSymbols: string[],
): Effect.Effect<
  Record<string, DeriveTickerQuote>,
  DeriveSessionMissing | TradingExchangeFailure
> =>
  observeInterruption(
    "tickers",
    requireDeriveSession(credentials).pipe(
      Effect.flatMap(session =>
        tradingClientFor(session).fetchTickers(instrumentsOrSymbols),
      ),
    ),
  )

export const fetchDeriveFundingRates = (
  credentials: DeriveSessionCredentials | null,
  instrumentsOrSymbols: string[],
): Effect.Effect<
  Record<string, DeriveFundingRateQuote>,
  DeriveSessionMissing | TradingExchangeFailure
> =>
  observeInterruption(
    "fundingRates",
    requireDeriveSession(credentials).pipe(
      Effect.flatMap(session =>
        tradingClientFor(session).fetchFundingRates(instrumentsOrSymbols),
      ),
    ),
  )

const cancelledBatchFromSubmitted = (
  submittedOrders: readonly [DeriveSubmittedOrder, ...DeriveSubmittedOrder[]],
): DeriveCancelledOrderBatch => {
  const orders = submittedOrders.map(({ order, request }) => {
    const mapped = mapDeriveOrderForWatch(order)
    const side =
      order.side === "buy" || order.side === "sell" ? order.side : request.side
    return {
      symbol: request.symbol,
      side,
      status: mapped.status,
      message: mapped.message,
    } satisfies OrderResult
  })
  return {
    terminal: "cancelled",
    outcomes: submittedOrders.map(({ order }) => ({
      kind: "accepted" as const,
      orderId: order.id ?? "",
    })),
    orders,
  }
}

export const placeAndMonitorDeriveOrders = (
  credentials: DeriveSessionCredentials | null,
  requests: DeriveBatchOrderRequest[],
  sessionGuard?: DeriveSessionGuard,
): Effect.Effect<
  DerivePlaceOrdersResult,
  DeriveSessionMissing | TradingBatchFailure
> =>
  observeInterruption(
    "placeOrders",
    requireDeriveSession(credentials).pipe(
      Effect.flatMap(session =>
        tradingClientFor(session, sessionGuard)
          .placeAndMonitorOrders(requests)
          .pipe(
            Effect.catchTag("DeriveBatchSessionCancelled", cancelled =>
              Effect.succeed(
                cancelledBatchFromSubmitted(cancelled.submittedOrders),
              ),
            ),
          ),
      ),
    ),
  )

export const fetchDeriveOpenOrders = (
  credentials: DeriveSessionCredentials | null,
): Effect.Effect<
  DeriveCcxtOrder[],
  DeriveSessionMissing | TradingExchangeFailure
> =>
  observeInterruption(
    "openOrders",
    requireDeriveSession(credentials).pipe(
      Effect.flatMap(session => tradingClientFor(session).fetchOpenOrders()),
    ),
  )

export const cancelDeriveOrder = (
  credentials: DeriveSessionCredentials | null,
  request: { id: string; symbol: string },
): Effect.Effect<
  DeriveCcxtOrder,
  DeriveSessionMissing | TradingExchangeFailure
> =>
  observeInterruption(
    "cancelOrder",
    requireDeriveSession(credentials).pipe(
      Effect.flatMap(session =>
        tradingClientFor(session).cancelOrder(request.id, request.symbol),
      ),
    ),
  )
