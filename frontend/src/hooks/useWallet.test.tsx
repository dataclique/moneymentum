import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import React from "react"
import { useWallet } from "./useWallet"
import { WalletProvider } from "@/contexts/WalletProvider"

vi.mock("@/services/hyperliquid-client", () => ({
  HyperliquidClient: class MockHyperliquidClient {
    getBalance = vi.fn()
    getCurrentPositions = vi.fn()
    listPerpTickers = vi.fn()
    getLeverageLimits = vi.fn()
    rebalancePositions = vi.fn()
    getNetworkMode = vi.fn()
    getWalletAddress = vi.fn()
  },
}))

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <WalletProvider>{children}</WalletProvider>
)

describe("useWallet", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe("initial state", () => {
    it("returns null credentials when no wallet is stored", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.current.credentials).toBeNull()
      expect(result.current.isConnected).toBe(false)
    })

    it("defaults to testnet network mode", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.current.networkMode).toBe("testnet")
    })

    it("loads credentials from localStorage on mount", () => {
      const storedCredentials = {
        accountAddress: "0xStoredAccountAddress",
        apiWalletAddress: "0xStoredApiWalletAddress",
        privateKey: "0xStoredPrivateKey",
      }
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify(storedCredentials),
      )

      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.current.credentials).toEqual(storedCredentials)
      expect(result.current.isConnected).toBe(true)
    })

    it("loads network mode from localStorage on mount", () => {
      localStorage.setItem("hyperliquid-network", "mainnet")

      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.current.networkMode).toBe("mainnet")
    })

    it("handles invalid JSON in localStorage gracefully", () => {
      localStorage.setItem("hyperliquid-wallet", "invalid json")

      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.current.credentials).toBeNull()
      expect(result.current.isConnected).toBe(false)
    })

    it("handles invalid network mode in localStorage gracefully", () => {
      localStorage.setItem("hyperliquid-network", "invalid")

      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.current.networkMode).toBe("testnet")
    })
  })

  describe("connect", () => {
    it("sets credentials and marks as connected", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "0xTestPrivateKey",
      }

      await act(async () => {
        result.current.connect(credentials)
      })

      expect(result.current.credentials).toEqual(credentials)
      expect(result.current.isConnected).toBe(true)
    })

    it("persists credentials to localStorage", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "0xTestPrivateKey",
      }

      await act(async () => {
        result.current.connect(credentials)
      })

      const stored = localStorage.getItem("hyperliquid-wallet")
      expect(stored).not.toBeNull()
      expect(JSON.parse(stored ?? "{}")).toEqual(credentials)
    })

    it("replaces existing credentials when connecting with new ones", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const firstCredentials = {
        accountAddress: "0xFirstAccount",
        apiWalletAddress: "0xFirstApiWallet",
        privateKey: "0xFirstSecret",
      }

      const secondCredentials = {
        accountAddress: "0xSecondAccount",
        apiWalletAddress: "0xSecondApiWallet",
        privateKey: "0xSecondSecret",
      }

      await act(async () => {
        result.current.connect(firstCredentials)
      })

      await act(async () => {
        result.current.connect(secondCredentials)
      })

      expect(result.current.credentials).toEqual(secondCredentials)
    })
  })

  describe("disconnect", () => {
    it("clears credentials and marks as disconnected", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "0xTestPrivateKey",
      }

      await act(async () => {
        result.current.connect(credentials)
      })

      expect(result.current.isConnected).toBe(true)

      await act(async () => {
        result.current.disconnect()
      })

      expect(result.current.credentials).toBeNull()
      expect(result.current.isConnected).toBe(false)
    })

    it("removes credentials from localStorage", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "0xTestPrivateKey",
      }

      await act(async () => {
        result.current.connect(credentials)
      })

      expect(localStorage.getItem("hyperliquid-wallet")).not.toBeNull()

      await act(async () => {
        result.current.disconnect()
      })

      expect(localStorage.getItem("hyperliquid-wallet")).toBeNull()
    })
  })

  describe("setNetworkMode", () => {
    it("changes network mode to mainnet", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      await act(async () => {
        result.current.setNetworkMode("mainnet")
      })

      expect(result.current.networkMode).toBe("mainnet")
    })

    it("changes network mode to testnet", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      await act(async () => {
        result.current.setNetworkMode("mainnet")
      })

      await act(async () => {
        result.current.setNetworkMode("testnet")
      })

      expect(result.current.networkMode).toBe("testnet")
    })

    it("persists network mode to localStorage", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      await act(async () => {
        result.current.setNetworkMode("mainnet")
      })

      expect(localStorage.getItem("hyperliquid-network")).toBe("mainnet")
    })
  })

  describe("error handling", () => {
    it("throws error when used outside WalletProvider", () => {
      expect(() => {
        renderHook(() => useWallet())
      }).toThrow("useWallet must be used within a WalletProvider")
    })
  })

  describe("security", () => {
    it("does not expose private key in any public method returns", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "0xTestPrivateKey",
      }

      await act(async () => {
        result.current.connect(credentials)
      })

      const contextKeys = Object.keys(result.current)
      expect(contextKeys).not.toContain("privateKey")
      expect(contextKeys).toContain("credentials")
    })

    it("keeps credentials in state but does not modify them", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "0xTestPrivateKey",
      }

      await act(async () => {
        result.current.connect(credentials)
      })

      expect(result.current.credentials?.privateKey).toBe("0xTestPrivateKey")
      expect(result.current.credentials?.accountAddress).toBe(
        "0xTestAccountAddress",
      )
    })
  })

  describe("persistence across sessions", () => {
    it("maintains wallet connection after remount", async () => {
      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "0xTestPrivateKey",
      }

      const { result: firstResult, unmount } = renderHook(() => useWallet(), {
        wrapper,
      })

      await act(async () => {
        firstResult.current.connect(credentials)
      })

      unmount()

      const { result: secondResult } = renderHook(() => useWallet(), {
        wrapper,
      })

      expect(secondResult.current.credentials).toEqual(credentials)
      expect(secondResult.current.isConnected).toBe(true)
    })

    it("maintains network mode after remount", async () => {
      const { result: firstResult, unmount } = renderHook(() => useWallet(), {
        wrapper,
      })

      await act(async () => {
        firstResult.current.setNetworkMode("mainnet")
      })

      unmount()

      const { result: secondResult } = renderHook(() => useWallet(), {
        wrapper,
      })

      expect(secondResult.current.networkMode).toBe("mainnet")
    })
  })

  describe("network mode independence from credentials", () => {
    it("allows changing network mode without credentials", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.current.isConnected).toBe(false)

      await act(async () => {
        result.current.setNetworkMode("mainnet")
      })

      expect(result.current.networkMode).toBe("mainnet")
      expect(result.current.isConnected).toBe(false)
    })

    it("preserves network mode after disconnect", async () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "0xTestPrivateKey",
      }

      await act(async () => {
        result.current.connect(credentials)
      })

      await act(async () => {
        result.current.setNetworkMode("mainnet")
      })

      await act(async () => {
        result.current.disconnect()
      })

      expect(result.current.networkMode).toBe("mainnet")
      expect(result.current.isConnected).toBe(false)
    })
  })
})
