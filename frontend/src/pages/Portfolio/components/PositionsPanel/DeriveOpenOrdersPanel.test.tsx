import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DeriveOpenOrdersPanel } from "./DeriveOpenOrdersPanel"

const orderFixture = vi.hoisted(() => ({
  side: undefined as string | undefined,
}))

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    isDeriveConnected: () => true,
    isDeriveLocked: () => false,
  }),
}))

vi.mock("@/hooks/useTrading", () => ({
  useDeriveSessionCredentials: () => () => ({ subaccountId: 1 }),
  useCancelDeriveOrder: () => ({ isPending: false, mutate: vi.fn() }),
  useDeriveOpenOrders: () => ({
    data: [
      {
        id: "order-1",
        symbol: "BTC/USD:USDC",
        side: orderFixture.side,
        amount: 1234.5,
        price: 2,
        status: "open",
      },
    ],
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

afterEach(cleanup)

describe("Derive open-order size", () => {
  it.each([
    ["buy", "+1,234.5"],
    ["sell", "-1,234.5"],
    [undefined, "1,234.5"],
    ["unknown", "1,234.5"],
  ])("only assigns a direction for a recognized side: %s", (side, expected) => {
    orderFixture.side = side
    render(() => <DeriveOpenOrdersPanel />)
    expect(
      screen.getByRole("cell", {
        name: accessibleName => accessibleName === expected,
      }),
    ).toBeInTheDocument()
  })
})
