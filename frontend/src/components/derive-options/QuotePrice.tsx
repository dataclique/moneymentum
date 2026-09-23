import { createMemo, Show, type Accessor } from "solid-js"

import { cn } from "@/lib/cn"

import { flashQuoteChange } from "./highlightChange"
import { formatUsdPrice } from "./optionChainFormat"

export const QuotePrice = (props: {
  side: "bid" | "ask"
  value: Accessor<number | null>
  isSelected: Accessor<boolean>
  onSelect?: () => void
}) => {
  const quote = createMemo(() => props.value())
  const className = (): string => {
    const selected = props.isSelected()
    const empty = props.value() === null
    return cn(
      "d-price-btn block w-full rounded-sm px-0.5 tabular-nums",
      empty ? "text-center" : "text-right",
      props.side === "bid" ? "d-bid" : "d-ask",
      selected && props.side === "ask" && "d-price-selected-ask",
      selected && props.side === "bid" && "d-price-selected-bid",
    )
  }

  return (
    <Show
      when={props.onSelect !== undefined}
      fallback={
        <span
          class={className()}
          ref={element => {
            flashQuoteChange(element, quote)
          }}
        >
          {formatUsdPrice(props.value())}
        </span>
      }
    >
      <button
        type="button"
        class={className()}
        ref={element => {
          flashQuoteChange(element, quote)
        }}
        onClick={() => {
          props.onSelect?.()
        }}
      >
        {formatUsdPrice(props.value())}
      </button>
    </Show>
  )
}
