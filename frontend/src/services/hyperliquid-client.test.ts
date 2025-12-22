import { describe, it, expect, vi, beforeEach } from "vitest"

// Create mock exchange instance
const mockExchange = {
  setSandboxMode: vi.fn(),
  loadMarkets: vi.fn(),
  fetchBalance: vi.fn(),
  fetchTickers: vi.fn(),
  fetchPositions: vi.fn(),
  fetchTicker: vi.fn(),
  setLeverage: vi.fn(),
  createOrder: vi.fn(),
  options: {} as Record<string, unknown>,
  walletAddress: "0xTestWallet",
}

// Mock ccxt module with a class
vi.mock("ccxt", () => {
  class MockHyperliquid {
    options: Record<string, unknown> = mockExchange.options
    walletAddress = mockExchange.walletAddress
    setSandboxMode = mockExchange.setSandboxMode
    loadMarkets = mockExchange.loadMarkets
    fetchBalance = mockExchange.fetchBalance
    fetchTickers = mockExchange.fetchTickers
    fetchPositions = mockExchange.fetchPositions
    fetchTicker = mockExchange.fetchTicker
    setLeverage = mockExchange.setLeverage
    createOrder = mockExchange.createOrder
  }

  return {
    default: {
      hyperliquid: MockHyperliquid,
    },
  }
})

import { HyperliquidClient } from "./hyperliquid-client"
import type { WalletCredentials } from "@/contexts/wallet-context"

