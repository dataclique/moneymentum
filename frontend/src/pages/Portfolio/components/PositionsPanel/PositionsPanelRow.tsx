import {
  createSignal,
  createEffect,
  Show,
  createMemo,
  onCleanup,
} from "solid-js"
import type { JSX } from "solid-js"
import Decimal from "decimal.js"
import { Trash2, Undo2, CircleAlert, X } from "lucide-solid"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import type { OrderSide } from "@/hooks/useTrading"
import { MIN_USD, type PortfolioInterface } from "../../hooks/usePortfolioState"
import {
  LeverageEditorTrigger,
  LeverageSliderEditor,
} from "./LeverageInlineEditor"

const LEVERAGE_EDITOR_COLUMN_COUNT = 7
const LEVERAGE_KEYBOARD_ENTRY_TIMEOUT_MS = 1_000

const getSideBadgeClass = (side: OrderSide) =>
  side === "buy"
    ? "bg-green-500/20 text-green-500"
    : "bg-red-500/20 text-red-500"

export const PositionsPanelRow = (props: {
  symbol: string
  position: () => PortfolioInterface
  status: "new" | "unchanged" | "changed" | "closing"
  maxLeverage?: number
  leverageLimitsIsLoading: boolean
  isPrecise: boolean
  fundingIsLoading: boolean
  onRemove: (symbol: string) => void
  onUndoRemove: (symbol: string) => void
  onSideChange: (symbol: string, side: OrderSide) => void
  onLeverageChange: (symbol: string, leverage: number) => void
  onNotionalChange: (symbol: string, notional: number) => void
  onWeightChange: (symbol: string, percentage: number) => void
  fundingRatesByBaseSymbol?: Record<string, number>
  totalNotional: number
  symbolsBelowMinimum: string[]
  symbolsDeltaBelowMinimum: string[]
  symbolDelta: number
}): JSX.Element => {
  const notional = () => props.position().notional
  const weight = createMemo(() => {
    if (props.totalNotional === 0) return "0.00"
    return new Decimal(notional()).div(props.totalNotional).mul(100).toFixed(2)
  })

  const [weightInput, setWeightInput] = createSignal("")
  const [isWeightFocused, setIsWeightFocused] = createSignal(false)

  // createEffect: sync external weight into local input when not focused
  createEffect(() => {
    if (!isWeightFocused()) {
      setWeightInput(weight())
    }
  })

  const [notionalInput, setNotionalInput] = createSignal(notional().toFixed(2))
  const [isNotionalFocused, setIsNotionalFocused] = createSignal(false)

  // createEffect: sync external notional into local input when not focused
  createEffect(() => {
    if (!isNotionalFocused()) {
      setNotionalInput(notional().toFixed(2))
    }
  })

  const isClosing = () => props.status === "closing"

  const isNew = () => props.status === "new"

  const baseSymbol = () =>
    props.position().symbol.split("/")[0] ?? props.position().symbol
  const fundingRate = () => props.fundingRatesByBaseSymbol?.[baseSymbol()]

  // const targetValue = () =>
  //   props.token.targetNotional ??
  //   notional() ??
  //   parseFloat(notional())
  // const showDeltaWarning = () =>
  //   !props.isPrecise &&
  //   props.token.deltaInsufficient === true

  // fundingRate we got from hyperliquid API is 1 hour rate
  // to get annualized rate, we multiply by 24 (hours) and 365 (days)
  const annualizedFundingRate = () => {
    const rate = fundingRate()
    return rate === undefined ? null : rate * 24 * 365
  }
  const positionAdjustedFundingRate = () => {
    const rate = annualizedFundingRate()
    if (rate === null) return null
    return props.position().side === "buy" ? -rate : rate
  }
  const fundingDisplay = () => {
    const rate = positionAdjustedFundingRate()
    return rate === null ? "--" : `${(rate * 100).toFixed(2)}%`
  }
  const fundingClassName = () => {
    const rate = positionAdjustedFundingRate()
    if (rate === null || rate === 0) return "text-muted-foreground"
    return rate > 0 ? "text-emerald-500" : "text-rose-500"
  }

  const isBelowMinimum = () => props.symbolsBelowMinimum.includes(props.symbol)
  const isDeltaBelowMinimum = () =>
    props.symbolsDeltaBelowMinimum.includes(props.symbol)
  const showWarning = () =>
    isBelowMinimum() || (!props.isPrecise && isDeltaBelowMinimum())

  const [isLeverageEditorMounted, setIsLeverageEditorMounted] =
    createSignal(false)
  const [isLeverageEditorExpanded, setIsLeverageEditorExpanded] =
    createSignal(false)
  let leverageEditorAnimationFrame: number | undefined
  let leverageSliderEditorElement: HTMLTableCellElement | undefined
  let leverageKeyboardEntry = ""
  let leverageKeyboardEntryTimeout: ReturnType<typeof setTimeout> | undefined

  const clearLeverageEditorTimers = () => {
    if (leverageEditorAnimationFrame !== undefined) {
      cancelAnimationFrame(leverageEditorAnimationFrame)
      leverageEditorAnimationFrame = undefined
    }

    if (leverageKeyboardEntryTimeout !== undefined) {
      clearTimeout(leverageKeyboardEntryTimeout)
      leverageKeyboardEntryTimeout = undefined
    }
  }

  const resetLeverageKeyboardEntry = () => {
    leverageKeyboardEntry = ""
  }

  const openLeverageEditor = () => {
    clearLeverageEditorTimers()
    resetLeverageKeyboardEntry()
    setIsLeverageEditorMounted(true)
    leverageEditorAnimationFrame = requestAnimationFrame(() => {
      setIsLeverageEditorExpanded(true)
      leverageEditorAnimationFrame = undefined
    })
  }

  const closeLeverageEditor = () => {
    clearLeverageEditorTimers()
    resetLeverageKeyboardEntry()
    setIsLeverageEditorExpanded(false)
    setIsLeverageEditorMounted(false)
  }

  const applyLeverageKeyboardEntry = (digit: string) => {
    const maxLeverage = Math.floor(props.maxLeverage ?? 1)
    const candidateEntry = `${leverageKeyboardEntry}${digit}`
    const candidateLeverage = Number.parseInt(candidateEntry, 10)
    const fallbackLeverage = Number.parseInt(digit, 10)
    const candidateIsValid =
      Number.isFinite(candidateLeverage) &&
      candidateLeverage >= 1 &&
      candidateLeverage <= maxLeverage
    const fallbackIsValid =
      Number.isFinite(fallbackLeverage) &&
      fallbackLeverage >= 1 &&
      fallbackLeverage <= maxLeverage
    const nextLeverage = candidateIsValid
      ? candidateLeverage
      : leverageKeyboardEntry === "" && fallbackIsValid
        ? fallbackLeverage
        : null

    if (nextLeverage === null) return

    leverageKeyboardEntry = String(nextLeverage)
    props.onLeverageChange(props.position().symbol, nextLeverage)

    if (leverageKeyboardEntryTimeout !== undefined) {
      clearTimeout(leverageKeyboardEntryTimeout)
    }

    leverageKeyboardEntryTimeout = setTimeout(() => {
      resetLeverageKeyboardEntry()
      leverageKeyboardEntryTimeout = undefined
    }, LEVERAGE_KEYBOARD_ENTRY_TIMEOUT_MS)
  }

  onCleanup(() => {
    clearLeverageEditorTimers()
  })

  createEffect(() => {
    if (!isLeverageEditorMounted()) return

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (leverageSliderEditorElement?.contains(target)) return

      closeLeverageEditor()
    }

    document.addEventListener("pointerdown", closeOnOutsidePointerDown)
    onCleanup(() => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown)
    })
  })

  createEffect(() => {
    if (!isLeverageEditorMounted()) return

    const applyKeyboardLeverageOnDigit = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }

      if (!/^\d$/.test(event.key)) return

      event.preventDefault()
      applyLeverageKeyboardEntry(event.key)
    }

    document.addEventListener("keydown", applyKeyboardLeverageOnDigit)
    onCleanup(() => {
      document.removeEventListener("keydown", applyKeyboardLeverageOnDigit)
    })
  })

  return (
    <tr
      class={cn(
        "border-b border-border/30 position-row h-7 transition-[height,opacity] duration-200 ease-out",
        isLeverageEditorExpanded() && "h-14",
        isClosing() && "opacity-50 bg-red-500/5",
        isNew() && "bg-green-500/5",
      )}
    >
      <td
        class={cn(
          "px-2 py-1 align-middle font-medium pointer-events-auto transition-[padding] duration-200 ease-out",
          isLeverageEditorExpanded() && "py-2",
        )}
      >
        <div
          class={cn(
            "flex gap-[8px]",
            isLeverageEditorExpanded()
              ? "flex-col items-start"
              : "flex-row items-center",
          )}
        >
          <Show when={isLeverageEditorExpanded()}>
            <div class="text-[11px] leading-none text-muted-foreground">
              Edit leverage
            </div>
          </Show>
          <div class="flex flex-row items-center gap-[4px]">
            <span class="shrink-0 font-medium">{baseSymbol()}</span>
            <LeverageEditorTrigger
              isOpen={isLeverageEditorMounted()}
              onOpen={openLeverageEditor}
              onClose={closeLeverageEditor}
              symbol={props.position().symbol}
              leverage={props.position().leverage}
              maxLeverage={props.maxLeverage}
              leverageLimitsIsLoading={props.leverageLimitsIsLoading}
              disabled={isClosing()}
            />
          </div>
        </div>
      </td>
      <Show
        when={isLeverageEditorMounted()}
        fallback={
          <>
            <td class="px-2 py-1 align-middle pointer-events-auto">
              <select
                value={props.position().side}
                onChange={event => {
                  props.onSideChange(
                    props.position().symbol,
                    event.currentTarget.value as OrderSide,
                  )
                }}
                disabled={isClosing()}
                class={cn(
                  "text-[10px] font-medium px-1.5 py-0.5 rounded border-0 bg-transparent",
                  !isClosing() && "cursor-pointer",
                  getSideBadgeClass(props.position().side),
                  isClosing() && "grayscale opacity-50",
                )}
              >
                <option value="buy">LONG</option>
                <option value="sell">SHORT</option>
              </select>
            </td>
            <td class="px-2 py-1 align-middle text-right pointer-events-auto">
              <Show
                when={!isClosing()}
                fallback={<span class="text-rose-500 text-[10px]">→ 0%</span>}
              >
                <input
                  type="number"
                  value={weightInput()}
                  onFocus={() => setIsWeightFocused(true)}
                  onBlur={() => {
                    setIsWeightFocused(false)
                    setWeightInput(weight())
                  }}
                  onInput={inputEvent => {
                    const raw = inputEvent.currentTarget.value
                    setWeightInput(raw)
                    const parsed = raw === "" ? 0 : Number.parseFloat(raw)
                    const isValid =
                      Number.isFinite(parsed) && parsed >= 0 && parsed <= 100

                    if (!isValid) return

                    props.onWeightChange(props.position().symbol, parsed)
                  }}
                  step={0.5}
                  min={0}
                  max={100}
                  class="w-12 text-right font-mono text-[11px] rounded border border-border bg-transparent px-1 py-0.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span class="text-muted-foreground text-[10px] ml-0.5">%</span>
              </Show>
            </td>
            <td class="px-2 py-1 align-middle text-right pointer-events-auto">
              <span class="text-muted-foreground text-[10px]">$</span>
              <input
                type="number"
                value={notionalInput()}
                onFocus={() => setIsNotionalFocused(true)}
                onBlur={() => {
                  setIsNotionalFocused(false)
                  setNotionalInput(notional().toFixed(2))
                }}
                onInput={inputEvent => {
                  const raw = inputEvent.currentTarget.value
                  setNotionalInput(raw)
                  const parsed = raw === "" ? 0 : Number.parseFloat(raw)
                  const isValid = Number.isFinite(parsed) && parsed >= 0

                  if (!isValid) return

                  props.onNotionalChange(props.position().symbol, parsed)
                }}
                disabled={isClosing()}
                step={1}
                min={0}
                class="w-16 text-right font-mono text-[11px] rounded border border-border bg-transparent px-1 py-0.5 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    class={cn(
                      "inline-block ml-0.5 align-middle",
                      !showWarning() && "pointer-events-none opacity-0",
                    )}
                  >
                    <CircleAlert class="h-3 w-3 text-amber-500" />
                  </TooltipTrigger>
                  <TooltipContent class="text-xs">
                    <Show when={!props.isPrecise && isDeltaBelowMinimum()}>
                      <p>
                        Delta ${props.symbolDelta.toFixed(2)} is below $
                        {MIN_USD} minimum.
                      </p>
                    </Show>
                    <Show when={isBelowMinimum()}>
                      <p>
                        Position ${notional().toFixed(2)} below ${MIN_USD}{" "}
                        minimum.
                      </p>
                    </Show>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </td>
            <td
              class={cn(
                "px-2 py-1 align-middle text-right font-mono text-[11px] w-[11ch]",
                fundingClassName(),
              )}
            >
              <Show
                when={!props.fundingIsLoading}
                fallback={
                  <Skeleton class="h-3 w-[64px] inline-block align-middle" />
                }
              >
                {fundingDisplay()}
              </Show>
            </td>
            <td class="px-2 py-1 align-middle text-right font-mono text-[11px] text-muted-foreground">
              0
            </td>
            <td class="px-2 py-1 align-middle text-right font-mono text-[11px] text-muted-foreground">
              0
            </td>
            <td class="px-2 py-1 align-middle text-right font-mono text-[11px] text-muted-foreground">
              0
            </td>
            <td class="px-2 py-1 align-middle text-right">
              <Button
                variant="ghost"
                size="icon"
                class="h-6 w-6"
                aria-label={
                  isClosing()
                    ? `Undo remove ${props.position().symbol}`
                    : `Remove ${props.position().symbol}`
                }
                onClick={() => {
                  if (isClosing()) {
                    props.onUndoRemove(props.position().symbol)
                  } else {
                    props.onRemove(props.position().symbol)
                  }
                }}
              >
                <Show when={isClosing()} fallback={<Trash2 class="h-3 w-3" />}>
                  <Undo2 class="h-3 w-3" />
                </Show>
              </Button>
            </td>
          </>
        }
      >
        <td
          ref={element => {
            leverageSliderEditorElement = element
          }}
          colSpan={LEVERAGE_EDITOR_COLUMN_COUNT}
          class={cn(
            "px-2 align-middle pointer-events-auto transition-[padding,opacity] duration-200 ease-out",
            isLeverageEditorExpanded() ? "py-2 opacity-100" : "py-0 opacity-0",
          )}
        >
          <Show when={isLeverageEditorExpanded()}>
            <LeverageSliderEditor
              symbol={props.position().symbol}
              leverage={props.position().leverage}
              maxLeverage={props.maxLeverage}
              onLeverageChange={props.onLeverageChange}
            />
          </Show>
        </td>
        <td
          class={cn(
            "px-2 align-middle text-right transition-[padding] duration-200 ease-out",
            isLeverageEditorExpanded() ? "py-2" : "py-0",
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6"
            aria-label={`Close leverage editor for ${props.position().symbol}`}
            onClick={() => {
              closeLeverageEditor()
            }}
          >
            <X class="h-3 w-3" />
          </Button>
        </td>
      </Show>
    </tr>
  )
}
