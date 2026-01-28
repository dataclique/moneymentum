import ccxt from "ccxt"
import type { NetworkMode, WalletCredentials } from "@/contexts/wallet-context"

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

  constructor(credentials: WalletCredentials, networkMode: NetworkMode) {
    this.networkMode = networkMode
    this.vaultAddress = credentials.vaultAddress

    const HyperliquidClass = ccxt.hyperliquid as unknown as new (
      config: Record<string, unknown>,
    ) => HyperliquidExchange

    // walletAddress is used for info requests (fetching positions/balance)
    // When trading on behalf of a vault, use vault address; otherwise use account address
    const effectiveWalletAddress =
      credentials.vaultAddress ?? credentials.accountAddress

    this.exchange = new HyperliquidClass({
      walletAddress: effectiveWalletAddress,
      privateKey: credentials.privateKey,
      enableRateLimit: true,
    })

    if (networkMode === "testnet") {
      this.exchange.setSandboxMode(true)
    }

    this.exchange.options["builderFee"] = false
    this.exchange.options["approvedBuilderFee"] = false
    this.exchange.options["defaultSlippage"] = SLIPPAGE
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

  private async fetchSymbolPrices(
    symbols: string[],
  ): Promise<Record<string, number>> {
    if (symbols.length === 0) return {}

    const prices: Record<string, number> = {}
    const tickers = await this.exchange.fetchTickers(symbols)

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
  ): Promise<OrderResult | null> {
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

  async rebalancePositions(
    positions: Position[],
    accountValue: number,
    crossAccountLeverage: number = 1,
  ): Promise<OrderResult[]> {
    if (accountValue <= 0) {
      throw new Error("Account value must be positive")
    }

    const totalNotional = accountValue * crossAccountLeverage

    const results: OrderResult[] = []

    // 1. Process deletions first
    for (const position of positions) {
      if (position.status === "deleted") {
        const closeResult = await this.closePosition(position)
        results.push(closeResult)
      }
    }

    // 2. Filter for positions that need rebalancing
    const positionsToRebalance = positions.filter(
      p => p.status !== "untouched" && p.status !== "deleted",
    )

    if (positionsToRebalance.length === 0) {
      return results
    }

    // 3. Set leverages
    const successfulPositions: Position[] = []
    for (const position of positionsToRebalance) {
      try {
        await this.setLeverage(position.symbol, position.leverage)
        successfulPositions.push(position)
      } catch (error) {
        results.push({
          symbol: position.symbol,
          side: position.side,
          percentage: position.percentage,
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (successfulPositions.length === 0) {
      return results
    }

    // 4. Build target notional values using totalNotional
    const targetNotional: Record<string, number> = {}
    for (const position of successfulPositions) {
      targetNotional[position.symbol] = this.signedNotional(
        position.side,
        position.percentage * totalNotional,
      )
    }

    // 5. Fetch current positions
    const currentPositions = await this.getCurrentPositions()
    const currentNotional: Record<string, number> = {}
    for (const pos of currentPositions) {
      currentNotional[pos.symbol] = this.signedNotional(pos.side, pos.notional)
    }

    // 6. Fetch prices and place orders
    const symbolsToRebalance = successfulPositions.map(p => p.symbol)
    const prices = await this.fetchSymbolPrices(symbolsToRebalance)

    for (const position of successfulPositions) {
      const symbol = position.symbol
      const price = prices[symbol]

      const targetValue = targetNotional[symbol] ?? 0
      const currentValue = currentNotional[symbol] ?? 0
      const notionalDelta = targetValue - currentValue

      if (Math.abs(notionalDelta) < 1.0) {
        results.push({
          symbol,
          side: position.side,
          percentage: position.percentage,
          status: "filled",
          message: "No action taken: change is negligible.",
        })
        continue
      }

      const orderResult = await this.placeOrder(
        symbol,
        price,
        notionalDelta,
        position.percentage,
      )

      if (orderResult) {
        results.push(orderResult)
      }
    }

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
      const currentNotionalAbs = Math.abs(currentNotional[symbol] ?? 0)
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