describe("HyperliquidClient", () => {
  const mockCredentials: WalletCredentials = {
    publicKey: "0xTestPublicKey",
    privateKey: "0xTestPrivateKey",
  }

  let client: HyperliquidClient

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset options object
    mockExchange.options = {}
  })

  describe("constructor", () => {
    it("creates exchange with correct credentials", () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      expect(client.getPublicKey()).toBe("0xTestWallet")
    })

    it("sets sandbox mode for testnet", () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      expect(mockExchange.setSandboxMode).toHaveBeenCalledWith(true)
    })

    it("does not set sandbox mode for mainnet", () => {
      mockExchange.setSandboxMode.mockClear()
      client = new HyperliquidClient(mockCredentials, "mainnet")
      expect(mockExchange.setSandboxMode).not.toHaveBeenCalled()
    })

    it("sets builder fee options to false", () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      expect(mockExchange.options["builderFee"]).toBe(false)
      expect(mockExchange.options["approvedBuilderFee"]).toBe(false)
    })

    it("sets default slippage to 5%", () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      expect(mockExchange.options["defaultSlippage"]).toBe(0.05)
    })
  })

  describe("getBalance", () => {
    it("returns USDC balance", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchBalance.mockResolvedValue({
        total: { USDC: 1000.5 },
      })

      const balance = await client.getBalance()

      expect(balance).toBe(1000.5)
    })

    it("returns 0 when no USDC balance", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchBalance.mockResolvedValue({
        total: {},
      })

      const balance = await client.getBalance()

      expect(balance).toBe(0)
    })
  })

  describe("listPerpTickers", () => {
    it("returns only perpetual symbols", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.loadMarkets.mockResolvedValue({
        "BTC/USDC:USDC": { swap: true },
        "ETH/USDC:USDC": { swap: true },
        "BTC/USDC": { swap: false },
        "SPOT/USD": { swap: false },
      })

      const tickers = await client.listPerpTickers()

      expect(tickers).toEqual(["BTC/USDC:USDC", "ETH/USDC:USDC"])
    })

    it("returns sorted symbols", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.loadMarkets.mockResolvedValue({
        "SOL/USDC:USDC": { swap: true },
        "BTC/USDC:USDC": { swap: true },
        "ETH/USDC:USDC": { swap: true },
      })

      const tickers = await client.listPerpTickers()

      expect(tickers).toEqual([
        "BTC/USDC:USDC",
        "ETH/USDC:USDC",
        "SOL/USDC:USDC",
      ])
    })
  })

  describe("getLeverageLimits", () => {
    it("returns leverage limits for perp symbols", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { info: { maxLeverage: 50 } },
        "ETH/USDC:USDC": { info: { maxLeverage: 25 } },
      })

      const limits = await client.getLeverageLimits()

      expect(limits).toEqual([
        { symbol: "BTC/USDC:USDC", maxLeverage: 50 },
        { symbol: "ETH/USDC:USDC", maxLeverage: 25 },
      ])
    })

    it("defaults to 1x leverage when not specified", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { info: {} },
      })

      const limits = await client.getLeverageLimits()

      expect(limits[0].maxLeverage).toBe(1)
    })

    it("excludes non-perp symbols", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { info: { maxLeverage: 50 } },
        "BTC/USDC": { info: { maxLeverage: 10 } },
      })

      const limits = await client.getLeverageLimits()

      expect(limits).toHaveLength(1)
      expect(limits[0].symbol).toBe("BTC/USDC:USDC")
    })
  })

  describe("getCurrentPositions", () => {
    it("returns processed positions", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 500,
          entryPrice: 45000,
          unrealizedPnl: 100,
          leverage: 2,
        },
      ])

      const positions = await client.getCurrentPositions()

      expect(positions).toEqual([
        {
          symbol: "BTC/USDC:USDC",
          side: "buy",
          notional: 500,
          entryPrice: 45000,
          unrealizedPnl: 100,
          leverage: 2,
        },
      ])
    })

    it("converts short side to sell", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "ETH/USDC:USDC",
          side: "short",
          notional: 300,
          entryPrice: 3000,
          unrealizedPnl: -50,
          leverage: 1,
        },
      ])

      const positions = await client.getCurrentPositions()

      expect(positions[0].side).toBe("sell")
    })

    it("filters out positions with zero or no notional", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 0,
          entryPrice: 45000,
        },
        {
          symbol: "ETH/USDC:USDC",
          side: "long",
          notional: undefined,
          entryPrice: 3000,
        },
        {
          symbol: "SOL/USDC:USDC",
          side: "long",
          notional: 100,
          entryPrice: 150,
          leverage: 1,
        },
      ])

      const positions = await client.getCurrentPositions()

      expect(positions).toHaveLength(1)
      expect(positions[0].symbol).toBe("SOL/USDC:USDC")
    })

    it("handles missing optional fields", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 500,
        },
      ])

      const positions = await client.getCurrentPositions()

      expect(positions[0].entryPrice).toBe(0)
      expect(positions[0].unrealizedPnl).toBe(0)
      expect(positions[0].leverage).toBe(1)
    })
  })

  describe("rebalancePositions", () => {
    it("throws error when budget is not positive", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")

      await expect(client.rebalancePositions([], 0)).rejects.toThrow(
        "Budget must be positive",
      )
      await expect(client.rebalancePositions([], -100)).rejects.toThrow(
        "Budget must be positive",
      )
    })

    it("processes deletions first", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchTicker.mockResolvedValue({ last: 45000 })
      mockExchange.fetchPositions.mockResolvedValue([
        { symbol: "BTC/USDC:USDC", side: "long", contracts: 0.01 },
      ])
      mockExchange.createOrder.mockResolvedValue({})

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy" as const,
          leverage: 2,
          status: "deleted" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000)

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe("filled")
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.01,
        expect.any(Number),
        { reduceOnly: true },
      )
    })

    it("skips untouched positions", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy" as const,
          leverage: 2,
          status: "untouched" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000)

      expect(results).toHaveLength(0)
      expect(mockExchange.setLeverage).not.toHaveBeenCalled()
    })

    it("sets leverage for modified positions", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchPositions.mockResolvedValue([])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 45000 },
      })
      mockExchange.createOrder.mockResolvedValue({})

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy" as const,
          leverage: 5,
          status: "modified" as const,
        },
      ]

      await client.rebalancePositions(positions, 1000)

      expect(mockExchange.setLeverage).toHaveBeenCalledWith(5, "BTC/USDC:USDC")
    })

    it("handles leverage setting failure", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockRejectedValue(new Error("Leverage too high"))

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy" as const,
          leverage: 100,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000)

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe("failed")
      expect(results[0].message).toBe("Leverage too high")
    })

    it("places order for new position", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchPositions.mockResolvedValue([])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
      })
      mockExchange.createOrder.mockResolvedValue({})

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy" as const,
          leverage: 2,
          status: "idle" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000)

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe("filled")
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.01, // 500 / 50000
        52500, // 50000 * 1.05 (slippage)
      )
    })

    it("skips negligible changes", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 500,
        },
      ])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
      })

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy" as const,
          leverage: 2,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000)

      expect(results[0].message).toBe("No action taken: change is negligible.")
      expect(mockExchange.createOrder).not.toHaveBeenCalled()
    })

    it("skips orders below minimum value", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchPositions.mockResolvedValue([])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
      })

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.005, // 0.5% of 1000 = 5 USD, below min
          side: "buy" as const,
          leverage: 1,
          status: "idle" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000)

      expect(results[0].message).toContain("below minimum order size")
      expect(mockExchange.createOrder).not.toHaveBeenCalled()
    })

    it("handles order placement failure", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchPositions.mockResolvedValue([])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
      })
      mockExchange.createOrder.mockRejectedValue(
        new Error("Insufficient balance"),
      )

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy" as const,
          leverage: 2,
          status: "idle" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000)

      expect(results[0].status).toBe("failed")
      expect(results[0].message).toBe("Insufficient balance")
    })
  })

  describe("getNetworkMode", () => {
    it("returns testnet when initialized with testnet", () => {
      client = new HyperliquidClient(mockCredentials, "testnet")

      expect(client.getNetworkMode()).toBe("testnet")
    })

    it("returns mainnet when initialized with mainnet", () => {
      client = new HyperliquidClient(mockCredentials, "mainnet")

      expect(client.getNetworkMode()).toBe("mainnet")
    })
  })
})
