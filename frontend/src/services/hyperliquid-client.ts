import ccxt from "ccxt"
import Decimal from "decimal.js"
import type { NetworkMode, WalletCredentials } from "@/contexts/wallet-context"

const MARKETS_CACHE_KEY = "hyperliquid_markets_cache"
const MARKETS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const HYPERLIQUID_MAINNET_INFO_URL = "https://api.hyperliquid.xyz/info"
const HYPERLIQUID_TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info"

interface MarketsCache {
  markets: Record<string, unknown>
  timestamp: number
  networkMode: NetworkMode
}

const createTempExchange = (networkMode: NetworkMode): HyperliquidExchange => {
  const HyperliquidClass = ccxt.hyperliquid as unknown as new (
    config: Record<string, unknown>,
  ) => HyperliquidExchange

  const exchange = new HyperliquidClass({
    enableRateLimit: true,
  })

  if (networkMode === "testnet") {
    exchange.setSandboxMode(true)
  }

  return exchange
}

const getCachedMarkets = (
  networkMode: NetworkMode,
): Record<string, unknown> | null => {
  try {
    const cached = localStorage.getItem(MARKETS_CACHE_KEY)
    if (!cached) {
      console.log("[getCachedMarkets] No cache found in localStorage")
      return null
    }

    const parsed: MarketsCache = JSON.parse(cached) as MarketsCache
    const { markets, timestamp, networkMode: cachedMode } = parsed

    if (cachedMode !== networkMode) {
      console.log(
        `[getCachedMarkets] Cache miss: network mismatch (cached: ${cachedMode}, requested: ${networkMode})`,
      )
      return null
    }

    const ageMs = Date.now() - timestamp
    if (ageMs >= MARKETS_CACHE_TTL_MS) {
      console.log(
        `[getCachedMarkets] Cache miss: expired (age: ${Math.round(ageMs / 1000 / 60)}min)`,
      )
      return null
    }

    console.log(
      `[getCachedMarkets] Cache HIT! Age: ${Math.round(ageMs / 1000 / 60)}min, ${Object.keys(markets).length} markets`,
    )
    return markets
  } catch {
    console.log("[getCachedMarkets] Cache miss: parse error")
    return null
  }
}

const setCachedMarkets = (
  markets: Record<string, unknown>,
  networkMode: NetworkMode,
): void => {
  console.log(
    `[setCachedMarkets] Saving ${Object.keys(markets).length} markets to cache (${networkMode})`,
  )
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
  console.log(`[preloadMarkets] Starting preload for ${networkMode}...`)
  const cached = getCachedMarkets(networkMode)
  if (cached) {
    console.log("[preloadMarkets] Using cached markets, no API call needed")
    return cached
  }

  try {
    console.log("[preloadMarkets] Cache miss, fetching from API...")
    const tempExchange = createTempExchange(networkMode)
    const markets = await tempExchange.loadMarkets()
    console.log(
      `[preloadMarkets] Fetched ${Object.keys(markets).length} markets from API`,
    )

    setCachedMarkets(markets, networkMode)
    return markets
  } catch (error) {
    // Network errors are expected when offline or API is unreachable
    // Markets will be loaded on-demand when needed
    console.warn("[preloadMarkets] Failed to preload markets:", error)
    return null
  }
}

export type OrderSide = "buy" | "sell"
export type PositionStatus =
  | "untouched"
  | "modified"
  | "deleted"
  | "idle"
  | "working"

export interface Position {
  symbol: string
  percentage: number
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
  percentage: number
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

    const HyperliquidClass = ccxt.hyperliquid as unknown as new (
      config: Record<string, unknown>,
    ) => HyperliquidExchange

    // walletAddress is used for info requests (fetching positions/balance)
    // When trading on behalf of a vault, use vault address; otherwise use account address
    const effectiveWalletAddress =
      credentials.vaultAddress ?? credentials.accountAddress

    // Use pre-loaded markets if available, otherwise ccxt will load them on first use
    console.log(
      "[HyperliquidClient] Creating client, checking for cached markets...",
    )
    const cachedMarkets = markets ?? getCachedMarkets(networkMode)

