import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook } from "@solidjs/testing-library"
import { useWallet } from "./useWallet"
import { WalletProvider } from "@/contexts/WalletProvider"
import type { ParentProps } from "solid-js"

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
  preloadMarkets: vi.fn().mockResolvedValue(undefined),
}))

const wrapper = (props: ParentProps) => (
  <WalletProvider>{props.children}</WalletProvider>
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

      expect(result.credentials()).toBeNull()
      expect(result.isConnected()).toBe(false)
    })

    it("defaults to testnet network mode", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.networkMode()).toBe("testnet")
    })

    it("restores credentials from localStorage on mount when present", () => {
      const storedMetadata = {
        accountAddress: "0xStoredAccountAddress",
        apiWalletAddress: "0xStoredApiWalletAddress",
        privateKey: "STORED_PRIVATE_KEY",
      }
      localStorage.setItem("hyperliquid-wallet", JSON.stringify(storedMetadata))

      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.credentials()).toEqual(storedMetadata)
      expect(result.isConnected()).toBe(true)
    })

    it("loads network mode from localStorage on mount", () => {
      localStorage.setItem("hyperliquid-network", "mainnet")

      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.networkMode()).toBe("mainnet")
    })

    it("handles invalid JSON in localStorage gracefully", () => {
      localStorage.setItem("hyperliquid-wallet", "invalid json")

      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.credentials()).toBeNull()
      expect(result.isConnected()).toBe(false)
    })

    it("handles invalid network mode in localStorage gracefully", () => {
      localStorage.setItem("hyperliquid-network", "invalid")

      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.networkMode()).toBe("testnet")
    })
  })

  describe("connect", () => {
    it("sets credentials and marks as connected", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      }

      result.connect(credentials)

      expect(result.credentials()).toEqual(credentials)
      expect(result.isConnected()).toBe(true)
    })

    it("persists full credentials including private key to localStorage", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      }

      result.connect(credentials)

      const stored = localStorage.getItem("hyperliquid-wallet")
      expect(stored).not.toBeNull()
      const parsed = JSON.parse(stored ?? "{}")
      expect(parsed).toEqual({
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      })
    })

    it("replaces existing credentials when connecting with new ones", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const firstCredentials = {
        accountAddress: "0xFirstAccount",
        apiWalletAddress: "0xFirstApiWallet",
        privateKey: "PRIVATE_KEY_PLACEHOLDER",
      }

      const secondCredentials = {
        accountAddress: "0xSecondAccount",
        apiWalletAddress: "0xSecondApiWallet",
        privateKey: "PRIVATE_KEY_PLACEHOLDER_2",
      }

      result.connect(firstCredentials)
      result.connect(secondCredentials)

      expect(result.credentials()).toEqual(secondCredentials)
    })
  })

  describe("disconnect", () => {
    it("clears credentials and marks as disconnected", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      }

      result.connect(credentials)

      expect(result.isConnected()).toBe(true)

      result.disconnect()

      expect(result.credentials()).toBeNull()
      expect(result.isConnected()).toBe(false)
    })

    it("removes credentials from localStorage", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      }

      result.connect(credentials)

      expect(localStorage.getItem("hyperliquid-wallet")).not.toBeNull()

      result.disconnect()

      expect(localStorage.getItem("hyperliquid-wallet")).toBeNull()
    })
  })

  describe("setNetworkMode", () => {
    it("changes network mode to mainnet", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      result.setNetworkMode("mainnet")

      expect(result.networkMode()).toBe("mainnet")
    })

    it("changes network mode to testnet", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      result.setNetworkMode("mainnet")
      result.setNetworkMode("testnet")

      expect(result.networkMode()).toBe("testnet")
    })

    it("persists network mode to localStorage", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      result.setNetworkMode("mainnet")

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
    it("does not expose private key in any public method returns", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      }

      result.connect(credentials)

      const contextKeys = Object.keys(result)
      expect(contextKeys).not.toContain("privateKey")
      expect(contextKeys).toContain("credentials")
    })

    it("keeps credentials in state but does not modify them", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      }

      result.connect(credentials)

      expect(result.credentials()?.privateKey).toBe(
        "TEST_PRIVATE_KEY_PLACEHOLDER",
      )
      expect(result.credentials()?.accountAddress).toBe("0xTestAccountAddress")
    })
  })

  describe("persistence across sessions", () => {
    it("maintains wallet connection after remount when stored in localStorage", () => {
      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      }

      const { result: firstResult, cleanup: cleanupFirst } = renderHook(
        () => useWallet(),
        {
          wrapper,
        },
      )

      firstResult.connect(credentials)

      cleanupFirst()

      const { result: secondResult } = renderHook(() => useWallet(), {
        wrapper,
      })

      expect(secondResult.credentials()).toEqual(credentials)
      expect(secondResult.isConnected()).toBe(true)
    })

    it("maintains network mode after remount", () => {
      const { result: firstResult, cleanup: cleanupFirst } = renderHook(
        () => useWallet(),
        {
          wrapper,
        },
      )

      firstResult.setNetworkMode("mainnet")

      cleanupFirst()

      const { result: secondResult } = renderHook(() => useWallet(), {
        wrapper,
      })

      expect(secondResult.networkMode()).toBe("mainnet")
    })
  })

  describe("network mode independence from credentials", () => {
    it("allows changing network mode without credentials", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      expect(result.isConnected()).toBe(false)

      result.setNetworkMode("mainnet")

      expect(result.networkMode()).toBe("mainnet")
      expect(result.isConnected()).toBe(false)
    })

    it("preserves network mode after disconnect", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })

      const credentials = {
        accountAddress: "0xTestAccountAddress",
        apiWalletAddress: "0xTestApiWalletAddress",
        privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      }

      result.connect(credentials)
      result.setNetworkMode("mainnet")
      result.disconnect()

      expect(result.networkMode()).toBe("mainnet")
      expect(result.isConnected()).toBe(false)
    })
  })
})
