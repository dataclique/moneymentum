import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/cn"

interface LeverageDialogProps {
  symbol: string
  leverage: number
  maxLeverage?: number
  leverageLimitsIsLoading: boolean
  disabled: boolean
  onLeverageChange: (symbol: string, leverage: number) => void
}

export const LeverageDialog = (props: LeverageDialogProps): JSX.Element => {
  const [open, setOpen] = createSignal(false)
  const maxLeverage = () => props.maxLeverage ?? 1
  const isLeverageLoading = () =>
    props.leverageLimitsIsLoading || props.maxLeverage === undefined
  const leverageMarks = createMemo(() =>
    Array.from(
      { length: Math.max(1, Math.floor(maxLeverage())) },
      (_, markIndex) => markIndex + 1,
    ),
  )
  const markLeft = (leverage: number) => {
    const leverageRange = maxLeverage() - 1
    if (leverageRange <= 0) return "0%"
    return `${String(((leverage - 1) / leverageRange) * 100)}%`
  }

  // Intentional imperative keyboard listener:
  // when the dialog is open we attach a `window` `keydown` handler for `Escape`
  // (`handleEsc`) and remove it via `onCleanup`. This is not derived state and
  // alternatives like `createMemo` or `@tanstack/solid-query` were considered
  // but are not appropriate for event subscription lifecycle.
  createEffect(() => {
    if (open()) {
      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setOpen(false)
        }
      }
      window.addEventListener("keydown", handleEsc)
      onCleanup(() => {
        window.removeEventListener("keydown", handleEsc)
      })
    }
  })

  return (
    <div class="relative inline-flex flex-col items-start gap-1">
      <TooltipProvider>
        <Tooltip openDelay={0}>
          <TooltipTrigger
            as="span"
            class="inline-flex"
            title={
              isLeverageLoading()
                ? "Loading max leverages for tokens"
                : undefined
            }
          >
            <Button
              variant="ghost"
              size="sm"
              class={cn(
                "h-auto px-2 py-0.5 text-[10px] font-mono border border-border rounded pointer-events-auto",
                isLeverageLoading() && "opacity-60",
              )}
              disabled={props.disabled || isLeverageLoading()}
              onClick={() => {
                setOpen(prev => !prev)
              }}
            >
              {props.leverage}x
            </Button>
          </TooltipTrigger>
          <Show when={isLeverageLoading()}>
            <TooltipContent>Loading max leverages for tokens</TooltipContent>
          </Show>
        </Tooltip>
      </TooltipProvider>

      <Show when={open()}>
        <div class="fixed inset-0 z-[40] flex items-center justify-center">
          {/* backdrop */}
          <div
            class="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={event => {
              event.stopPropagation()
              setOpen(false)
            }}
          />
          {/* centered modal */}
          <div class="relative z-[50] w-[560px] max-w-[94vw] rounded-lg border border-border bg-background px-6 py-5 shadow-2xl">
            <div class="mb-6 flex items-start justify-between gap-4">
              <div>
                <div class="mb-1 text-base font-semibold">
                  Edit leverage of {props.symbol}
                </div>
              </div>
              <div class="text-right">
                <div class="text-xs uppercase tracking-wide text-muted-foreground">
                  Current
                </div>
                <div class="font-mono text-xl">{props.leverage}x</div>
              </div>
            </div>
            <div class="pb-7 pt-1">
              <Slider
                value={[props.leverage]}
                onChange={([leverage]) => {
                  props.onLeverageChange(props.symbol, leverage)
                }}
                minValue={1}
                maxValue={maxLeverage()}
                step={1}
                class="w-full"
              />
              <div class="relative mt-3 h-7">
                <For each={leverageMarks()}>
                  {leverageMark => (
                    <div
                      class="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-1.5"
                      style={{ left: markLeft(leverageMark) }}
                    >
                      <div class="h-3 w-px bg-muted-foreground/60" />
                      <Show
                        when={
                          leverageMark === 1 ||
                          leverageMark === props.leverage ||
                          leverageMark === Math.floor(maxLeverage())
                        }
                      >
                        <span class="font-mono text-xs leading-none text-muted-foreground">
                          {leverageMark}x
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
