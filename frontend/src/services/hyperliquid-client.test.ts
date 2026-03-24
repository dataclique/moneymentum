import { beforeEach, describe, expect, it, vi } from "vitest"

import type { WalletCredentials } from "@/contexts/wallet-context"
import type { RebalanceAction } from "@/pages/Portfolio/hooks/portfolioRebalancer"

const mockExchange = {
  setSandboxMode: vi.fn(),
  options: {} as Record<string, unknown>,
  urls: {} as Record<string, string | Record<string, string>>,
  walletAddress: "0xWallet",
  loadMarkets: vi.fn(),
  fetchBalance: vi.fn(),
  fetchTickers: vi.fn(),
  fetchTicker: vi.fn(),
  fetchPositions: vi.fn(),
  setLeverage: vi.fn(),
  createOrder: vi.fn(),
  createOrdersWs: vi.fn(),
}

vi.mock("ccxt", () => ({
  default: {},
  pro: {
    hyperliquid: class {
      setSandboxMode = mockExchange.setSandboxMode
      options = mockExchange.options
      urls = mockExchange.urls
      walletAddress = mockExchange.walletAddress
      loadMarkets = mockExchange.loadMarkets
      fetchBalance = mockExchange.fetchBalance
      fetchTickers = mockExchange.fetchTickers
      fetchTicker = mockExchange.fetchTicker
      fetchPositions = mockExchange.fetchPositions
      setLeverage = mockExchange.setLeverage
      createOrder = mockExchange.createOrder
      createOrdersWs = mockExchange.createOrdersWs
    },
  },
}))

import { HyperliquidClient } from "./hyperliquid-client"

describe("HyperliquidClient", () => {
  const credentials: WalletCredentials = {
    accountAddress: "0xAccount",
    apiWalletAddress: "0xApiWallet",
    privateKey: "secret",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockExchange.options = {}
    mockExchange.urls = {}
    const globalAny = globalThis as { localStorage?: Storage }
    if (
      !globalAny.localStorage ||
      typeof globalAny.localStorage.setItem !== "function"
    ) {
      const store = new Map<string, string>()
      globalAny.localStorage = {
        getItem: key => (store.has(key) ? store.get(key)! : null),
        setItem: (key, value) => {
          store.set(key, value)
        },
        removeItem: key => {
          store.delete(key)
        },
        clear: () => {
          store.clear()
        },
        key: index => Array.from(store.keys())[index] ?? null,
        get length() {
          return store.size
        },
      } as unknown as Storage
    }
  })

  it("enables sandbox mode on testnet", () => {
    new HyperliquidClient(credentials, "testnet")
    expect(mockExchange.setSandboxMode).toHaveBeenCalledWith(true)
  })

  it("parses account summary values from balance info", async () => {
    mockExchange.fetchBalance.mockResolvedValue({
      total: { USDC: 123 },
      info: {
        marginSummary: { accountValue: "1000.5", totalNtlPos: "1500" },
        withdrawable: "777.1",
      },
    })

    const client = new HyperliquidClient(credentials, "mainnet")
    const summary = await client.getAccountSummary()

    expect(summary).toEqual({
      accountValue: 1000.5,
      totalNotionalPosition: 1500,
      withdrawable: 777.1,
    })
  })

  it("returns only swap symbols from markets", async () => {
    mockExchange.loadMarkets.mockResolvedValue({
      "BTC/USDC:USDC": { swap: true },
      "ETH/USDC:USDC": { swap: true },
      "BTC/USDC": { swap: false },
    })

    const client = new HyperliquidClient(credentials, "mainnet")
    const symbols = await client.listPerpTickers()

    expect(symbols).toEqual(["BTC/USDC:USDC", "ETH/USDC:USDC"])
  })

  it("maps positions to buy/sell current positions", async () => {
    mockExchange.fetchPositions.mockResolvedValue([
      { symbol: "BTC/USDC:USDC", side: "long", notional: 100, leverage: 2 },
      { symbol: "ETH/USDC:USDC", side: "short", notional: 200, leverage: 3 },
      { symbol: "SOL/USDC:USDC", side: "long", notional: 0, leverage: 1 },
    ])

    const client = new HyperliquidClient(credentials, "mainnet")
    const positions = await client.getCurrentPositions()

    expect(positions).toHaveLength(2)
    expect(positions[0].side).toBe("buy")
    expect(positions[1].side).toBe("sell")
  })

  it("sets leverage first and then sends batch orders", async () => {
    const actions: RebalanceAction[] = [
      {
        kind: "rebalance",
        symbol: "BTC/USDC:USDC",
        notional: 100,
        leverage: 5,
        leverageChanged: true,
      },
      {
        kind: "close",
        symbol: "ETH/USDC:USDC",
        side: "buy",
      },
    ]

    mockExchange.loadMarkets.mockResolvedValue({})
    mockExchange.fetchTickers.mockResolvedValue({
      "BTC/USDC:USDC": { last: 50_000 },
      "ETH/USDC:USDC": { last: 4_000 },
    })
    mockExchange.fetchPositions.mockResolvedValue([
      { symbol: "ETH/USDC:USDC", side: "long", contracts: 0.5 },
    ])
    mockExchange.createOrdersWs.mockResolvedValue([
      { status: "closed", info: {} },
      { status: "filled", info: {} },
    ])

    const client = new HyperliquidClient(credentials, "mainnet")
    const result = await client.rebalancePositions(actions, false)

    expect(mockExchange.setLeverage).toHaveBeenCalledWith(
      5,
      "BTC/USDC:USDC",
      undefined,
    )
    expect(mockExchange.createOrdersWs).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(2)
    expect(result[0].status).toBe("filled")
  })

  it("includes vaultAddress in leverage and order params", async () => {
    const vaultCreds: WalletCredentials = {
      ...credentials,
      vaultAddress: "0xVault",
    }
    const actions: RebalanceAction[] = [
      {
        kind: "rebalance",
        symbol: "BTC/USDC:USDC",
        notional: 50,
        leverage: 3,
        leverageChanged: true,
      },
    ]

    mockExchange.loadMarkets.mockResolvedValue({})
    mockExchange.fetchTickers.mockResolvedValue({
      "BTC/USDC:USDC": { last: 50_000 },
    })
    mockExchange.fetchPositions.mockResolvedValue([])
    mockExchange.createOrdersWs.mockResolvedValue([
      { status: "closed", info: {} },
    ])

    const client = new HyperliquidClient(vaultCreds, "mainnet")
    await client.rebalancePositions(actions, true)

    expect(mockExchange.setLeverage).toHaveBeenCalledWith(3, "BTC/USDC:USDC", {
      vaultAddress: "0xVault",
    })
    expect(mockExchange.createOrdersWs).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({ vaultAddress: "0xVault" }),
        }),
      ]),
    )
  })
})
