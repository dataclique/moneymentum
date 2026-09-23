import { cleanup, renderHook, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { createSignal, onCleanup, type ParentProps } from "solid-js"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type {
  DeriveWalletCredentials,
  WalletContextType,
} from "@/contexts/wallet-context"
import type {
  DeriveAccountSnapshot,
  DeriveBalanceSummary,
  DeriveCcxtOrder,
  fetchDeriveAccountSnapshot,
  fetchDeriveBalance,
  fetchDeriveOpenOrders,
} from "@/services/derive/index"
import { HttpStatusError } from "@/lib/http"
import { ExchangeRequestError } from "@/services/hyperliquid"

import {
  useDeriveAccountSnapshot,
  useDeriveBalance,
  useDeriveOpenOrders,
} from "./useTrading"

const wallet = vi.hoisted(() => ({
  useWallet:
    vi.fn<
      () => Pick<
        WalletContextType,
        | "deriveCredentials"
        | "networkMode"
        | "isDeriveConnected"
        | "isDeriveLocked"
      >
    >(),
}))
const venue = vi.hoisted(() => ({
  orders: vi.fn<typeof fetchDeriveOpenOrders>(),
  balance: vi.fn<typeof fetchDeriveBalance>(),
  account: vi.fn<typeof fetchDeriveAccountSnapshot>(),
}))

vi.mock("./useWallet", () => ({ useWallet: wallet.useWallet }))
vi.mock("@/services/derive/index", async importOriginal => ({
  ...(await importOriginal<typeof import("@/services/derive/index")>()),
  fetchDeriveOpenOrders: venue.orders,
  fetchDeriveBalance: venue.balance,
  fetchDeriveAccountSnapshot: venue.account,
}))

// Synthetic credentials: all venue reads are replaced, and no signing occurs.
const credentials: DeriveWalletCredentials = {
  deriveWallet: "test-wallet",
  sessionAddress: "test-session",
  sessionPrivateKey: "0x01",
  subaccountId: 7,
  networkMode: "testnet",
}
const openOrder: DeriveCcxtOrder = {
  id: "order-1",
  symbol: "ETH-PERP",
  status: "open",
  filled: 0,
}
const balance = (accountValue: number): DeriveBalanceSummary => ({
  accountValue,
  positionsValue: 0,
  collateralsValue: accountValue,
  totals: {},
})
const account = (positionsValue: string): DeriveAccountSnapshot => ({
  deriveWallet: credentials.deriveWallet,
  subaccountIds: [7],
  subaccounts: [
    {
      subaccountId: 7,
      subaccountValue: "100",
      collateralsValue: "100",
      initialMargin: "0",
      maintenanceMargin: "0",
      positionsValue,
      positions: [],
    },
  ],
})
const debug = vi.spyOn(console, "debug")

afterAll(() => {
  debug.mockRestore()
})
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  venue.balance.mockReturnValue(Effect.succeed(balance(100)))
  venue.account.mockReturnValue(Effect.succeed(account("0")))
})

const setup = async (initialOrders: DeriveCcxtOrder[]) => {
  const [session, setSession] = createSignal<DeriveWalletCredentials | null>(
    credentials,
  )
  wallet.useWallet.mockReturnValue({
    deriveCredentials: session,
    networkMode: () => "testnet",
    isDeriveConnected: () => true,
    isDeriveLocked: () => false,
  })
  venue.orders.mockReturnValue(Effect.succeed(initialOrders))
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  const wrapper = (props: ParentProps) => {
    onCleanup(() => {
      queryClient.clear()
    })
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    )
  }
  const { result } = renderHook(
    () => ({
      balance: useDeriveBalance(),
      account: useDeriveAccountSnapshot(),
      orders: useDeriveOpenOrders(),
    }),
    { wrapper },
  )
  await waitFor(() => {
    expect(result.orders.isSuccess).toBe(true)
    expect(result.balance.data?.accountValue).toBe(100)
    expect(
      result.account.data?.subaccounts.map(
        subaccount => subaccount.positionsValue,
      ),
    ).toEqual(["0"])
    expect(result.balance.isFetching || result.account.isFetching).toBe(false)
  })
  debug.mockClear()
  return { result, queryClient, setSession }
}

