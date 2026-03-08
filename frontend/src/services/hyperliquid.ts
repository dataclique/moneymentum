import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type {
  HyperliquidClient,
  CurrentPosition,
  LeverageLimit,
  OrderResult,
  Position,
} from "./hyperliquid-client"

export class WalletNotConnected extends Data.TaggedError("WalletNotConnected")<
  Record<string, never>
> {}

export class ExchangeRequestError extends Data.TaggedError(
  "ExchangeRequestError",
)<{
  readonly cause: unknown
}> {}

export class PriceFetchError extends Data.TaggedError("PriceFetchError")<{
  readonly symbol: string
  readonly cause: unknown
}> {}

const wrapExchange = <A>(
  fn: () => Promise<A>,
): Effect.Effect<A, ExchangeRequestError> =>
  Effect.tryPromise({
    try: fn,
    catch: cause => new ExchangeRequestError({ cause }),
  })

const requireClient = (
  client: HyperliquidClient | null,
): Effect.Effect<HyperliquidClient, WalletNotConnected> =>
  client ? Effect.succeed(client) : Effect.fail(new WalletNotConnected())

export const getBalance = (
  client: HyperliquidClient | null,
): Effect.Effect<number, WalletNotConnected | ExchangeRequestError> =>
  requireClient(client).pipe(
    Effect.flatMap(hyperliquid => wrapExchange(() => hyperliquid.getBalance())),
  )

export interface AccountSummary {
  accountValue: number
  totalNotionalPosition: number
  withdrawable: number
}

export const getAccountSummary = (
  client: HyperliquidClient | null,
): Effect.Effect<AccountSummary, WalletNotConnected | ExchangeRequestError> =>
  requireClient(client).pipe(
    Effect.flatMap(hyperliquid =>
      wrapExchange(() => hyperliquid.getAccountSummary()),
    ),
  )

export const getCurrentPositions = (
  client: HyperliquidClient | null,
): Effect.Effect<
  CurrentPosition[],
  WalletNotConnected | ExchangeRequestError
> =>
  requireClient(client).pipe(
    Effect.flatMap(hyperliquid =>
      wrapExchange(() => hyperliquid.getCurrentPositions()),
    ),
  )

export const listPerpTickers = (
  client: HyperliquidClient | null,
): Effect.Effect<string[], WalletNotConnected | ExchangeRequestError> =>
  requireClient(client).pipe(
    Effect.flatMap(hyperliquid =>
      wrapExchange(() => hyperliquid.listPerpTickers()),
    ),
  )

export const getLeverageLimits = (
  client: HyperliquidClient | null,
): Effect.Effect<LeverageLimit[], WalletNotConnected | ExchangeRequestError> =>
  requireClient(client).pipe(
    Effect.flatMap(hyperliquid =>
      wrapExchange(() => hyperliquid.getLeverageLimits()),
    ),
  )

export const getFundingRates = (
  client: HyperliquidClient | null,
): Effect.Effect<
  Record<string, number>,
  WalletNotConnected | ExchangeRequestError
> =>
  requireClient(client).pipe(
    Effect.flatMap(hyperliquid =>
      wrapExchange(() => hyperliquid.getFundingRates()),
    ),
  )

export const rebalancePositions = (
  client: HyperliquidClient | null,
  positions: Position[],
  accountValue: number,
  crossAccountLeverage: number,
  precise: boolean,
): Effect.Effect<OrderResult[], WalletNotConnected | ExchangeRequestError> =>
  requireClient(client).pipe(
    Effect.flatMap(hyperliquid =>
      wrapExchange(() =>
        hyperliquid.rebalancePositions(
          positions,
          accountValue,
          crossAccountLeverage,
          precise,
        ),
      ),
    ),
  )
