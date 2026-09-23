import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterAll, afterEach, expect, it, vi } from "vitest"

import { DeriveOrderTicket } from "./DeriveOrderTicket"
import type { DeriveOrderTicketSelection } from "./orderTicket"

const runtimeWarnings = vi.hoisted(() => vi.spyOn(console, "warn"))

afterEach(cleanup)
afterAll(() => {
  runtimeWarnings.mockRestore()
})

it("shows the current instrument label as selection changes", () => {
  expect(runtimeWarnings).not.toHaveBeenCalledWith(
    "You appear to have multiple instances of Solid. This can lead to unexpected behavior.",
  )
  const [selection, setSelection] =
    createSignal<DeriveOrderTicketSelection | null>({
      instrumentName: "BTC-20270101-65000-C",
      displayLabel: "BTC $65,000 Call Jan 1",
      side: "buy",
      limitPrice: 12,
      quoteSide: "ask",
    })
  render(() => <DeriveOrderTicket selection={selection} minNotional={10} />)

  expect(screen.getByText("BTC $65,000 Call Jan 1")).toBeInTheDocument()
  setSelection({
    instrumentName: "ETH-20270101-3000-P",
    displayLabel: "ETH $3,000 Put Jan 1",
    side: "sell",
    limitPrice: 15,
    quoteSide: "bid",
  })
  expect(screen.getByText("ETH $3,000 Put Jan 1")).toBeInTheDocument()
  expect(screen.queryByText("BTC $65,000 Call Jan 1")).toBeNull()
  setSelection(null)
  expect(screen.getByText("Select an instrument to view")).toBeInTheDocument()
})
