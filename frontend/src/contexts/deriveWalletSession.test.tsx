import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Deferred from "effect/Deferred"
import { cleanup, renderHook, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ParentProps } from "solid-js"
import type {
  DeriveCcxtExchange,
  DeriveCcxtOrder,
} from "@/services/derive/exchange"
import { useRebalanceDerivePositions } from "@/hooks/useTrading"

import { useWallet } from "@/hooks/useWallet"
import { WalletProvider } from "@/contexts/WalletProvider"
import {
  DERIVE_WALLET_STORAGE_KEY,
  WALLET_STORAGE_KEY,
} from "@/contexts/wallet-context"
import { encryptWalletPrivateKey } from "@/services/walletCredentialCrypto"

const tradingBoundary = vi.hoisted(() => ({
  loadMarkets: vi.fn<DeriveCcxtExchange["loadMarkets"]>(),
  createOrder: vi.fn<DeriveCcxtExchange["createOrder"]>(),
}))

vi.mock("ccxt/derive", () => ({
  default: vi.fn(function DeriveMock(this: {
    setSandboxMode: ReturnType<typeof vi.fn>
    urls: { api: Record<string, string> }
    options: Record<string, unknown>
  }) {
    this.setSandboxMode = vi.fn()
    this.urls = { api: {} }
    this.options = {}
    Object.assign(this, tradingBoundary, {
      markets: { "ETH-PERP": { symbol: "ETH-PERP", swap: true } },
      market: () => ({ symbol: "ETH-PERP", swap: true }),
    })
    return this
  }),
}))

vi.mock("@/services/hyperliquid-client", async importOriginal => {
  const actual =
    await importOriginal<typeof import("@/services/hyperliquid-client")>()
  class MockHyperliquidClient {
    getBalance = vi.fn()
    getCurrentPositions = vi.fn()
    rebalancePositions = vi.fn()
    getNetworkMode = vi.fn()
    getWalletAddress = vi.fn()
  }
  return {
    ...actual,
    HyperliquidClient: MockHyperliquidClient,
  }
})

vi.mock("@/services/hyperliquidClientLoader", async () => {
  const clientModule = await import("@/services/hyperliquid-client")
  return {
    prefetchHyperliquidClientModule: () => undefined,
    ensureHyperliquidClientModule: async () => clientModule,
  }
})

vi.mock("@/reown/evmAppKit", () => ({
  ensureEvmAppKit: async () => null,
  prefetchEvmAppKit: () => undefined,
  readConnectedEip1193Provider: () => null,
  readEvmAddressFromAccountState: () => null,
  readEvmWalletConnectedFromAccountState: () => false,
  readReownProjectId: () => "test-project-id",
}))

const wrapper = (props: ParentProps) => (
  <WalletProvider>{props.children}</WalletProvider>
)

const TEST_PIN = "654321"
const SESSION_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const DERIVE_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

