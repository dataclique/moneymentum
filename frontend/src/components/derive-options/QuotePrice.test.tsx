import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, expect, it, vi } from "vitest"

import { QuotePrice } from "./QuotePrice"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it.each(["button", "span"] as const)(
  "retains quote flashing for a %s",
  mode => {
    vi.useFakeTimers()
    const [price, setPrice] = createSignal<number | null>(12)
    const { container } = render(() => (
      <QuotePrice
        side="bid"
        value={price}
        isSelected={() => false}
        onSelect={mode === "button" ? vi.fn() : undefined}
      />
    ))
    const host = container.querySelector(mode)
    expect(host).not.toHaveClass("quote-flash")

    setPrice(13)
    expect(host).toHaveClass("quote-flash")
    vi.advanceTimersByTime(300)
    expect(host).not.toHaveClass("quote-flash")
  },
)
