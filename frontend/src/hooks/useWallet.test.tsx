import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  const ensureLocalStorage = () => {
    const globalAny = globalThis as { localStorage?: Storage }
    if (
      !globalAny.localStorage ||
      typeof globalAny.localStorage.clear !== "function"
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
  }

  beforeEach(() => {
    ensureLocalStorage()
    localStorage.clear()
  })

  afterEach(() => {
    ensureLocalStorage()
    localStorage.clear()
  })

  it("starts disconnected with default testnet mode", () => {
    const { result } = renderHook(() => useWallet(), { wrapper })

    expect(result.credentials()).toBeNull()
    expect(result.isConnected()).toBe(false)
    expect(result.networkMode()).toBe("testnet")
  })

  it("does not auto-restore credentials on mount (private key is never persisted)", () => {
    // Even a legacy or tampered entry that contains a private key must not be
    // trusted: credentials are never restored from localStorage on mount.
    localStorage.setItem(
      "hyperliquid-wallet",
      JSON.stringify({
        accountAddress: "0xStoredAccountAddress",
        apiWalletAddress: "0xStoredApiWalletAddress",
        privateKey: "STORED_PRIVATE_KEY",
      }),
    )

    const { result } = renderHook(() => useWallet(), { wrapper })

    expect(result.credentials()).toBeNull()
    expect(result.isConnected()).toBe(false)
  })

  it("reads network mode from localStorage", () => {
    localStorage.setItem("hyperliquid-network", "mainnet")

    const { result } = renderHook(() => useWallet(), { wrapper })
    expect(result.networkMode()).toBe("mainnet")
  })

  it("keeps the private key in memory but never in localStorage; disconnect clears both", () => {
    const { result } = renderHook(() => useWallet(), { wrapper })
    const credentials = {
      accountAddress: "0xTestAccountAddress",
      apiWalletAddress: "0xTestApiWalletAddress",
      privateKey: "TEST_PRIVATE_KEY_PLACEHOLDER",
      vaultAddress: "0xVault",
    }

    result.connect(credentials)

    expect(result.isConnected()).toBe(true)
    // Full credentials (including the private key) live in memory only.
    expect(result.credentials()).toEqual(credentials)
    // localStorage holds public address metadata only -- never the private key.
    const stored = JSON.parse(
      localStorage.getItem("hyperliquid-wallet") ?? "{}",
    )
    expect(stored).toEqual({
      accountAddress: "0xTestAccountAddress",
      apiWalletAddress: "0xTestApiWalletAddress",
      vaultAddress: "0xVault",
    })
    expect(stored.privateKey).toBeUndefined()

    result.disconnect()
    expect(result.isConnected()).toBe(false)
    expect(result.credentials()).toBeNull()
    expect(localStorage.getItem("hyperliquid-wallet")).toBeNull()
  })

  it("setNetworkMode updates signal and localStorage", () => {
    const { result } = renderHook(() => useWallet(), { wrapper })

    result.setNetworkMode("mainnet")
    expect(result.networkMode()).toBe("mainnet")
    expect(localStorage.getItem("hyperliquid-network")).toBe("mainnet")
  })

  describe("errors", () => {
    it("throws error when used outside WalletProvider", () => {
      const { result } = renderHook(() => useWallet(), { wrapper })
      expect(result).toBeDefined()
      expect(() => renderHook(() => useWallet())).toThrow(
        "useWallet must be used within a WalletProvider",
      )
    })
  })
})