    if (cachedMarkets) {
      console.log(
        `[HyperliquidClient] Passing ${Object.keys(cachedMarkets).length} cached markets to ccxt`,
      )
    } else {
      console.log(
        "[HyperliquidClient] No cached markets, ccxt will fetch on first use",
      )
    }

    this.exchange = new HyperliquidClass({
      walletAddress: effectiveWalletAddress,
      privateKey: credentials.privateKey,
      enableRateLimit: true,
      ...(cachedMarkets && { markets: cachedMarkets }),
    })

    if (networkMode === "testnet") {
      this.exchange.setSandboxMode(true)
    }

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
    console.log("[listPerpTickers] Calling exchange.loadMarkets()...")
    const markets = await this.exchange.loadMarkets()
    console.log(
      `[listPerpTickers] loadMarkets() returned ${Object.keys(markets).length} markets`,
    )

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

  private buildCurrentPositionsMapFromPayload(
    positions: Position[],
  ): Record<string, CurrentPosition> {
    const result: Record<string, CurrentPosition> = {}
    for (const pos of positions) {
      if (
        pos.currentNotional !== undefined &&
        pos.currentNotional > 0 &&
        pos.currentSide !== undefined
      ) {
        result[pos.symbol] = {
          symbol: pos.symbol,
          side: pos.currentSide,
          notional: pos.currentNotional,
          entryPrice: 0,
          unrealizedPnl: 0,
          leverage: pos.leverage,
        }
      }
    }
    return result
  }

