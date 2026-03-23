import ccxt, { type Order, type OrderRequest } from "ccxt"
import { pro } from "ccxt"
import type { NetworkMode, WalletCredentials } from "@/contexts/wallet-context"
import type { RebalanceAction } from "@/pages/Portfolio/hooks/portfolioRebalancer"

const MARKETS_CACHE_KEY = "hyperliquid_markets_cache"
const MARKETS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const HYPERLIQUID_MAINNET_INFO_URL = "https://api.hyperliquid.xyz/info"
const HYPERLIQUID_TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info"

interface MarketsCache {
  markets: Record<string, unknown>
  timestamp: number
  networkMode: NetworkMode
}

const isDeployed = (): boolean =>
  typeof window !== "undefined" && window.location.hostname !== "localhost"

const applyApiProxy = (
  exchange: HyperliquidExchange,
  networkMode: NetworkMode,
): void => {
  if (!isDeployed()) return
  const proxyBase = networkMode === "testnet" ? "/hl-testnet" : "/hl"
  exchange.urls["api"] = { public: proxyBase, private: proxyBase }
}

const createTempExchange = (networkMode: NetworkMode): HyperliquidExchange => {
  const HyperliquidClass = pro.hyperliquid as unknown as new (
    config: Record<string, unknown>,
  ) => HyperliquidExchange

  const exchange = new HyperliquidClass({
    enableRateLimit: true,
  })

  if (networkMode === "testnet") {
    exchange.setSandboxMode(true)
  }

  applyApiProxy(exchange, networkMode)

  return exchange
}

const getCachedMarkets = (
  networkMode: NetworkMode,
): Record<string, unknown> | null => {
  try {
    const cached = localStorage.getItem(MARKETS_CACHE_KEY)
    if (!cached) {
      return null
    }

    const parsed: MarketsCache = JSON.parse(cached) as MarketsCache
    const { markets, timestamp, networkMode: cachedMode } = parsed

    if (cachedMode !== networkMode) {
      return null
    }

    const ageMs = Date.now() - timestamp
    if (ageMs >= MARKETS_CACHE_TTL_MS) {
      return null
    }

    return markets
  } catch {
    return null
  }
}

const setCachedMarkets = (
  markets: Record<string, unknown>,
  networkMode: NetworkMode,
): void => {
  const cacheData: MarketsCache = {
    markets,
    timestamp: Date.now(),
    networkMode,
  }
  localStorage.setItem(MARKETS_CACHE_KEY, JSON.stringify(cacheData))
}

export const preloadMarkets = async (
  networkMode: NetworkMode,
): Promise<Record<string, unknown> | null> => {
  const cached = getCachedMarkets(networkMode)
  if (cached) {
    return cached
  }

  try {
    const tempExchange = createTempExchange(networkMode)
    const markets = await tempExchange.loadMarkets()

    setCachedMarkets(markets, networkMode)
    return markets
  } catch {
    // Network errors are expected when offline or API is unreachable
    // Markets will be loaded on-demand when needed
    return null
  }
}

export type OrderSide = "buy" | "sell"
export type PositionStatus =
  | "synced"
  | "modified"
  | "deleted"
  | "idle"
  | "working"

export interface Position {
  symbol: string
  notional: number
  side: OrderSide
  leverage: number
  leverageChanged: boolean
  currentNotional?: number
  currentSide?: OrderSide
  status: PositionStatus
}

export interface CurrentPosition {
  symbol: string
  side: OrderSide
  notional: number
  entryPrice: number
  unrealizedPnl: number
  leverage: number
}

export interface OrderResult {
  symbol: string
  side: OrderSide
  status: "working" | "filled" | "failed"
  message?: string | null
}

export interface LeverageLimit {
  symbol: string
  maxLeverage: number
}

// Minimum order size on Hyperliquid is $10, but we use $11 to guarantee orders will be opened
const MIN_ORDER_VALUE = 11.0
const SLIPPAGE = 0.05

interface HyperliquidExchange {
  setSandboxMode: (enabled: boolean) => void
  options: Record<string, unknown>
  urls: Record<string, string | Record<string, string>>
  walletAddress?: string
  loadMarkets: () => Promise<Record<string, unknown>>
  fetchBalance: () => Promise<{
    total: Record<string, unknown>
    info?: Record<string, unknown>
  }>
  fetchTickers: (
    symbols?: string[],
  ) => Promise<
    Record<
      string,
      { last?: number; bid?: number; ask?: number; info?: unknown }
    >
  >
  fetchTicker: (symbol: string) => Promise<{ last?: number }>
  fetchPositions: (symbols?: string[]) => Promise<
    Array<{
      symbol: string
      side: string
      contracts: number | string
      notional?: number | string
      entryPrice?: number | string
      unrealizedPnl?: number | string
      leverage?: number | string
    }>
  >
  setLeverage: (
    leverage: number,
    symbol: string,
    params?: Record<string, unknown>,
  ) => Promise<void>
  createOrder: (
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Record<string, unknown>,
  ) => Promise<unknown>
  createOrdersWs: (
    orders: OrderRequest[],
    params?: Record<string, unknown>,
  ) => Promise<Order[]> //TODO: fix return type and how we handle it
}

