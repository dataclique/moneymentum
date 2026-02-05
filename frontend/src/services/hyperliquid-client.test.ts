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
import type { Position } from "./hyperliquid-client"

const createPosition = (
  overrides: Partial<Position> &
    Pick<Position, "symbol" | "percentage" | "side" | "leverage" | "status">,
): Position => ({
  leverageChanged: false,
  ...overrides,
})

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
    it("throws error when account value is not positive", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")

      await expect(client.rebalancePositions([], 0)).rejects.toThrow(
        "Account value must be positive",
      )
      await expect(client.rebalancePositions([], -100)).rejects.toThrow(
        "Account value must be positive",
      )
    })

    it("processes deletions first", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchTicker.mockResolvedValue({ last: 45000 })
      mockExchange.fetchPositions.mockResolvedValue([
        { symbol: "BTC/USDC:USDC", side: "long", contracts: 0.01 },
      ])
      mockExchange.createOrder.mockResolvedValue({})

      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 2,
          status: "deleted",
        }),
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

      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 2,
          status: "untouched",
        }),
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

      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 5,
          status: "modified",
          leverageChanged: true,
        }),
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

      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 100,
          status: "modified",
          leverageChanged: true,
        }),
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

      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 2,
          status: "idle",
        }),
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
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
      })

      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 2,
          status: "modified",
          currentNotional: 500,
          currentSide: "buy",
        }),
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

      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.005, // 0.5% of 1000 = 5 USD, below min
          side: "buy",
          leverage: 1,
          status: "idle",
        }),
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

      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 2,
          status: "idle",
        }),
      ]

      const results = await client.rebalancePositions(positions, 1000)

      expect(results[0].status).toBe("failed")
      expect(results[0].message).toBe("Insufficient balance")
    })

    it("calculates target notional using accountValue and crossAccountLeverage", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchPositions.mockResolvedValue([])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
      })
      mockExchange.createOrder.mockResolvedValue({})

      // accountValue = 1000, crossAccountLeverage = 2
      // totalNotional = 1000 * 2 = 2000
      // targetNotional for 50% = 0.5 * 2000 = 1000 USD
      // coinAmount = 1000 / 50000 = 0.02
      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 2,
          status: "idle",
        }),
      ]

      await client.rebalancePositions(positions, 1000, 2)

      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.02, // 1000 / 50000
        52500, // 50000 * 1.05 (slippage)
        undefined,
      )
    })

    it("defaults crossAccountLeverage to 1 when not provided", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchPositions.mockResolvedValue([])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
      })
      mockExchange.createOrder.mockResolvedValue({})

      // accountValue = 1000, crossAccountLeverage defaults to 1
      // totalNotional = 1000 * 1 = 1000
      // targetNotional for 50% = 0.5 * 1000 = 500 USD
      // coinAmount = 500 / 50000 = 0.01
      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy",
          leverage: 2,
          status: "idle",
        }),
      ]

      await client.rebalancePositions(positions, 1000)

      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.01, // 500 / 50000
        52500,
        undefined,
      )
    })

    it("scales all positions proportionally with cross account leverage", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.setLeverage.mockResolvedValue({})
      mockExchange.fetchPositions.mockResolvedValue([])
      mockExchange.fetchTickers.mockResolvedValue({
        "BTC/USDC:USDC": { last: 50000 },
        "ETH/USDC:USDC": { last: 4000 },
      })
      mockExchange.createOrder.mockResolvedValue({})

      // accountValue = 1000, crossAccountLeverage = 3
      // totalNotional = 1000 * 3 = 3000
      // BTC: 40% = 0.4 * 3000 = 1200 USD -> 0.024 BTC
      // ETH: 60% = 0.6 * 3000 = 1800 USD -> 0.45 ETH
      const positions: Position[] = [
        createPosition({
          symbol: "BTC/USDC:USDC",
          percentage: 0.4,
          side: "buy",
          leverage: 1,
          status: "idle",
        }),
        createPosition({
          symbol: "ETH/USDC:USDC",
          percentage: 0.6,
          side: "sell",
          leverage: 1,
          status: "idle",
        }),
      ]

      await client.rebalancePositions(positions, 1000, 3)

      expect(mockExchange.createOrder).toHaveBeenCalledTimes(2)
      // BTC buy
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "BTC/USDC:USDC",
        "market",
        "buy",
        0.024,
        52500,
        undefined,
      )
      // ETH sell
      expect(mockExchange.createOrder).toHaveBeenCalledWith(
        "ETH/USDC:USDC",
        "market",
        "sell",
        0.45,
        3800, // 4000 * 0.95
        undefined,
      )
    })

    describe("position increase scenarios", () => {
      it("increases existing long position", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchTickers.mockResolvedValue({
          "BTC/USDC:USDC": { last: 50000 },
        })
        mockExchange.createOrder.mockResolvedValue({})

        // Target: 50% of $1000 = $500
        // Current: $300 (from payload)
        // Delta: $500 - $300 = $200 (buy more)
        const positions: Position[] = [
          createPosition({
            symbol: "BTC/USDC:USDC",
            percentage: 0.5,
            side: "buy",
            leverage: 2,
            status: "modified",
            currentNotional: 300,
            currentSide: "buy",
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results[0].status).toBe("filled")
        expect(mockExchange.createOrder).toHaveBeenCalledWith(
          "BTC/USDC:USDC",
          "market",
          "buy",
          0.004, // $200 / $50000
          52500,
          undefined,
        )
      })

      it("increases existing short position", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchTickers.mockResolvedValue({
          "ETH/USDC:USDC": { last: 4000 },
        })
        mockExchange.createOrder.mockResolvedValue({})

        // Target: 50% short of $1000 = -$500
        // Current: -$200, Delta: -$500 - (-$200) = -$300 (sell more)
        const positions: Position[] = [
          createPosition({
            symbol: "ETH/USDC:USDC",
            percentage: 0.5,
            side: "sell",
            leverage: 1,
            status: "modified",
            currentNotional: 200,
            currentSide: "sell",
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results[0].status).toBe("filled")
        expect(mockExchange.createOrder).toHaveBeenCalledWith(
          "ETH/USDC:USDC",
          "market",
          "sell",
          0.075, // $300 / $4000
          3800, // slippage for sell
          undefined,
        )
      })
    })

    describe("position decrease scenarios", () => {
      it("decreases existing long position", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchTickers.mockResolvedValue({
          "BTC/USDC:USDC": { last: 50000 },
        })
        mockExchange.createOrder.mockResolvedValue({})

        // Target: 30% of $1000 = $300
        // Current: $800, Delta: $300 - $800 = -$500 (sell some)
        const positions: Position[] = [
          createPosition({
            symbol: "BTC/USDC:USDC",
            percentage: 0.3,
            side: "buy",
            leverage: 2,
            status: "modified",
            currentNotional: 800,
            currentSide: "buy",
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results[0].status).toBe("filled")
        expect(mockExchange.createOrder).toHaveBeenCalledWith(
          "BTC/USDC:USDC",
          "market",
          "sell",
          0.01, // $500 / $50000
          47500, // slippage for sell
          undefined,
        )
      })

      it("decreases existing short position (buy to cover)", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchTickers.mockResolvedValue({
          "ETH/USDC:USDC": { last: 4000 },
        })
        mockExchange.createOrder.mockResolvedValue({})

        // Target: 20% short of $1000 = -$200
        // Current: -$600, Delta: -$200 - (-$600) = $400 (buy to cover)
        const positions: Position[] = [
          createPosition({
            symbol: "ETH/USDC:USDC",
            percentage: 0.2,
            side: "sell",
            leverage: 1,
            status: "modified",
            currentNotional: 600,
            currentSide: "sell",
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results[0].status).toBe("filled")
        expect(mockExchange.createOrder).toHaveBeenCalledWith(
          "ETH/USDC:USDC",
          "market",
          "buy",
          0.1, // $400 / $4000
          4200, // slippage for buy
          undefined,
        )
      })
    })

    describe("side flip scenarios (single order)", () => {
      it("flips from long to short with single order", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchTickers.mockResolvedValue({
          "BTC/USDC:USDC": { last: 50000 },
        })
        mockExchange.createOrder.mockResolvedValue({})

        // Target: 40% SHORT of $1000 = -$400
        // Current: +$300, Delta: -$400 - $300 = -$700 (sell $700 worth)
        const positions: Position[] = [
          createPosition({
            symbol: "BTC/USDC:USDC",
            percentage: 0.4,
            side: "sell",
            leverage: 2,
            status: "modified",
            currentNotional: 300,
            currentSide: "buy",
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results[0].status).toBe("filled")
        expect(mockExchange.createOrder).toHaveBeenCalledWith(
          "BTC/USDC:USDC",
          "market",
          "sell",
          0.014, // $700 / $50000
          47500,
          undefined,
        )
      })

      it("flips from short to long with single order", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchTickers.mockResolvedValue({
          "ETH/USDC:USDC": { last: 4000 },
        })
        mockExchange.createOrder.mockResolvedValue({})

        // Target: 50% LONG of $1000 = +$500
        // Current: -$200, Delta: $500 - (-$200) = $700 (buy $700 worth)
        const positions: Position[] = [
          createPosition({
            symbol: "ETH/USDC:USDC",
            percentage: 0.5,
            side: "buy",
            leverage: 1,
            status: "modified",
            currentNotional: 200,
            currentSide: "sell",
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results[0].status).toBe("filled")
        expect(mockExchange.createOrder).toHaveBeenCalledWith(
          "ETH/USDC:USDC",
          "market",
          "buy",
          0.175, // $700 / $4000
          4200,
          undefined,
        )
      })
    })

    describe("insufficient delta handling", () => {
      it("reports insufficient delta differently from failures", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchTickers.mockResolvedValue({
          "BTC/USDC:USDC": { last: 50000 },
        })

        // Target: 50% of $1000 = $500
        // Current: $505, Delta: $500 - $505 = -$5 (below $11 minimum)
        const positions: Position[] = [
          createPosition({
            symbol: "BTC/USDC:USDC",
            percentage: 0.5,
            side: "buy",
            leverage: 2,
            status: "modified",
            currentNotional: 505,
            currentSide: "buy",
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        // Should be marked as filled (not failed) with explanatory message
        expect(results[0].status).toBe("filled")
        expect(results[0].message).toContain("below minimum order size")
        expect(mockExchange.createOrder).not.toHaveBeenCalled()
      })

      it("handles delta exactly at negligible threshold", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchTickers.mockResolvedValue({
          "BTC/USDC:USDC": { last: 50000 },
        })

        // Target: 50% of $1000 = $500
        // Current: $500.5, Delta: $500 - $500.5 = -$0.5 (negligible)
        const positions: Position[] = [
          createPosition({
            symbol: "BTC/USDC:USDC",
            percentage: 0.5,
            side: "buy",
            leverage: 2,
            status: "modified",
            currentNotional: 500.5,
            currentSide: "buy",
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results[0].status).toBe("filled")
        expect(results[0].message).toBe(
          "No action taken: change is negligible.",
        )
      })
    })

    describe("mixed operations", () => {
      it("handles mix of increase, decrease, and close in single rebalance", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        const allPositions = [
          {
            symbol: "BTC/USDC:USDC",
            side: "long",
            notional: 200,
            contracts: 0.004,
          },
          {
            symbol: "ETH/USDC:USDC",
            side: "long",
            notional: 400,
            contracts: 0.1,
          },
        ]
        mockExchange.fetchPositions.mockImplementation((syms?: string[]) =>
          Promise.resolve(
            syms?.length
              ? allPositions.filter(p => syms.includes(p.symbol))
              : allPositions,
          ),
        )
        mockExchange.fetchTickers.mockResolvedValue({
          "BTC/USDC:USDC": { last: 50000 },
          "ETH/USDC:USDC": { last: 4000 },
          "SOL/USDC:USDC": { last: 100 },
        })
        mockExchange.fetchTicker.mockResolvedValue({ last: 4000 })
        mockExchange.createOrder.mockResolvedValue({})

        const positions = [
          // BTC: increase from $200 to $400
          {
            symbol: "BTC/USDC:USDC",
            percentage: 0.4,
            side: "buy" as const,
            leverage: 2,
            leverageChanged: false,
            status: "modified" as const,
          },
          // ETH: close entirely (delete)
          {
            symbol: "ETH/USDC:USDC",
            percentage: 0,
            side: "buy" as const,
            leverage: 1,
            leverageChanged: false,
            status: "deleted" as const,
          },
          // SOL: new position $300
          {
            symbol: "SOL/USDC:USDC",
            percentage: 0.3,
            side: "sell" as const,
            leverage: 3,
            leverageChanged: false,
            status: "idle" as const,
          },
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results).toHaveLength(3)
        // Deletions processed first
        expect(results.find(r => r.symbol === "ETH/USDC:USDC")?.status).toBe(
          "filled",
        )
        // Other operations
        expect(results.find(r => r.symbol === "BTC/USDC:USDC")?.status).toBe(
          "filled",
        )
        expect(results.find(r => r.symbol === "SOL/USDC:USDC")?.status).toBe(
          "filled",
        )
      })

      it("continues processing after one position fails", async () => {
        client = new HyperliquidClient(mockCredentials, "testnet")
        mockExchange.setLeverage
          .mockRejectedValueOnce(new Error("Leverage too high"))
          .mockResolvedValueOnce({})
        mockExchange.fetchTickers.mockResolvedValue({
          "BTC/USDC:USDC": { last: 50000 },
          "ETH/USDC:USDC": { last: 4000 },
        })
        mockExchange.createOrder.mockResolvedValue({})

        const positions: Position[] = [
          createPosition({
            symbol: "BTC/USDC:USDC",
            percentage: 0.5,
            side: "buy",
            leverage: 100,
            status: "idle",
            leverageChanged: true,
          }),
          createPosition({
            symbol: "ETH/USDC:USDC",
            percentage: 0.3,
            side: "buy",
            leverage: 2,
            status: "idle",
            leverageChanged: true,
          }),
        ]

        const results = await client.rebalancePositions(positions, 1000)

        expect(results).toHaveLength(2)
        expect(results.find(r => r.symbol === "BTC/USDC:USDC")?.status).toBe(
          "failed",
        )
        expect(results.find(r => r.symbol === "ETH/USDC:USDC")?.status).toBe(
          "filled",
        )
      })
    })

    describe("vault address handling", () => {
      it("includes vault address in leverage and order params", async () => {
        const vaultCredentials: WalletCredentials = {
          ...mockCredentials,
          vaultAddress: "0xVaultAddress",
        }
        client = new HyperliquidClient(vaultCredentials, "testnet")
        mockExchange.setLeverage.mockResolvedValue({})
        mockExchange.fetchPositions.mockResolvedValue([])
        mockExchange.fetchTickers.mockResolvedValue({
          "BTC/USDC:USDC": { last: 50000 },
        })
        mockExchange.createOrder.mockResolvedValue({})

        const positions: Position[] = [
          createPosition({
            symbol: "BTC/USDC:USDC",
            percentage: 0.5,
            side: "buy",
            leverage: 3,
            status: "idle",
            leverageChanged: true,
          }),
        ]

        await client.rebalancePositions(positions, 1000)

        expect(mockExchange.setLeverage).toHaveBeenCalledWith(
          3,
          "BTC/USDC:USDC",
          { vaultAddress: "0xVaultAddress" },
        )
        expect(mockExchange.createOrder).toHaveBeenCalledWith(
          "BTC/USDC:USDC",
          "market",
          "buy",
          0.01,
          52500,
          { vaultAddress: "0xVaultAddress" },
        )
      })

      it("includes vault address in close position orders", async () => {
        const vaultCredentials: WalletCredentials = {
          ...mockCredentials,
          vaultAddress: "0xVaultAddress",
        }
        client = new HyperliquidClient(vaultCredentials, "testnet")
        mockExchange.fetchTicker.mockResolvedValue({ last: 50000 })
        mockExchange.fetchPositions.mockResolvedValue([
          { symbol: "BTC/USDC:USDC", side: "long", contracts: 0.01 },
        ])
        mockExchange.createOrder.mockResolvedValue({})

        const positions: Position[] = [
          createPosition({
            symbol: "BTC/USDC:USDC",
            percentage: 0,
            side: "buy",
            leverage: 2,
            status: "deleted",
          }),
        ]

        await client.rebalancePositions(positions, 1000)

        expect(mockExchange.createOrder).toHaveBeenCalledWith(
          "BTC/USDC:USDC",
          "market",
          "sell",
          0.01,
          expect.any(Number),
          { reduceOnly: true, vaultAddress: "0xVaultAddress" },
        )
      })
    })
  })

  describe("getAccountSummary", () => {
    it("returns account summary from balance info", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchBalance.mockResolvedValue({
        total: { USDC: 1000 },
        info: {
          marginSummary: {
            accountValue: "1500.50",
            totalNtlPos: "3000.00",
          },
          withdrawable: "500.25",
        },
      })

      const summary = await client.getAccountSummary()

      expect(summary.accountValue).toBe(1500.5)
      expect(summary.totalNotionalPosition).toBe(3000)
      expect(summary.withdrawable).toBe(500.25)
    })

    it("returns zeros when info is missing", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchBalance.mockResolvedValue({
        total: { USDC: 1000 },
      })

      const summary = await client.getAccountSummary()

      expect(summary.accountValue).toBe(0)
      expect(summary.totalNotionalPosition).toBe(0)
      expect(summary.withdrawable).toBe(0)
    })

    it("handles numeric values in marginSummary", async () => {
      client = new HyperliquidClient(mockCredentials, "testnet")
      mockExchange.fetchBalance.mockResolvedValue({
        total: { USDC: 1000 },
        info: {
          marginSummary: {
            accountValue: 2000,
            totalNtlPos: 4000,
          },
          withdrawable: 1000,
        },
      })

      const summary = await client.getAccountSummary()

      expect(summary.accountValue).toBe(2000)
      expect(summary.totalNotionalPosition).toBe(4000)
      expect(summary.withdrawable).toBe(1000)
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
