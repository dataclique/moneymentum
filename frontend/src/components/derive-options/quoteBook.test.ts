import * as Effect from "effect/Effect"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { describe, expect, it } from "vitest"

/* eslint-disable solid/reactivity -- assertions read the store after each apply */

import {
  decodeOptionsSnapshot,
  type OptionQuote,
  type OptionsSnapshot,
} from "./optionsSnapshot"
import {
  applyOptionsSnapshot,
  emptyQuoteBook,
  skeletonizeQuoteBook,
  type QuoteBook,
} from "./quoteBook"
import { useDeriveOrderSelection } from "./useDeriveOrderSelection"

const sampleQuote = (overrides: Partial<OptionQuote> = {}): OptionQuote => ({
  instrument_name: "ETH-20260327-2000-C",
  kind: "C",
  strike: 2000,
  expiry: "2026-03-27",
  expiry_unix: 1_774_569_600 as OptionQuote["expiry_unix"],
  bid: 90,
  ask: 95,
  bid_size: 1,
  ask_size: 1,
  mark: 92,
  spot_price: 2100,
  moneyness: "in_the_money",
  greeks: {
    bid_iv: 0.4,
    ask_iv: 0.42,
    delta: 0.55,
    gamma: 0.01,
    vega: 10,
    theta: -5,
    iv: 0.41,
    rho: -1,
    forward_price: 2100,
    discount_factor: 0.99,
    option_model_mark: 92,
  },
  ...overrides,
})

const snapshotWithQuotes = (quotes: OptionQuote[]): OptionsSnapshot => ({
  asset: "ETH",
  updated_at: "2026-03-01T00:00:00Z",
  active_expiry_unix: 1_774_569_600 as OptionQuote["expiry_unix"],
  expiry_unixes: [1_774_569_600 as OptionQuote["expiry_unix"]],
  spot_price: 2100,
  expiry_dates: ["2026-03-27"],
  strikes: [...new Set(quotes.map(quote => quote.strike))],
  quotes,
})

const callQuote = sampleQuote({
  instrument_name: "ETH-20260327-2000-C",
  kind: "C",
})
const putQuote = sampleQuote({
  instrument_name: "ETH-20260327-2000-P",
  kind: "P",
  bid: 40,
  ask: 42,
  mark: 41,
  moneyness: "out_of_the_money",
  greeks: {
    ...callQuote.greeks,
    delta: -0.3,
  },
})

