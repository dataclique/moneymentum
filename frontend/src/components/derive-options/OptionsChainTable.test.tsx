import { cleanup, render, screen } from "@solidjs/testing-library"
import * as Schema from "effect/Schema"
import { untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { afterEach, expect, it, vi } from "vitest"

import { OptionsChainTable } from "./OptionsChainTable"
import { EMPTY_OPTION_GREEKS, OptionsSnapshot } from "./optionsSnapshot"
import { applyOptionsSnapshot, emptyQuoteBook } from "./quoteBook"

afterEach(cleanup)

const snapshot = (spot: number): OptionsSnapshot =>
  Schema.decodeUnknownSync(OptionsSnapshot)({
    asset: "ETH",
    updated_at: "2026-12-01T00:00:00Z",
    active_expiry_unix: 1798790400,
    expiry_unixes: [1798790400],
    spot_price: spot,
    expiry_dates: ["2027-01-01"],
    strikes: [2000],
    quotes: [
      {
        instrument_name: "ETH-20270101-2000-C",
        kind: "C",
        strike: 2000,
        expiry: "2027-01-01",
        expiry_unix: 1798790400,
        bid: 90,
        ask: 95,
        bid_size: 1,
        ask_size: 1,
        mark: 92,
        spot_price: spot,
        moneyness: "in_the_money",
        greeks: EMPTY_OPTION_GREEKS,
      },
    ],
  })

it("updates the spot badge without replacing stable table rows", () => {
  const [book, setBook] = createStore(emptyQuoteBook())
  applyOptionsSnapshot(setBook, snapshot(2100))
  const { container } = render(() => (
    <OptionsChainTable
      book={book}
      selectedAsset={() => "ETH"}
      selectedExpiryUnix={() => null}
      selection={() => null}
      onQuoteSelect={vi.fn()}
    />
  ))
  const badge = screen.getByText("ETH $2,100.00")
  const strikeRow = container.querySelector("tbody tr")
  expect(strikeRow).not.toBeNull()

  applyOptionsSnapshot(
    setBook,
    snapshot(2200),
    untrack(() => book.byInstrument),
  )

  expect(screen.getByText("ETH $2,200.00")).toBe(badge)
  expect(container.querySelector("tbody tr")).toBe(strikeRow)
})
