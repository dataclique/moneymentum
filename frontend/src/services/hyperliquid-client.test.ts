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
    accountAddress: "0xTestAccountAddress",
    apiWalletAddress: "0xTestApiWalletAddress",
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
      expect(client.getWalletAddress()).toBe("0xTestWallet")
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

      expect(mockExchange.setLeverage).toHaveBeenCalledWith(
        5,
        "BTC/USDC:USDC",
        undefined,
      )
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
        undefined,
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

  describe("precise mode", () => {
    beforeEach(() => {
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
      })
      mockExchange.createOrder.mockResolvedValue({})
    })

    it("increases long position with small change: close $11, open ($11 + delta)", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 30, // $30 long
          contracts: 0.0006,
        },
      ])

      // Current: $30 long, target: $35 long, delta = +$5
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.035, // 3.5% of 1000 = $35
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(2)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
      // First call: close $11 (sell)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        1,
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.00022, // 11 / 50000
        47500, // 50000 * 0.95 (slippage)
        undefined,
      )
      // Second call: open $16 (buy)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        2,
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.00032, // 16 / 50000
        52500, // 50000 * 1.05 (slippage)
        undefined,
      )
    })

    it("decreases long position with small change: close ($11 + delta), open $11", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 54, // $54 long
          contracts: 0.00108,
        },
      ])

      // Current: $54 long, target: $50 long, delta = -$4
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.05, // 5% of 1000 = $50
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(2)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
      // First call: close $15 (sell)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        1,
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.0003, // 15 / 50000
        47500,
        undefined,
      )
      // Second call: open $11 (buy)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        2,
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.00022, // 11 / 50000
        52500,
        undefined,
      )
    })

    it("increases short position with small change: close $11, open ($11 + delta)", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "short",
          notional: 30, // $30 short
          contracts: 0.0006,
        },
      ])

      // Current: $30 short, target: $35 short (abs: 35 > 30, so increasing)
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.035, // 3.5% of 1000 = $35
          side: "sell" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(2)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
      // First call: close $11 (buy to close short)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        1,
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.00022, // 11 / 50000
        52500, // buy uses higher price
        undefined,
      )
      // Second call: open $16 (sell to increase short)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        2,
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.00032, // 16 / 50000
        47500, // sell uses lower price
        undefined,
      )
    })

    it("decreases short position with small change: close ($11 + delta), open $11", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "short",
          notional: 62.3832, // $62.38 short
          contracts: 0.001247664,
        },
      ])

      // Current: $62.38 short, target: $59.32 short (abs: 59.32 < 62.38, so decreasing)
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.05932, // 5.932% of 1000 = $59.32
          side: "sell" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(2)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
      // First call: close $14.06 (buy to close short)
      // Delta: 62.3832 - 59.32 = 3.0632, closeAmount = 11 + 3.0632 = 14.0632
      const expectedCloseAmount = 14.0632
      const expectedCoinAmount = expectedCloseAmount / 50000
      // Verify the first call with floating-point tolerance
      expect(mockExchange.createOrder.mock.calls[0][3]).toBeCloseTo(
        expectedCoinAmount,
        10,
      )
      // Second call: open $11 (sell to maintain short)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        2,
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.00022, // 11 / 50000
        47500,
        undefined,
      )
    })

    it("opens new position with exactly $11 in precise mode", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([])

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.005, // 0.5% of 1000 = $5, below min but precise mode handles it
          side: "buy" as const,
          leverage: 1,
          status: "idle" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe("filled")
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(1)
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.00022, // 11 / 50000
        52500,
        undefined,
      )
    })

    it("closes entire position and opens target when close amount exceeds position size", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 11, // $11 long (minimum, so closeAmount = 11 >= 11 = true)
          contracts: 0.00022,
        },
      ])

      // Current: $11, target: $20 (delta = +$9, which is < $11, so precise mode applies)
      // closeAmount = $11, currentNotionalAbs = $11, so 11 >= 11 = true
      // This should close the entire $11 position and open the $20 target
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.02, // 2% of 1000 = $20
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(2)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
      // First call: close entire $11 position
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        1,
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.00022, // 11 / 50000
        47500,
        undefined,
      )
      // Second call: open target $20
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        2,
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.0004, // 20 / 50000
        52500,
        undefined,
      )
    })

    it("closes entire position without opening if target < $11", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 15, // $15 long
          contracts: 0.0003,
        },
      ])

      // Current: $15, target: $8 (delta = -$7, close $18 > $15, but target < $11)
      // Delta -$7 < $11, so precise mode applies
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.008, // 0.8% of 1000 = $8
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(1)
      // Only close, no open (target < $11)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(1)
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.0003, // 15 / 50000
        47500,
        undefined,
      )
    })

    it("handles side change with small target in precise mode", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 50,
          contracts: 0.001,
        },
      ])

      // Current: $50 long, target: $8 short (side change with small target)
      // Delta: -8 - 50 = -58 (large, but precise mode handles side changes specially)
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.008, // 0.8% of 1000 = $8 (below $11)
          side: "sell" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      // Side change: delta is -58 (not < $11), so precise mode doesn't apply
      // This should be handled by normal rebalance logic (not precise mode)
      expect(results).toHaveLength(1)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(1)
      // Should try to close and open normally (delta is large enough)
    })

    it("handles multiple tokens with small changes in precise mode", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 30,
          contracts: 0.0006,
        },
        {
          symbol: "ETH/USDC:USDC",
          side: "short",
          notional: 40,
          contracts: 0.01,
        },
      ])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
        "ETH/USDC:USDC": { last: 4000 },
      })

      // BTC: $30 long → $35 long (+$5), ETH: $40 short → $45 short (+$5)
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.035, // $35
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
        {
          symbol: "ETH/USDC:USDC",
          percentage: 0.045, // $45
          side: "sell" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      // Each token should have 2 orders (close $11, open $16)
      expect(results).toHaveLength(4)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(4)
    })

    it("handles precise mode with leverage change", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 30,
          contracts: 0.0006,
        },
      ])

      // Same position size but different leverage
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.035, // $35 (small change of $5)
          side: "buy" as const,
          leverage: 5, // Changed leverage
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      // Should set leverage first
      expect(mockExchange.setLeverage).toHaveBeenCalledWith(
        5,
        "BTC/USDC:USDC",
        undefined,
      )
      // Then apply precise mode for small position change
      expect(results).toHaveLength(2)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
    })

    it("handles boundary: position exactly $11, target exactly $11 (no change needed)", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 11,
          contracts: 0.00022,
        },
      ])

      // Current: $11, target: $11 (delta = 0)
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.011, // 1.1% of 1000 = $11
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      // Delta is 0, which is < 1.0, so it should be skipped as negligible
      expect(results).toHaveLength(1)
      expect(results[0].message).toBe("No action taken: change is negligible.")
      expect(mockExchange.createOrder).not.toHaveBeenCalled()
    })

    it("handles boundary: target exactly $11 for new position", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([])

      // New position with target exactly $11
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.011, // 1.1% of 1000 = $11
          side: "buy" as const,
          leverage: 1,
          status: "idle" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe("filled")
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(1)
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.00022, // 11 / 50000
        52500,
        undefined,
      )
    })

    it("handles error during close phase in precise mode", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 30,
          contracts: 0.0006,
        },
      ])
      // First order (close) fails, second order (open) should still be attempted
      mockExchange.createOrder
        .mockRejectedValueOnce(new Error("Close order failed"))
        .mockResolvedValueOnce({})

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.035, // $35 (small change of $5)
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      // Should have 2 results: failed close, filled open
      expect(results).toHaveLength(2)
      expect(results[0].status).toBe("failed")
      expect(results[0].message).toBe("Close order failed")
      expect(results[1].status).toBe("filled")
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
    })

    it("handles error during open phase in precise mode", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 30,
          contracts: 0.0006,
        },
      ])
      // First order (close) succeeds, second order (open) fails
      mockExchange.createOrder
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("Open order failed"))

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.035, // $35 (small change of $5)
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      // Should have 2 results: filled close, failed open
      expect(results).toHaveLength(2)
      expect(results[0].status).toBe("filled")
      expect(results[1].status).toBe("failed")
      expect(results[1].message).toBe("Open order failed")
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
    })

    it("handles side change with small delta in precise mode", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 5, // $5 long
          contracts: 0.0001,
        },
      ])

      // Current: $5 long, target: $5 short
      // Delta: -5 - 5 = -10, |delta| = 10 < 11, so precise mode applies
      // Sides don't match, so we close entire position and open target (at least $11)
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.005, // 0.5% of 1000 = $5 short
          side: "sell" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(2)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
      // First call: close $5 long using reduceOnly (below min order size)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        1,
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.0001, // 5 / 50000
        47500,
        { reduceOnly: true },
      )
      // Second call: open at least $11 short (target was $5 but minimum is $11)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        2,
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.00022, // 11 / 50000
        47500,
        undefined,
      )
    })

    it("handles small position (< $11) being increased in precise mode", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 8, // $8 long (below $11 minimum)
          contracts: 0.00016,
        },
      ])

      // Current: $8 long, target: $15 long
      // Delta: 15 - 8 = +7, |delta| = 7 < 11, so precise mode applies
      // isIncreasing = true, closeAmount = $11 >= currentNotionalAbs = $8
      // actualCloseAmount = min(11, 8) = 8 < MIN_ORDER_VALUE
      // So we use closeReduceOnlyNotional to close the $8 position
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.015, // 1.5% of 1000 = $15
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(2)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
      // First call: close $8 using reduceOnly (below min order size)
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        1,
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.00016, // 8 / 50000
        47500,
        { reduceOnly: true },
      )
      // Second call: open target $15
      expect(mockExchange.createOrder).toHaveBeenNthCalledWith(
        2,
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.0003, // 15 / 50000
        52500,
        undefined,
      )
    })

    it("handles small position (< $11) being decreased in precise mode", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchPositions.mockResolvedValue([
        {
          symbol: "BTC/USDC:USDC",
          side: "long",
          notional: 8, // $8 long (below $11 minimum)
          contracts: 0.00016,
        },
      ])

      // Current: $8 long, target: $5 long
      // Delta: 5 - 8 = -3, |delta| = 3 < 11, so precise mode applies
      // isIncreasing = false (5 < 8), closeAmount = 11 + 3 = $14 >= currentNotionalAbs = $8
      // actualCloseAmount = min(14, 8) = 8 < MIN_ORDER_VALUE
      // So we use closeReduceOnlyNotional to close the $8 position
      // Target $5 < $11, so no open order
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.005, // 0.5% of 1000 = $5
          side: "buy" as const,
          leverage: 1,
          status: "modified" as const,
        },
      ]

      const results = await client.rebalancePositions(positions, 1000, true)

      expect(results).toHaveLength(1)
      expect(mockExchange.createOrder).toHaveBeenCalledTimes(1)
      // Only close $8 using reduceOnly (below min order size), no open (target < $11)
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "sell",
        0.00016, // 8 / 50000
        47500,
        { reduceOnly: true },
      )
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
