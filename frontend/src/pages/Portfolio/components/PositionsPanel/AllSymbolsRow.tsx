import { Show } from "solid-js"
import type { JSX } from "solid-js"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"

import type { AllSymbolRowData } from "./allSymbolRowModel"
import {
  betaClassName,
  formatDecimal,
  formatPercent,
  fundingRateClassName,
  riskAdjustedReturnClassName,
  signedMetricClassName,
  volatilityClassName,
} from "./allSymbolRowModel"

export const AllSymbolsRow = (props: {
  row: AllSymbolRowData
  isInTarget: boolean
  isClosing: boolean
  fundingIsLoading: boolean
  factorsIsLoading: boolean
  onSymbolClick: (symbol: string) => void
}): JSX.Element => {
  const cellClass = "px-2 py-1 align-middle text-right font-mono text-[11px]"
  const fundingDisplay = () => formatPercent(props.row.fundingRateAnnualized)

  const handleActivate = () => {
    props.onSymbolClick(props.row.symbol)
  }

  const ariaLabel = () => {
    if (props.isClosing) {
      return `Undo remove ${props.row.baseSymbol}`
    }
    if (props.isInTarget) {
      return `Remove ${props.row.baseSymbol} from portfolio`
    }
    return `Add ${props.row.baseSymbol} to portfolio`
  }

  return (
    <tr
      tabIndex={0}
      role="button"
      aria-pressed={props.isInTarget || props.isClosing}
      aria-label={ariaLabel()}
      class={cn(
        "border-b border-border/20 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-0",
        props.isClosing && "opacity-50 bg-red-500/5",
        props.isInTarget && !props.isClosing && "bg-muted/50",
        !props.isInTarget && !props.isClosing && "hover:bg-muted/30",
      )}
      onKeyDown={event => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        handleActivate()
      }}
      onClick={handleActivate}
    >
      <td class="px-2 py-1 align-middle font-medium text-left">
        {props.row.baseSymbol}
      </td>
      <td
        class={cn(
          cellClass,
          "w-[80px]",
          fundingRateClassName(props.row.fundingRateAnnualized),
        )}
      >
        <Show
          when={!props.fundingIsLoading}
          fallback={<Skeleton class="inline-block h-3 w-[64px] align-middle" />}
        >
          {fundingDisplay()}
        </Show>
      </td>
      <td class={cn(cellClass, betaClassName(props.row.beta))}>
        <Show
          when={!props.factorsIsLoading}
          fallback={<Skeleton class="inline-block h-3 w-10 align-middle" />}
        >
          {formatDecimal(props.row.beta)}
        </Show>
      </td>
      <td class={cn(cellClass, volatilityClassName(props.row.volatility))}>
        <Show
          when={!props.factorsIsLoading}
          fallback={<Skeleton class="inline-block h-3 w-10 align-middle" />}
        >
          {formatPercent(props.row.volatility)}
        </Show>
      </td>
      <td class={cn(cellClass, riskAdjustedReturnClassName(props.row.sharpe))}>
        <Show
          when={!props.factorsIsLoading}
          fallback={<Skeleton class="inline-block h-3 w-10 align-middle" />}
        >
          {formatDecimal(props.row.sharpe)}
        </Show>
      </td>
      <td class={cn(cellClass, riskAdjustedReturnClassName(props.row.sortino))}>
        <Show
          when={!props.factorsIsLoading}
          fallback={<Skeleton class="inline-block h-3 w-10 align-middle" />}
        >
          {formatDecimal(props.row.sortino)}
        </Show>
      </td>
      <td class={cn(cellClass, signedMetricClassName(props.row.momentum))}>
        <Show
          when={!props.factorsIsLoading}
          fallback={<Skeleton class="inline-block h-3 w-10 align-middle" />}
        >
          {formatPercent(props.row.momentum)}
        </Show>
      </td>
      <td class={cn(cellClass, signedMetricClassName(props.row.carry))}>
        <Show
          when={!props.factorsIsLoading}
          fallback={<Skeleton class="inline-block h-3 w-10 align-middle" />}
        >
          {formatPercent(props.row.carry)}
        </Show>
      </td>
    </tr>
  )
}
