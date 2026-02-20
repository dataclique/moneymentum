import { useState, useMemo } from "react"
import { Search } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

interface ScreenerPanelProps {
  symbols: string[]
  isLoading: boolean
  selectedSymbols: Set<string>
  onAddSymbol: (symbol: string) => void
}

export const ScreenerPanel = ({
  symbols,
  isLoading,
  selectedSymbols,
  onAddSymbol,
}: ScreenerPanelProps) => {
  const [searchQuery, setSearchQuery] = useState("")

  const sortedSymbols = useMemo(() => {
    const filtered =
      searchQuery.trim() === ""
        ? symbols
        : symbols.filter(s =>
            s.toLowerCase().includes(searchQuery.toLowerCase()),
          )
    return [...filtered].sort((a, b) => a.localeCompare(b))
  }, [symbols, searchQuery])

  return (
    <div className="w-[180px] shrink-0 flex flex-col rounded border border-border max-h-[calc(100vh-2.5rem)] min-h-0">
      <div className="px-2 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between shrink-0">
        <span className="font-medium">SCREENER</span>
      </div>
      <div className="p-1.5 border-b border-border shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-7 pr-2 py-1 bg-muted/50 border border-border rounded focus:outline-none focus:border-primary text-[11px]"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto scrollbar-hide">
        {isLoading ? (
          <div className="p-2 space-y-1">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-muted/90 z-10">
              <tr className="text-muted-foreground text-[10px]">
                <th className="px-2 py-1 text-left font-medium">Symbol</th>
              </tr>
            </thead>
            <tbody>
              {sortedSymbols.map(symbol => {
                const isSelected = selectedSymbols.has(symbol)
                return (
                  <tr
                    key={symbol}
                    className={twMerge(
                      clsx(
                        "border-b border-border/20 cursor-pointer",
                        isSelected
                          ? "bg-muted/30 text-muted-foreground cursor-default"
                          : "hover:bg-muted/30",
                      ),
                    )}
                    onClick={() => {
                      if (!isSelected) onAddSymbol(symbol)
                    }}
                  >
                    <td className="px-2 py-1 font-medium">{symbol}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
