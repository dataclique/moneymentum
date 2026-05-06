import { createSignal, createMemo, For, Show } from "solid-js"
import { Search } from "lucide-solid"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"

interface ScreenerPanelProps {
  symbols: string[]
  isLoading: boolean
  selectedSymbols: Set<string>
  onAddSymbol: (symbol: string) => void
  fundingRatesByBaseSymbol?: Record<string, number>
}

export const ScreenerPanel = (props: ScreenerPanelProps) => {
  const [searchQuery, setSearchQuery] = createSignal("")

  const sortedSymbols = createMemo(() => {
    const query = searchQuery().trim()
    const filtered =
      query === ""
        ? props.symbols
        : props.symbols.filter(symbol =>
            symbol.toLowerCase().includes(query.toLowerCase()),
          )
    return [...filtered].sort((firstSymbol, secondSymbol) =>
      firstSymbol.localeCompare(secondSymbol),
    )
  })

  return (
    <div class="w-[180px] shrink-0 flex flex-col rounded border border-border max-h-[calc(100vh-2.5rem)] min-h-0">
      <div class="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between shrink-0">
        <span class="font-medium">SCREENER</span>
      </div>
      <div class="p-1.5 border-b border-border shrink-0">
        <div class="relative">
          <Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search..."
            aria-label="Search symbols"
            value={searchQuery()}
            onInput={event => {
              setSearchQuery(event.currentTarget.value)
            }}
            class="w-full pl-7 pr-2 py-1 bg-muted/50 border border-border rounded focus:outline-none focus:border-primary text-[11px]"
          />
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-auto scrollbar-hide">
        <Show
          when={!props.isLoading}
          fallback={
            <div class="p-2 space-y-1">
              <For each={Array.from({ length: 12 })}>
                {() => <Skeleton class="h-5 w-full" />}
              </For>
            </div>
          }
        >
          <table class="w-full">
            <thead class="sticky top-0 bg-muted/90 z-10">
              <tr class="text-muted-foreground text-[10px]">
                <th class="px-2 py-1 text-left font-medium">Perp</th>
                <th class="px-2 py-1 text-right font-medium w-[80px]">
                  Rate (ann.)
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={sortedSymbols()}>
                {symbol => {
                  const baseSymbol = symbol.includes("/")
                    ? (symbol.split("/")[0] ?? symbol)
                    : symbol
                  const isSelected = props.selectedSymbols.has(symbol)
                  const fundingRate =
                    props.fundingRatesByBaseSymbol?.[baseSymbol]
                  const annualizedFundingRate =
                    fundingRate === undefined ? null : fundingRate * 24 * 365
                  const fundingDisplay =
                    annualizedFundingRate === null
                      ? "--"
                      : `${(annualizedFundingRate * 100).toFixed(2)}%`

                  return (
                    <tr
                      class={cn(
                        "border-b border-border/20 cursor-pointer",
                        isSelected
                          ? "bg-muted/30 text-muted-foreground cursor-default"
                          : "hover:bg-muted/30",
                      )}
                      tabIndex={0}
                      aria-disabled={isSelected}
                      onClick={() => {
                        if (!isSelected) props.onAddSymbol(symbol)
                      }}
                      onKeyDown={(event: KeyboardEvent) => {
                        if (
                          !isSelected &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault()
                          props.onAddSymbol(symbol)
                        }
                      }}
                    >
                      <td class="px-2 py-1 font-medium">{baseSymbol}</td>
                      <td class="px-2 py-1 text-right font-mono text-[11px] text-muted-foreground w-[80px]">
                        {fundingDisplay}
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </div>
  )
}