  private async fetchSymbolPrices(
    symbols: string[],
  ): Promise<Record<string, number>> {
    if (symbols.length === 0) return {}

    const prices: Record<string, number> = {}

    // Check markets state before fetchTickers
    const exchange = this.exchange as unknown as {
      markets?: Record<string, unknown>
      markets_by_id?: Record<string, unknown>
    }
    console.log("[fetchSymbolPrices] Before fetchTickers", {
      hasMarkets: !!exchange.markets,
      marketsCount: exchange.markets ? Object.keys(exchange.markets).length : 0,
      hasMarketsById: !!exchange.markets_by_id,
    })

    const fetchTickersStart = performance.now()
    console.log("[fetchSymbolPrices] Calling fetchTickers...", { symbols })
    const tickers = await this.exchange.fetchTickers(symbols)
    console.log("[fetchSymbolPrices] fetchTickers completed", {
      elapsed: `${(performance.now() - fetchTickersStart).toFixed(2)}ms`,
      tickerCount: Object.keys(tickers).length,
    })

    for (const symbol of symbols) {
      const lastPrice = tickers[symbol].last
      if (lastPrice === undefined || lastPrice <= 0) {
        throw new Error(
          `Could not fetch price for ${symbol}. The asset may be untradeable or delisted.`,
        )
      }
      prices[symbol] = lastPrice
    }

    return prices
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

  private async closePosition(position: Position): Promise<OrderResult> {
    const symbol = position.symbol

    try {
      const ticker = await this.exchange.fetchTicker(symbol)
      const currentPrice = ticker.last

      if (currentPrice === undefined) {
        throw new Error(`Could not fetch price for ${symbol} to close position`)
      }

      const positions = await this.exchange.fetchPositions([symbol])
      if (
        !positions.length ||
        parseFloat(String(positions[0].contracts)) === 0
      ) {
        return {
          symbol,
          side: position.side,
          percentage: 0,
          status: "filled",
          message: "Position already closed.",
        }
      }

      const fetchedPosition = positions[0]
      const side: OrderSide = fetchedPosition.side === "long" ? "sell" : "buy"
      const amount = parseFloat(String(fetchedPosition.contracts))

      const slippagePrice =
        side === "buy"
          ? currentPrice * (1 + SLIPPAGE)
          : currentPrice * (1 - SLIPPAGE)

      await this.exchange.createOrder(
        symbol,
        "market",
        side,
        amount,
        slippagePrice,
        {
          reduceOnly: true,
          ...this.vaultParams,
        },
      )

      return {
        symbol,
        side: position.side,
        percentage: 0,
        status: "filled",
      }
    } catch (error) {
      return {
        symbol,
        side: position.side,
        percentage: position.percentage,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async placeOrder(
    symbol: string,
    price: number,
    notionalDelta: number,
    percentage: number,
  ): Promise<OrderResult> {
    const side: OrderSide = notionalDelta > 0 ? "buy" : "sell"
    const usdAmount = Math.abs(notionalDelta)
    const coinAmount = usdAmount / price

    if (usdAmount < MIN_ORDER_VALUE) {
      return {
        symbol,
        side,
        percentage,
        status: "filled",
        message: `No action taken: change ($${usdAmount.toFixed(2)}) is below minimum order size ($${String(MIN_ORDER_VALUE)}).`,
      }
    }

    try {
      const slippagePrice =
        side === "buy" ? price * (1 + SLIPPAGE) : price * (1 - SLIPPAGE)

      await this.exchange.createOrder(
        symbol,
        "market",
        side,
        coinAmount,
        slippagePrice,
        this.vaultParams,
      )

      return {
        symbol,
        side,
        percentage,
        status: "filled",
      }
    } catch (error) {
      return {
        symbol,
        side,
        percentage,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** Close a portion of position by notional (USD). Bypasses MIN_ORDER_VALUE for reduce-only. */
  private async closeReduceOnlyNotional(
    symbol: string,
    price: number,
    usdAmount: number,
    closeSide: OrderSide,
    _targetSide: OrderSide,
    percentage: number,
  ): Promise<OrderResult> {
    const coinAmount = usdAmount / price
    if (coinAmount <= 0) {
      return {
        symbol,
        side: closeSide,
        percentage,
        status: "filled",
        message: "No close needed: amount is zero.",
      }
    }

    try {
      const slippagePrice =
        closeSide === "buy" ? price * (1 + SLIPPAGE) : price * (1 - SLIPPAGE)

      await this.exchange.createOrder(
        symbol,
        "market",
        closeSide,
        coinAmount,
        slippagePrice,
        {
          reduceOnly: true,
          ...this.vaultParams,
        },
      )

      return { symbol, side: closeSide, percentage, status: "filled" }
    } catch (error) {
      return {
        symbol,
        side: closeSide,
        percentage,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async rebalancePositions(
    positions: Position[],
    accountValue: number,
    crossAccountLeverage: number = 1,
    precise: boolean = false,
  ): Promise<OrderResult[]> {
    const rebalanceStartTime = performance.now()
    console.log("[Rebalance] client.rebalancePositions() started", {
      timestamp: new Date().toISOString(),
      positionCount: positions.length,
      accountValue,
      crossAccountLeverage,
      precise,
    })

    if (accountValue <= 0) {
      throw new Error("Account value must be positive")
    }

    // Pre-load markets once so subsequent ccxt calls don't re-fetch them
    const marketsStartTime = performance.now()
    console.log("[Rebalance] Step 0: Loading markets (if not cached)")
    await this.exchange.loadMarkets()
    console.log("[Rebalance] Step 0 completed", {
      elapsed: `${(performance.now() - marketsStartTime).toFixed(2)}ms`,
    })

    const totalNotional = accountValue * crossAccountLeverage

    const results: OrderResult[] = []

    // 1. Process deletions first
    const deletionsStartTime = performance.now()
    const deletions = positions.filter(p => p.status === "deleted")
    console.log("[Rebalance] Step 1: Processing deletions", {
      count: deletions.length,
    })
    for (const position of deletions) {
      const closeResult = await this.closePosition(position)
      results.push(closeResult)
    }
    console.log("[Rebalance] Step 1 completed", {
      elapsed: `${(performance.now() - deletionsStartTime).toFixed(2)}ms`,
    })

    // 2. Filter for positions that need rebalancing
    const positionsToRebalance = positions.filter(
      p => p.status !== "untouched" && p.status !== "deleted",
    )

    if (positionsToRebalance.length === 0) {
      console.log("[Rebalance] No positions to rebalance, returning early", {
        totalElapsed: `${(performance.now() - rebalanceStartTime).toFixed(2)}ms`,
      })
      return results
    }

    // 3. Set leverages only where changed (using leverageChanged flag from hook)
    const leverageStartTime = performance.now()
    const positionsNeedingLeverageChange = positionsToRebalance.filter(
      p => p.leverageChanged,
    )
    const positionsWithUnchangedLeverage = positionsToRebalance.filter(
      p => !p.leverageChanged,
    )
    console.log("[Rebalance] Step 3: Setting leverages (parallel)", {
      needChange: positionsNeedingLeverageChange.length,
      skipped: positionsWithUnchangedLeverage.length,
    })

    const successfulPositions: Position[] = [...positionsWithUnchangedLeverage]

    if (positionsNeedingLeverageChange.length > 0) {
      const leverageResults = await Promise.allSettled(
        positionsNeedingLeverageChange.map(async position => {
          await this.setLeverage(position.symbol, position.leverage)
          return position
        }),
      )
      for (let i = 0; i < leverageResults.length; i++) {
        const result = leverageResults[i]
        const position = positionsNeedingLeverageChange[i]
        if (result.status === "fulfilled") {
          successfulPositions.push(result.value)
        } else {
          results.push({
            symbol: position.symbol,
            side: position.side,
            percentage: position.percentage,
            status: "failed",
            message:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          })
        }
      }
    }
    console.log("[Rebalance] Step 3 completed", {
      elapsed: `${(performance.now() - leverageStartTime).toFixed(2)}ms`,
      successful: successfulPositions.length,
      failed: positionsToRebalance.length - successfulPositions.length,
    })

    if (successfulPositions.length === 0) {
      console.log("[Rebalance] No successful positions, returning", {
        totalElapsed: `${(performance.now() - rebalanceStartTime).toFixed(2)}ms`,
      })
      return results
    }

    // 4. Build target and current notional values
    const targetNotional: Record<string, number> = {}
    const currentNotional: Record<string, number> = {}
    for (const position of successfulPositions) {
      const unsignedTarget = new Decimal(position.percentage)
        .mul(totalNotional)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toNumber()

      targetNotional[position.symbol] = this.signedNotional(
        position.side,
        unsignedTarget,
      )
      // Use passed currentNotional (from cached positions), default to 0 for new positions
      // Sign with currentSide when available (actual exchange side), else position.side
      if (position.currentNotional !== undefined) {
        const sideForSign = position.currentSide ?? position.side
        currentNotional[position.symbol] = this.signedNotional(
          sideForSign,
          position.currentNotional,
        )
      }
    }

    // 5. Fetch prices only (positions data already passed from cache)
    const fetchPricesStartTime = performance.now()
    const symbolsToRebalance = successfulPositions.map(p => p.symbol)
    console.log("[Rebalance] Step 5: Fetching prices", {
      symbols: symbolsToRebalance,
    })
    const prices = await this.fetchSymbolPrices(symbolsToRebalance)
    console.log("[Rebalance] Step 5 completed", {
      elapsed: `${(performance.now() - fetchPricesStartTime).toFixed(2)}ms`,
    })

    const ordersStartTime = performance.now()
    console.log("[Rebalance] Step 6: Placing orders", {
      count: successfulPositions.length,
      precise,
    })

    const currentPositionsMap: Record<string, CurrentPosition> = precise
      ? this.buildCurrentPositionsMapFromPayload(successfulPositions)
      : {}

    if (successfulPositions.length > 0) {
      const orderPreview = successfulPositions.map(position => {
        const symbol = position.symbol
        const price = prices[symbol]
        const targetValue = targetNotional[symbol] ?? 0
        const currentValue = currentNotional[symbol] ?? 0
        const notionalDelta = targetValue - currentValue
        return {
          symbol,
          side: position.side,
          leverage: position.leverage,
          targetNotional: Number(targetValue.toFixed(2)),
          currentNotional: Number(currentValue.toFixed(2)),
          deltaNotional: Number(notionalDelta.toFixed(2)),
          price: Number(price.toFixed(4)),
          percentage: Number(position.percentage.toFixed(2)),
        }
      })
      console.log(
        "%c[Rebalance] Order preview:",
        "background: purple; color: white; padding: 2px 6px; border-radius: 3px",
      )
      console.table(orderPreview)
    }
    for (const position of successfulPositions) {
      const symbol = position.symbol
      const price = prices[symbol]

      const targetValue = targetNotional[symbol] ?? 0
      const currentValue = currentNotional[symbol] ?? 0
      const currentPosition = currentPositionsMap[symbol]

      const orderStartTime = performance.now()
      const orderResults = await this.processPosition(
        position,
        price,
        targetValue,
        currentValue,
        currentPosition,
        currentNotional,
        precise,
      )
      console.log("[Rebalance] Order placed", {
        symbol,
        elapsed: `${(performance.now() - orderStartTime).toFixed(2)}ms`,
        status: orderResults[0]?.status,
      })

      for (const orderResult of orderResults) {
        results.push(orderResult)
      }
    }
    console.log("[Rebalance] Step 6 completed", {
      elapsed: `${(performance.now() - ordersStartTime).toFixed(2)}ms`,
      orderCount: results.length,
    })

    console.log("[Rebalance] client.rebalancePositions() completed", {
      totalElapsed: `${(performance.now() - rebalanceStartTime).toFixed(2)}ms`,
      resultsCount: results.length,
    })

    return results
  }

  private async processPosition(
    position: Position,
    price: number,
    targetValue: number,
    currentValue: number,
    currentPosition: CurrentPosition | undefined,
    currentNotional: Record<string, number>,
    precise: boolean,
  ): Promise<OrderResult[]> {
    const { symbol, side, percentage } = position
    const notionalDelta = targetValue - currentValue

    // Negligible change
    if (Math.abs(notionalDelta) < 1.0) {
      return [
        {
          symbol,
          side,
          percentage,
          status: "filled",
          message: "No action taken: change is negligible.",
        },
      ]
    }

    // Precise mode for small changes
    if (precise && Math.abs(notionalDelta) < MIN_ORDER_VALUE) {
      const currentNotionalAbs =
        currentPosition?.notional ?? Math.abs(currentNotional[symbol] ?? 0)
      return this.processPositionPreciseMode(
        position,
        price,
        targetValue,
        currentValue,
        currentPosition,
        currentNotionalAbs,
      )
    }

    // Normal order
    const result = await this.placeOrder(
      symbol,
      price,
      notionalDelta,
      percentage,
    )
    return [result]
  }

  private async processPositionPreciseMode(
    position: Position,
    price: number,
    targetValue: number,
    currentValue: number,
    currentPosition: CurrentPosition | undefined,
    currentNotionalAbs: number,
  ): Promise<OrderResult[]> {
    const { symbol, side: targetSide, percentage } = position

    // New position - open exactly $11
    if (!currentPosition) {
      const result = await this.placeOrder(
        symbol,
        price,
        targetSide === "buy" ? MIN_ORDER_VALUE : -MIN_ORDER_VALUE,
        percentage,
      )
      return [result]
    }

    const currentSide = currentPosition.side
    const sidesMatch = currentSide === targetSide

    // Side changed - close entire position and open target
    if (!sidesMatch) {
      const closeSide: OrderSide = currentSide === "buy" ? "sell" : "buy"
      const closeResult = await this.closeReduceOnlyNotional(
        symbol,
        price,
        currentNotionalAbs,
        closeSide,
        targetSide,
        percentage,
      )

      const targetNotionalAbs = Math.abs(targetValue)
      const openAmount = Math.max(targetNotionalAbs, MIN_ORDER_VALUE)
      const openResult = await this.placeOrder(
        symbol,
        price,
        targetSide === "buy" ? openAmount : -openAmount,
        percentage,
      )

      return [closeResult, openResult]
    }

    // Same side - adjust using precise mode logic
    const currentNotionalAbsValue = Math.abs(currentValue)
    const targetNotionalAbs = Math.abs(targetValue)
    const notionalDelta = targetValue - currentValue
    const deltaAbs = Math.abs(notionalDelta)
    const isIncreasing = targetNotionalAbs > currentNotionalAbsValue
    const closeSide: OrderSide = currentSide === "buy" ? "sell" : "buy"

    if (isIncreasing) {
      return this.handlePreciseModeIncreasing(
        symbol,
        price,
        percentage,
        targetSide,
        closeSide,
        currentNotionalAbsValue,
        targetNotionalAbs,
        deltaAbs,
      )
    }

    return this.handlePreciseModeDecreasing(
      symbol,
      price,
      percentage,
      targetSide,
      closeSide,
      currentNotionalAbsValue,
      targetNotionalAbs,
      deltaAbs,
    )
  }

  private async handlePreciseModeIncreasing(
    symbol: string,
    price: number,
    percentage: number,
    targetSide: OrderSide,
    closeSide: OrderSide,
    currentNotionalAbs: number,
    targetNotionalAbs: number,
    deltaAbs: number,
  ): Promise<OrderResult[]> {
    const closeAmount = MIN_ORDER_VALUE
    const openAmount = MIN_ORDER_VALUE + deltaAbs

    // Close amount exceeds or equals position size - close fully and open target
    if (closeAmount >= currentNotionalAbs) {
      const actualCloseAmount = Math.min(closeAmount, currentNotionalAbs)
      const closeResult = await this.closeReduceOnlyNotional(
        symbol,
        price,
        actualCloseAmount,
        closeSide,
        targetSide,
        percentage,
      )

      const openNotional =
        targetNotionalAbs >= MIN_ORDER_VALUE
          ? targetSide === "buy"
            ? targetNotionalAbs
            : -targetNotionalAbs
          : targetSide === "buy"
            ? MIN_ORDER_VALUE
            : -MIN_ORDER_VALUE
      const openResult = await this.placeOrder(
        symbol,
        price,
        openNotional,
        percentage,
      )

      return [closeResult, openResult]
    }

    // Normal increasing: close $11, open ($11 + delta)
    const closeResult = await this.closeReduceOnlyNotional(
      symbol,
      price,
      closeAmount,
      closeSide,
      targetSide,
      percentage,
    )

    const openNotional = targetSide === "buy" ? openAmount : -openAmount
    const openResult = await this.placeOrder(
      symbol,
      price,
      openNotional,
      percentage,
    )

    return [closeResult, openResult]
  }

  private async handlePreciseModeDecreasing(
    symbol: string,
    price: number,
    percentage: number,
    targetSide: OrderSide,
    closeSide: OrderSide,
    currentNotionalAbs: number,
    targetNotionalAbs: number,
    deltaAbs: number,
  ): Promise<OrderResult[]> {
    const closeAmount = MIN_ORDER_VALUE + deltaAbs
    const openAmount = MIN_ORDER_VALUE

    // Close amount exceeds position size - close entire position
    if (closeAmount >= currentNotionalAbs) {
      const actualCloseAmount = Math.min(closeAmount, currentNotionalAbs)
      const closeResult =
        actualCloseAmount < MIN_ORDER_VALUE
          ? await this.closeReduceOnlyNotional(
              symbol,
              price,
              actualCloseAmount,
              closeSide,
              targetSide,
              percentage,
            )
          : await this.placeOrder(
              symbol,
              price,
              closeSide === "buy" ? actualCloseAmount : -actualCloseAmount,
              percentage,
            )

      // Only open if target >= $11
      if (targetNotionalAbs >= MIN_ORDER_VALUE) {
        const openResult = await this.placeOrder(
          symbol,
          price,
          targetSide === "buy" ? targetNotionalAbs : -targetNotionalAbs,
          percentage,
        )
        return [closeResult, openResult]
      }

      return [closeResult]
    }

    // Normal decreasing: close ($11 + |delta|), open $11
    const closeNotional = closeSide === "buy" ? closeAmount : -closeAmount
    const closeResult = await this.placeOrder(
      symbol,
      price,
      closeNotional,
      percentage,
    )

    const openNotional = targetSide === "buy" ? openAmount : -openAmount
    const openResult = await this.placeOrder(
      symbol,
      price,
      openNotional,
      percentage,
    )

    return [closeResult, openResult]
  }

  getNetworkMode(): NetworkMode {
    return this.networkMode
  }

  getWalletAddress(): string {
    return this.exchange.walletAddress ?? ""
  }
}