describe("Derive encrypted session via WalletProvider", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it("encrypts a Derive session and unlocks it after remount", async () => {
    const { result } = renderHook(() => useWallet(), { wrapper })

    await Effect.runPromise(
      result.connectDerive(
        {
          deriveWallet: DERIVE_WALLET,
          sessionPrivateKey: SESSION_PRIVATE_KEY,
          subaccountId: 42,
        },
        TEST_PIN,
      ),
    )

    expect(result.isDeriveConnected()).toBe(true)
    expect(result.isDeriveLocked()).toBe(false)
    expect(result.deriveCredentials()?.sessionPrivateKey).toBe(
      SESSION_PRIVATE_KEY,
    )
    expect(result.deriveCredentials()?.subaccountId).toBe(42)
    expect(result.deriveCredentials()?.networkMode).toBe("testnet")
    expect(result.storedDeriveWallet()).toBe(DERIVE_WALLET)
    expect(localStorage.getItem(DERIVE_WALLET_STORAGE_KEY)).not.toBeNull()

    const reloaded = renderHook(() => useWallet(), { wrapper }).result
    expect(reloaded.isDeriveConnected()).toBe(true)
    expect(reloaded.isDeriveLocked()).toBe(true)
    expect(reloaded.storedDeriveWallet()).toBe(DERIVE_WALLET)

    await Effect.runPromise(reloaded.unlock(TEST_PIN))
    expect(reloaded.isDeriveLocked()).toBe(false)
    expect(reloaded.deriveCredentials()?.sessionPrivateKey).toBe(
      SESSION_PRIVATE_KEY,
    )
    expect(reloaded.deriveCredentials()?.subaccountId).toBe(42)
    expect(reloaded.deriveCredentials()?.networkMode).toBe("testnet")
  })

  it("keeps both venues locked when a decrypted Derive key is invalid", async () => {
    const encryptedHyperliquid = await encryptWalletPrivateKey(
      SESSION_PRIVATE_KEY,
      TEST_PIN,
    )
    const encryptedDerive = await encryptWalletPrivateKey(
      "invalid-key",
      TEST_PIN,
    )
    localStorage.setItem(
      WALLET_STORAGE_KEY,
      JSON.stringify({
        accountAddress: DERIVE_WALLET,
        apiWalletAddress: DERIVE_WALLET,
        ...encryptedHyperliquid,
      }),
    )
    localStorage.setItem(
      DERIVE_WALLET_STORAGE_KEY,
      JSON.stringify({
        deriveWallet: DERIVE_WALLET,
        sessionAddress: DERIVE_WALLET,
        networkMode: "testnet",
        subaccountId: 42,
        ...encryptedDerive,
      }),
    )
    const { result } = renderHook(() => useWallet(), { wrapper })

    const unlocking = await Effect.runPromiseExit(result.unlock(TEST_PIN))

    expect(Exit.isFailure(unlocking)).toBe(true)
    expect(result.credentials()).toBeNull()
    expect(result.deriveCredentials()).toBeNull()
    expect(result.canTrade()).toBe(false)
    expect(result.isDeriveLocked()).toBe(true)
  })

  it("treats a Derive session as disconnected when the network toggle differs", async () => {
    const { result } = renderHook(() => useWallet(), { wrapper })

    await Effect.runPromise(
      result.connectDerive(
        {
          deriveWallet: DERIVE_WALLET,
          sessionPrivateKey: SESSION_PRIVATE_KEY,
        },
        TEST_PIN,
      ),
    )

    expect(result.isDeriveConnected()).toBe(true)
    result.setNetworkMode("mainnet")
    expect(result.isDeriveConnected()).toBe(false)
    expect(result.deriveCredentials()).toBeNull()

    result.setNetworkMode("testnet")
    expect(result.isDeriveConnected()).toBe(true)
    expect(result.isDeriveLocked()).toBe(true)
  })

  it.each([
    "network",
    "subaccount",
    "disconnect",
    "storage",
    "wallet",
    "provider-disposed",
  ] as const)(
    "retains an accepted prefix and stops trading after %s changes",
    async change => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      })
      const executionWrapper = (props: ParentProps) => (
        <QueryClientProvider client={queryClient}>
          <WalletProvider>{props.children}</WalletProvider>
        </QueryClientProvider>
      )
      const { result } = renderHook(
        () => ({
          wallet: useWallet(),
          mutation: useRebalanceDerivePositions(),
        }),
        { wrapper: executionWrapper },
      )
      const accepted = Effect.runSync(Deferred.make<DeriveCcxtOrder>())
      tradingBoundary.loadMarkets.mockReset().mockResolvedValue({})
      tradingBoundary.createOrder
        .mockReset()
        .mockImplementationOnce(() =>
          Effect.runPromise(Deferred.await(accepted)),
        )
        .mockResolvedValue({
          id: "must-not-submit",
          symbol: "ETH-PERP",
          side: "buy",
          status: "open",
        })
      const debug = vi
        .spyOn(console, "debug")
        .mockImplementation(() => undefined)

      try {
        await Effect.runPromise(
          result.wallet.connectDerive(
            {
              deriveWallet: DERIVE_WALLET,
              sessionPrivateKey: SESSION_PRIVATE_KEY,
              subaccountId: 42,
            },
            TEST_PIN,
          ),
        )
        const completion = result.mutation
          .mutateAsync({
            requests: [
              { symbol: "ETH-PERP", side: "buy", amount: 0.01, price: 2000 },
              { symbol: "ETH-PERP", side: "buy", amount: 0.02, price: 2000 },
            ],
          })
          .then(
            outcome => ({ outcome }),
            (error: unknown) => ({ error }),
          )
        await waitFor(() => {
          expect(tradingBoundary.createOrder).toHaveBeenCalledTimes(1)
        })
        expect(tradingBoundary.createOrder).toHaveBeenNthCalledWith(
          1,
          "ETH-PERP",
          "limit",
          "buy",
          0.01,
          2000,
          expect.objectContaining({ subaccount_id: 42 }),
        )
        switch (change) {
          case "network":
            result.wallet.setNetworkMode("mainnet")
            break
          case "subaccount":
            result.wallet.setDeriveSubaccountId(43)
            break
          case "disconnect":
            await Effect.runPromise(result.wallet.disconnectDerive())
            break
          case "storage":
            window.dispatchEvent(
              new StorageEvent("storage", { key: DERIVE_WALLET_STORAGE_KEY }),
            )
            break
          case "wallet":
            result.wallet.setMainAddress(
              "0x0000000000000000000000000000000000000001",
            )
            break
          case "provider-disposed":
            cleanup()
            break
        }
        Effect.runSync(
          Deferred.succeed(accepted, {
            id: "accepted-before-context-change",
            symbol: "ETH-PERP",
            side: "buy",
            status: "open",
            amount: 0.01,
            filled: 0,
            remaining: 0.01,
          }),
        )
        const completed = await completion

        expect(tradingBoundary.createOrder).toHaveBeenCalledTimes(1)
        expect(completed).toMatchObject({
          outcome: {
            terminal: "cancelled",
            outcomes: [
              { kind: "accepted", orderId: "accepted-before-context-change" },
            ],
          },
        })
        expect(debug).toHaveBeenCalledWith(
          "[derive] order batch stopped",
          expect.objectContaining({
            terminal: "cancelled",
            accepted: 1,
          }),
        )
      } finally {
        debug.mockRestore()
        queryClient.clear()
      }
    },
  )

  it("clears the Derive session on disconnectDerive", async () => {
    const { result } = renderHook(() => useWallet(), { wrapper })

    await Effect.runPromise(
      result.connectDerive(
        {
          deriveWallet: DERIVE_WALLET,
          sessionPrivateKey: SESSION_PRIVATE_KEY,
        },
        TEST_PIN,
      ),
    )

    await Effect.runPromise(result.disconnectDerive())
    expect(result.isDeriveConnected()).toBe(false)
    expect(result.deriveCredentials()).toBeNull()
    expect(localStorage.getItem(DERIVE_WALLET_STORAGE_KEY)).toBeNull()
    expect(result.storedDeriveWallet()).toBeNull()
  })
})