export class HyperliquidClient {
  private exchange: HyperliquidExchange
  private networkMode: NetworkMode
  private vaultAddress: string | undefined

  constructor(
    credentials: WalletCredentials,
    networkMode: NetworkMode,
    markets?: Record<string, unknown>,
  ) {
    this.networkMode = networkMode
    this.vaultAddress = credentials.vaultAddress

    const HyperliquidClass = pro.hyperliquid as unknown as new (
      config: Record<string, unknown>,
    ) => HyperliquidExchange

    // walletAddress is used for info requests (fetching positions/balance)
    // When trading on behalf of a vault, use vault address; otherwise use account address
    const effectiveWalletAddress =
      credentials.vaultAddress ?? credentials.accountAddress

    // Use pre-loaded markets if available, otherwise ccxt will load them on first use
    const cachedMarkets = markets ?? getCachedMarkets(networkMode)

    this.exchange = new HyperliquidClass({
      walletAddress: effectiveWalletAddress,
      privateKey: credentials.privateKey,
      enableRateLimit: true,
      ...(cachedMarkets && { markets: cachedMarkets }),
    })

    if (networkMode === "testnet") {
      this.exchange.setSandboxMode(true)
    }

    applyApiProxy(this.exchange, networkMode)

    this.exchange.options["builderFee"] = false
    this.exchange.options["approvedBuilderFee"] = false
    this.exchange.options["defaultSlippage"] = SLIPPAGE
    // Skip the setRef() call that wastes ~2.4 seconds trying to set a referral code
    this.exchange.options["refSet"] = true
  }

