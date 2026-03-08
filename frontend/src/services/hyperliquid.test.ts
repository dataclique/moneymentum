import { describe, it, expect, vi } from "vitest"
import * as Effect from "effect/Effect"
import {
  getBalance,
  getAccountSummary,
  getCurrentPositions,
  listPerpTickers,
  getLeverageLimits,
  getFundingRates,
  rebalancePositions,
  WalletNotConnected,
  ExchangeRequestError,
} from "./hyperliquid"
import type { HyperliquidClient } from "./hyperliquid-client"

const createMockClient = (
  overrides: Partial<HyperliquidClient> = {},
): HyperliquidClient =>
  ({
    getBalance: vi.fn(),
    getAccountSummary: vi.fn(),
    getCurrentPositions: vi.fn(),
    listPerpTickers: vi.fn(),
    getLeverageLimits: vi.fn(),
    getFundingRates: vi.fn(),
    rebalancePositions: vi.fn(),
    getNetworkMode: vi.fn(),
    getWalletAddress: vi.fn(),
    ...overrides,
  }) as unknown as HyperliquidClient

describe("hyperliquid Effect service", () => {
  describe("WalletNotConnected", () => {
    it("fails with WalletNotConnected when client is null", async () => {
      const exit = await Effect.runPromiseExit(getBalance(null))

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(WalletNotConnected)
        expect(exit.cause.error._tag).toBe("WalletNotConnected")
      }
    })

    it("fails for all operations when client is null", async () => {
      const operations = [
        getBalance(null),
        getAccountSummary(null),
        getCurrentPositions(null),
        listPerpTickers(null),
        getLeverageLimits(null),
        getFundingRates(null),
        rebalancePositions(null, [], 1000, 1, false),
      ]

      for (const operation of operations) {
        const exit = await Effect.runPromiseExit(operation)
        expect(exit._tag).toBe("Failure")
      }
    })
  })

  describe("delegation to HyperliquidClient", () => {
    it("getBalance delegates and returns result", async () => {
      const mockClient = createMockClient({
        getBalance: vi.fn().mockResolvedValue(1500.5),
      })

      const result = await Effect.runPromise(getBalance(mockClient))

      expect(result).toBe(1500.5)
      expect(mockClient.getBalance).toHaveBeenCalled()
    })

    it("getAccountSummary delegates and returns result", async () => {
      const summary = {
        accountValue: 1000,
        totalNotionalPosition: 2000,
        withdrawable: 500,
      }
      const mockClient = createMockClient({
        getAccountSummary: vi.fn().mockResolvedValue(summary),
      })

      const result = await Effect.runPromise(getAccountSummary(mockClient))

      expect(result).toEqual(summary)
    })

    it("getCurrentPositions delegates and returns result", async () => {
      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          side: "buy" as const,
          notional: 500,
          entryPrice: 45000,
          unrealizedPnl: 50,
          leverage: 2,
        },
      ]
      const mockClient = createMockClient({
        getCurrentPositions: vi.fn().mockResolvedValue(positions),
      })

      const result = await Effect.runPromise(getCurrentPositions(mockClient))

      expect(result).toEqual(positions)
    })

    it("listPerpTickers delegates and returns result", async () => {
      const tickers = ["BTC/USDC:USDC", "ETH/USDC:USDC"]
      const mockClient = createMockClient({
        listPerpTickers: vi.fn().mockResolvedValue(tickers),
      })

      const result = await Effect.runPromise(listPerpTickers(mockClient))

      expect(result).toEqual(tickers)
    })

    it("getLeverageLimits delegates and returns result", async () => {
      const limits = [{ symbol: "BTC/USDC:USDC", maxLeverage: 50 }]
      const mockClient = createMockClient({
        getLeverageLimits: vi.fn().mockResolvedValue(limits),
      })

      const result = await Effect.runPromise(getLeverageLimits(mockClient))

      expect(result).toEqual(limits)
    })

    it("getFundingRates delegates and returns result", async () => {
      const rates = { BTC: 0.0001, ETH: -0.0002 }
      const mockClient = createMockClient({
        getFundingRates: vi.fn().mockResolvedValue(rates),
      })

      const result = await Effect.runPromise(getFundingRates(mockClient))

      expect(result).toEqual(rates)
    })

    it("rebalancePositions passes all parameters", async () => {
      const orders = [
        {
          symbol: "BTC/USDC:USDC",
          side: "buy" as const,
          percentage: 0.5,
          status: "filled" as const,
        },
      ]
      const mockRebalance = vi.fn().mockResolvedValue(orders)
      const mockClient = createMockClient({
        rebalancePositions: mockRebalance,
      })

      const positions = [
        {
          symbol: "BTC/USDC:USDC",
          percentage: 0.5,
          side: "buy" as const,
          leverage: 2,
          leverageChanged: false,
          status: "modified" as const,
        },
      ]

      const result = await Effect.runPromise(
        rebalancePositions(mockClient, positions, 1000, 2, true),
      )

      expect(result).toEqual(orders)
      expect(mockRebalance).toHaveBeenCalledWith(positions, 1000, 2, true)
    })
  })

  describe("error wrapping", () => {
    it("wraps exchange exceptions as ExchangeRequestError", async () => {
      const ccxtError = new Error("Exchange timeout")
      const mockClient = createMockClient({
        getBalance: vi.fn().mockRejectedValue(ccxtError),
      })

      const exit = await Effect.runPromiseExit(getBalance(mockClient))

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(ExchangeRequestError)
        expect((exit.cause.error as ExchangeRequestError).cause).toBe(ccxtError)
      }
    })
  })
})