describe("applyOptionsSnapshot", () => {
  it.each(
    ["__proto__", "constructor", "toString"].flatMap(instrumentName =>
      ["store", "omitted", "plain"].map(previousSource => ({
        instrumentName,
        previousSource,
      })),
    ),
  )(
    "reconciles external key $instrumentName with $previousSource previous quotes",
    ({ instrumentName, previousSource }) => {
      createRoot(dispose => {
        const [book, setBook] = createStore(emptyQuoteBook())
        const originalPrototype = Object.getPrototypeOf(book.byInstrument)
        const snapshot = Effect.runSync(
          decodeOptionsSnapshot(
            snapshotWithQuotes([
              sampleQuote({ instrument_name: instrumentName }),
            ]),
          ),
        )

        const previousQuotes =
          previousSource === "store"
            ? book.byInstrument
            : previousSource === "plain"
              ? {}
              : undefined
        applyOptionsSnapshot(setBook, snapshot, previousQuotes)

        expect(book.instrumentNamesAsc).toEqual([instrumentName])
        expect(Object.keys(book.byInstrument)).toEqual([instrumentName])
        expect(book.byInstrument[instrumentName].bid).toBe(90)
        expect(book.callByStrike[2000]).toBe(instrumentName)
        expect(book.byInstrument["hasOwnProperty"]).toBeUndefined()
        expect(Object.getPrototypeOf(book.byInstrument)).toBe(originalPrototype)

        applyOptionsSnapshot(
          setBook,
          snapshotWithQuotes([
            sampleQuote({ instrument_name: instrumentName, bid: 91 }),
          ]),
          book.byInstrument,
        )
        expect(book.byInstrument[instrumentName].bid).toBe(91)

        skeletonizeQuoteBook(setBook)
        expect(book.byInstrument[instrumentName].bid).toBeNull()
        expect(Object.getPrototypeOf(book.byInstrument)).toBe(originalPrototype)

        applyOptionsSnapshot(
          setBook,
          snapshotWithQuotes([callQuote]),
          book.byInstrument,
        )
        expect(book.instrumentNamesAsc).toEqual([callQuote.instrument_name])
        expect(Object.keys(book.byInstrument)).toEqual([
          callQuote.instrument_name,
        ])
        expect(book.byInstrument[instrumentName]).toBeUndefined()
        expect(Object.getPrototypeOf(book.byInstrument)).toBe(originalPrototype)
        dispose()
      })
    },
  )

  it("applies catalogue metadata even when every quote is unchanged", () => {
    createRoot(dispose => {
      const [book, setBook] = createStore(emptyQuoteBook())
      const initial = snapshotWithQuotes([callQuote])
      applyOptionsSnapshot(setBook, initial, book.byInstrument)
      const nextExpiry = 1_806_019_200 as OptionQuote["expiry_unix"]
      const next = {
        ...initial,
        expiry_unixes: [...initial.expiry_unixes, nextExpiry],
        expiry_dates: [...initial.expiry_dates, "2027-03-26"],
      }

      applyOptionsSnapshot(setBook, next, book.byInstrument)

      expect(book.expiry_unixes).toEqual(next.expiry_unixes)
      expect(book.expiry_dates).toEqual(next.expiry_dates)
      expect(book.byInstrument[callQuote.instrument_name]).toMatchObject({
        bid: callQuote.bid,
      })
      dispose()
    })
  })

  it("clears all instrument and strike entries on an empty snapshot", () => {
    createRoot(dispose => {
      const [book, setBook] = createStore(emptyQuoteBook())
      applyOptionsSnapshot(
        setBook,
        snapshotWithQuotes([callQuote, putQuote]),
        book.byInstrument,
      )
      applyOptionsSnapshot(
        setBook,
        {
          ...snapshotWithQuotes([]),
          active_expiry_unix: null,
          expiry_unixes: [],
          expiry_dates: [],
        },
        book.byInstrument,
      )

      expect(book.byInstrument).toEqual({})
      expect(book.callByStrike).toEqual({})
      expect(book.putByStrike).toEqual({})
      expect(book.instrumentNamesAsc).toEqual([])
      expect(book.strikesAsc).toEqual([])
      expect(book.expiry_unixes).toEqual([])
      expect(book.active_expiry_unix).toBeNull()
      dispose()
    })
  })

  it("drops a call/put leg that a later snapshot omits", () => {
    createRoot(dispose => {
      const [book, setBook] = createStore(emptyQuoteBook())

      applyOptionsSnapshot(
        setBook,
        snapshotWithQuotes([callQuote, putQuote]),
        book.byInstrument,
        { applyColdGreeks: true },
      )
      expect(book.callByStrike[2000]).toBe("ETH-20260327-2000-C")
      expect(book.putByStrike[2000]).toBe("ETH-20260327-2000-P")
      expect(book.byInstrument["ETH-20260327-2000-P"]).toBeDefined()

      applyOptionsSnapshot(
        setBook,
        snapshotWithQuotes([callQuote]),
        book.byInstrument,
        { applyColdGreeks: true },
      )

      expect(book.callByStrike[2000]).toBe("ETH-20260327-2000-C")
      expect(book.putByStrike[2000]).toBeUndefined()
      expect(book.byInstrument["ETH-20260327-2000-P"]).toBeUndefined()

      const selection = useDeriveOrderSelection({
        book,
        onOpenOrderPanel: () => undefined,
      })
      selection.handleQuoteSelect("ETH-20260327-2000-P", "ask")
      expect(selection.selection()).toBeNull()

      expect(chainLegInstrument(book, 2000, "put")).toBeUndefined()

      dispose()
    })
  })
})

const chainLegInstrument = (
  book: QuoteBook,
  strike: number,
  leg: "call" | "put",
): string | undefined =>
  leg === "call" ? book.callByStrike[strike] : book.putByStrike[strike]