  async getFundingRates(): Promise<Record<string, number>> {
    const infoUrl =
      this.networkMode === "testnet"
        ? HYPERLIQUID_TESTNET_INFO_URL
        : HYPERLIQUID_MAINNET_INFO_URL

    const response = await fetch(infoUrl, {
      method: "POST",
      // Abort if the info endpoint is unresponsive for too long to avoid hanging the UI.
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch funding rates: ${response.statusText}`)
    }

    const json = (await response.json()) as unknown

    if (
      !Array.isArray(json) ||
      json.length < 2 ||
      typeof json[0] !== "object" ||
      json[0] === null ||
      !Array.isArray((json[0] as { universe?: unknown }).universe) ||
      !Array.isArray(json[1])
    ) {
      console.error(
        "[HyperliquidClient] Unexpected metaAndAssetCtxs payload shape",
        { json },
      )
      return {}
    }

    const [meta, assetCtxs] = json as [
      { universe: Array<{ name: string }> },
      Array<{ funding?: string | number } | null | undefined>,
    ]

    const fundingByBaseAsset: Record<string, number> = Object.fromEntries(
      meta.universe
        .map((asset, index) => {
          const assetCtx = assetCtxs[index]
          if (!assetCtx) return null

          const rawFunding = assetCtx.funding
          if (rawFunding === undefined) return null

          const parsedFundingRate = this.parseNumericValue(
            rawFunding,
            Number.NaN,
          )

          if (!Number.isFinite(parsedFundingRate)) return null

          return [asset.name, parsedFundingRate] as const
        })
        .filter((entry): entry is readonly [string, number] => entry !== null),
    )

    return fundingByBaseAsset
  }

  async getBalance(): Promise<number> {
    const balance = await this.exchange.fetchBalance()
    const usdc = balance.total["USDC"]
    if (usdc === undefined || usdc === null) return 0
    if (typeof usdc === "number") return usdc
    if (typeof usdc === "string") return parseFloat(usdc)
    return 0
  }

  async getAccountSummary(): Promise<{
    accountValue: number
    totalNotionalPosition: number
    withdrawable: number
  }> {
    const balance = await this.exchange.fetchBalance()
    const info = balance.info

    let accountValue = 0
    let totalNotionalPosition = 0
    let withdrawable = 0

    if (info?.marginSummary) {
      const marginSummary = info.marginSummary as Record<string, unknown>
      accountValue = this.parseNumericValue(marginSummary.accountValue, 0)
      totalNotionalPosition = this.parseNumericValue(
        marginSummary.totalNtlPos,
        0,
      )
    }

    if (info?.withdrawable !== undefined) {
      withdrawable = this.parseNumericValue(info.withdrawable, 0)
    }

    return { accountValue, totalNotionalPosition, withdrawable }
  }

  private parseNumericValue(value: unknown, fallback: number): number {
    if (value === undefined || value === null) return fallback
    if (typeof value === "number") return value
    if (typeof value === "string") return parseFloat(value)
    return fallback
  }

  async listPerpTickers(): Promise<string[]> {
    const markets = await this.exchange.loadMarkets()

    // Update cache with fresh markets data
    setCachedMarkets(markets, this.networkMode)

    const perpSymbols = Object.entries(markets)
      .filter(
        ([symbol, data]) =>
          symbol.includes(":") && (data as { swap?: boolean }).swap,
      )
      .map(([symbol]) => symbol)
      .sort()
    return perpSymbols
  }

  async getLeverageLimits(): Promise<LeverageLimit[]> {
    const tickers = await this.exchange.fetchTickers()
    const results: LeverageLimit[] = []

    for (const [symbol, ticker] of Object.entries(tickers)) {
      if (!symbol.includes(":")) continue

      let maxLeverage = 1.0
      if (ticker.info !== undefined && ticker.info !== null) {
        const info = ticker.info as Record<string, unknown>
        const rawMaxLeverage = info["maxLeverage"]
        if (typeof rawMaxLeverage === "number") {
          maxLeverage = rawMaxLeverage
        } else if (typeof rawMaxLeverage === "string") {
          maxLeverage = parseFloat(rawMaxLeverage)
        }
      }

      results.push({ symbol, maxLeverage })
    }

    return results.sort((a, b) => a.symbol.localeCompare(b.symbol))
  }

  async getCurrentPositions(): Promise<CurrentPosition[]> {
    const positions = await this.exchange.fetchPositions()
    const processed: CurrentPosition[] = []

    for (const pos of positions) {
      try {
        const notionalRaw = pos.notional
        if (notionalRaw === undefined) continue
        const notional =
          typeof notionalRaw === "number"
            ? notionalRaw
            : parseFloat(notionalRaw)
        if (notional <= 0) continue

        const parseNumeric = (value: unknown, fallback: number): number => {
          if (value === undefined || value === null) return fallback
          if (typeof value === "number") return value
          if (typeof value === "string") return parseFloat(value)
          return fallback
        }

        processed.push({
          symbol: pos.symbol,
          side: pos.side === "long" ? "buy" : "sell",
          notional,
          entryPrice: parseNumeric(pos.entryPrice, 0),
          unrealizedPnl: parseNumeric(pos.unrealizedPnl, 0),
          leverage: Math.round(parseNumeric(pos.leverage, 1)),
        })
      } catch {
        continue
      }
    }

    return processed
  }

  private signedNotional(side: OrderSide, notional: number): number {
    return side === "buy" ? notional : -notional
  }

  private async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.exchange.setLeverage(leverage, symbol, this.vaultParams)
  }

  private get vaultParams(): Record<string, unknown> | undefined {
    return this.vaultAddress ? { vaultAddress: this.vaultAddress } : undefined
  }

  async rebalancePositions(
    actions: RebalanceAction[],
    precise: boolean = false,
  ): Promise<OrderResult[]> {
    console.log("Rebalancing positions", {
      actionsCount: actions.length,
      precise,
    })
    await this.exchange.loadMarkets()
    const allSymbols = actions.map(a => a.symbol)

    //TODO: maybe need separate action
    for (const action of actions) {
      if ("leverageChanged" in action && action.leverageChanged) {
        await this.setLeverage(action.symbol, action.leverage)
      }
    }

    const [tickers, allCurrentPositions] = await Promise.all([
      this.exchange.fetchTickers(allSymbols),
      this.exchange.fetchPositions(),
    ])

    const orderRequests: any[] = actions
      .map(action => {
        const price = tickers[action.symbol]?.last
        if (!price) return null

        if (action.kind === "rebalance") {
          const side = action.notional > 0 ? "buy" : "sell"
          const amount = Math.abs(action.notional) / price

          return {
            symbol: action.symbol,
            type: "market",
            side: side,
            amount: amount,
            price:
              side === "buy" ? price * (1 + SLIPPAGE) : price * (1 - SLIPPAGE),
            params: { ...this.vaultParams },
          }
        }

        if (action.kind === "close") {
          const pos = allCurrentPositions.find(p => p.symbol === action.symbol)
          if (!pos) return null

          return {
            symbol: action.symbol,
            type: "market",
            side: action.side === "buy" ? "sell" : "buy",
            amount: Math.abs(parseFloat(String(pos.contracts))),
            price:
              action.side === "buy"
                ? price * (1 - SLIPPAGE)
                : price * (1 + SLIPPAGE),
            params: { reduceOnly: true, ...this.vaultParams },
          }
        }
        return null
      })
      .filter(Boolean)

    if (orderRequests.length === 0) return []

    const orderResults = await (this.exchange as any).createOrdersWs(
      orderRequests,
    )

    console.log("orderResults", orderResults)

    return orderResults.map((res: any, index: number) => ({
      symbol: orderRequests[index].symbol,
      side: orderRequests[index].side,
      status:
        res.status === "closed" || res.status === "filled"
          ? "filled"
          : "working",
      message: res.info?.error ?? null,
    }))
  }

  getNetworkMode(): NetworkMode {
    return this.networkMode
  }

  getWalletAddress(): string {
    return this.exchange.walletAddress ?? ""
  }
}