describe("Derive order-driven account refresh", () => {
  it.each([
    { label: "an order appears", initial: [], next: [openOrder] },
    { label: "an order remains open", initial: [openOrder], next: [openOrder] },
    {
      label: "a partial fill changes",
      initial: [openOrder],
      next: [{ ...openOrder, filled: 0.25 }],
    },
    { label: "the final order disappears", initial: [openOrder], next: [] },
  ])("refreshes both projections when $label", async ({ initial, next }) => {
    const { result, queryClient } = await setup(initial)
    const unrelatedKeys = [
      ["derive", "balance", "other-wallet", 7, "testnet"],
      ["derive", "balance", credentials.deriveWallet, 8, "testnet"],
      ["derive", "balance", credentials.deriveWallet, 7, "mainnet"],
      ["derive", "account", "other-wallet", "testnet"],
      ["derive", "account", credentials.deriveWallet, "mainnet"],
    ]
    unrelatedKeys.forEach(queryKey => {
      queryClient.setQueryData(queryKey, balance(100))
    })
    venue.orders.mockReturnValue(Effect.succeed(next))
    venue.balance.mockReturnValue(Effect.succeed(balance(125)))
    venue.account.mockReturnValue(Effect.succeed(account("20")))

    await result.orders.refetch()

    await waitFor(() => {
      expect(result.balance.data?.accountValue).toBe(125)
      expect(
        result.account.data?.subaccounts.map(
          subaccount => subaccount.positionsValue,
        ),
      ).toEqual(["20"])
    })
    unrelatedKeys.forEach(queryKey => {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
    })
    expect(debug).toHaveBeenCalledWith(
      "[derive] account query refresh settled after order snapshot",
      {
        openOrderCount: next.length,
      },
    )
  })

  it("does not amplify repeated empty polling into account requests", async () => {
    const { result } = await setup([])
    const balanceCalls = venue.balance.mock.calls.length
    const accountCalls = venue.account.mock.calls.length

    await result.orders.refetch()

    expect(venue.balance).toHaveBeenCalledTimes(balanceCalls)
    expect(venue.account).toHaveBeenCalledTimes(accountCalls)
    expect(debug).not.toHaveBeenCalled()
  })

  it("retains known projections when the order read fails", async () => {
    const { result } = await setup([openOrder])
    const balanceCalls = venue.balance.mock.calls.length
    const accountCalls = venue.account.mock.calls.length
    venue.orders.mockReturnValue(
      Effect.fail(new ExchangeRequestError({ cause: "venue unavailable" })),
    )

    await result.orders.refetch()

    expect(result.orders.isError).toBe(true)
    expect(result.orders.data).toEqual([openOrder])
    expect(result.balance.data?.accountValue).toBe(100)
    expect(venue.balance).toHaveBeenCalledTimes(balanceCalls)
    expect(venue.account).toHaveBeenCalledTimes(accountCalls)
    expect(debug).not.toHaveBeenCalled()
  })

  it("exposes failed projection refreshes without losing the last known account", async () => {
    const { result } = await setup([openOrder])
    venue.balance.mockReturnValue(
      Effect.fail(new ExchangeRequestError({ cause: "balance unavailable" })),
    )
    venue.account.mockReturnValue(
      Effect.fail(new HttpStatusError({ status: 503 })),
    )

    await result.orders.refetch()

    expect(result.orders.isSuccess).toBe(true)
    expect(result.balance.isError).toBe(true)
    expect(result.account.isError).toBe(true)
    expect(result.balance.data?.accountValue).toBe(100)
    expect(
      result.account.data?.subaccounts.map(
        subaccount => subaccount.positionsValue,
      ),
    ).toEqual(["0"])
    expect(debug).toHaveBeenCalledWith(
      "[derive] account query refresh settled after order snapshot",
      {
        openOrderCount: 1,
      },
    )
  })

  it("does not refresh account queries after the initiating session is gone", async () => {
    const { result, queryClient, setSession } = await setup([openOrder])
    const response = Effect.runSync(Deferred.make<DeriveCcxtOrder[]>())
    venue.orders.mockReturnValueOnce(Deferred.await(response))
    const orderCalls = venue.orders.mock.calls.length
    const pending = result.orders.refetch()
    await waitFor(() => {
      expect(venue.orders).toHaveBeenCalledTimes(orderCalls + 1)
    })
    const balanceCalls = venue.balance.mock.calls.length
    const accountCalls = venue.account.mock.calls.length

    setSession(null)
    Effect.runSync(Deferred.succeed(response, []))
    await pending

    expect(
      queryClient.getQueryState([
        "derive",
        "balance",
        credentials.deriveWallet,
        7,
        "testnet",
      ])?.isInvalidated,
    ).toBe(false)
    expect(
      queryClient.getQueryState([
        "derive",
        "account",
        credentials.deriveWallet,
        "testnet",
      ])?.isInvalidated,
    ).toBe(false)
    expect(venue.balance).toHaveBeenCalledTimes(balanceCalls)
    expect(venue.account).toHaveBeenCalledTimes(accountCalls)
    expect(debug).not.toHaveBeenCalled()
  })
})
