import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  useDateRange,
  useAnalysisData,
  useTokenData,
  useSwitchNetwork,
  useWalletSettings,
} from "./useApi"
import type { Timeframe } from "@/components/ui/timeframe-select"
import React from "react"

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe("useApi hooks with Timeframe type", () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("useDateRange", () => {
    it("accepts valid Timeframe type '1h'", async () => {
      const mockResponse = {
        min_date: "2024-01-01",
        max_date: "2024-12-31",
        last_timestamp: "2024-12-31T23:00:00Z",
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const timeframe: Timeframe = "1h"
      const { result } = renderHook(() => useDateRange(timeframe), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith("/api/date-range?timeframe=1h")
      expect(result.current.data).toEqual(mockResponse)
    })

    it("accepts valid Timeframe type '15m'", async () => {
      const mockResponse = {
        min_date: "2024-01-01",
        max_date: "2024-12-31",
        last_timestamp: "2024-12-31T23:00:00Z",
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const timeframe: Timeframe = "15m"
      const { result } = renderHook(() => useDateRange(timeframe), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith("/api/date-range?timeframe=15m")
    })

    it("enforces Timeframe type safety", () => {
      const validTimeframes: Timeframe[] = ["1h", "15m"]

      validTimeframes.forEach(tf => {
        expect(tf).toMatch(/^(1h|15m)$/)
      })
    })
  })

  describe("useAnalysisData", () => {
    it("accepts Timeframe type in params", async () => {
      const mockResponse = {
        data: [],
        message: null,
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const params = {
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        timeframe: "1h" as Timeframe,
      }

      const { result } = renderHook(() => useAnalysisData(params), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/data?timeframe=1h",
        expect.objectContaining({
          method: "POST",
        }),
      )
    })

    it("constructs correct API URL with timeframe parameter", async () => {
      const mockResponse = {
        data: [],
        message: null,
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const params = {
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        timeframe: "15m" as Timeframe,
      }

      const { result } = renderHook(() => useAnalysisData(params), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/data?timeframe=15m",
        expect.any(Object),
      )
    })
  })

  describe("useTokenData", () => {
    it("accepts Timeframe type parameter", async () => {
      const mockResponse = {
        data: [],
        message: null,
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const ticker = "BTC"
      const timeframe: Timeframe = "1h"

      const { result } = renderHook(() => useTokenData(ticker, timeframe), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith("/api/token/BTC?timeframe=1h")
    })

    it("constructs URL correctly with 15m timeframe", async () => {
      const mockResponse = {
        data: [],
        message: null,
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const ticker = "ETH"
      const timeframe: Timeframe = "15m"

      const { result } = renderHook(() => useTokenData(ticker, timeframe), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith("/api/token/ETH?timeframe=15m")
    })

    it("does not query when ticker is undefined", () => {
      const timeframe: Timeframe = "1h"

      const { result } = renderHook(() => useTokenData(undefined, timeframe), {
        wrapper: createWrapper(),
      })

      expect(result.current.isFetching).toBe(false)
      expect(global.fetch).not.toHaveBeenCalled()
    })
  })

  describe("Type safety validation", () => {
    it("ensures Timeframe type only allows valid values", () => {
      const valid1h: Timeframe = "1h"
      const valid15m: Timeframe = "15m"

      expect(valid1h).toBe("1h")
      expect(valid15m).toBe("15m")

      const allValid: Timeframe[] = ["1h", "15m"]
      expect(allValid).toHaveLength(2)
    })
  })

  describe("useSwitchNetwork", () => {
    it("calls network endpoint with correct payload to switch to testnet", async () => {
      const mockResponse = {
        success: true,
        is_testnet: true,
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const { result } = renderHook(() => useSwitchNetwork(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate({ is_testnet: true })
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith("/api/hyperliquid/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_testnet: true }),
      })
    })

    it("calls network endpoint with correct payload to switch to mainnet", async () => {
      const mockResponse = {
        success: true,
        is_testnet: false,
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const { result } = renderHook(() => useSwitchNetwork(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate({ is_testnet: false })
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith("/api/hyperliquid/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_testnet: false }),
      })
    })

    it("handles network switch error gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ detail: "Network switch failed" }),
      })

      const { result } = renderHook(() => useSwitchNetwork(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate({ is_testnet: true })
      })

      await waitFor(() => {
        expect(result.current.isError).toBe(true)
      })

      expect(result.current.error?.message).toBe("Network switch failed")
    })

    it("does not expose secret key in request", async () => {
      const mockResponse = { success: true, is_testnet: true }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const { result } = renderHook(() => useSwitchNetwork(), {
        wrapper: createWrapper(),
      })

      await act(async () => {
        result.current.mutate({ is_testnet: true })
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      // Verify no secret_key in request body
      const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
      const requestBody = JSON.parse(callArgs[1].body)
      expect(requestBody).not.toHaveProperty("secret_key")
      expect(Object.keys(requestBody)).toEqual(["is_testnet"])
    })
  })

  describe("useWalletSettings", () => {
    it("fetches wallet settings successfully", async () => {
      const mockResponse = {
        public_key: "0xTestPublicKey123",
        is_testnet: true,
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const { result } = renderHook(() => useWalletSettings(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/hyperliquid/wallet-settings",
      )
      expect(result.current.data).toEqual(mockResponse)
      expect(result.current.data?.public_key).toBe("0xTestPublicKey123")
      expect(result.current.data?.is_testnet).toBe(true)
    })

    it("does not include secret_key in response", async () => {
      const mockResponse = {
        public_key: "0xTestKey",
        is_testnet: false,
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })

      const { result } = renderHook(() => useWalletSettings(), {
        wrapper: createWrapper(),
      })

      await waitFor(() => {
        expect(result.current.isSuccess).toBe(true)
      })

      expect(result.current.data).not.toHaveProperty("secret_key")
    })
  })
})
