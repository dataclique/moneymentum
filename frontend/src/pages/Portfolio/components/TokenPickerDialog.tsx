import { useState, useMemo } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { useHyperliquidTickers } from "@/hooks/useTrading"
import type { TokenAllocation } from "../hooks/usePortfolioState"

interface TokenPickerDialogProps {
  selectedTokens: TokenAllocation[]
  onAddToken: (symbol: string) => void
}

export const TokenPickerDialog = ({
  selectedTokens,
  onAddToken,
}: TokenPickerDialogProps) => {
  const [searchTerm, setSearchTerm] = useState("")
  const {
    data: tickersData,
    isLoading: isTickersLoading,
    error: tickersError,
  } = useHyperliquidTickers()

  const filteredTickers = useMemo(() => {
    const tickers = tickersData ?? []
    if (!searchTerm.trim()) {
      return tickers
    }
    return tickers.filter(ticker =>
      ticker.toLowerCase().includes(searchTerm.toLowerCase()),
    )
  }, [tickersData, searchTerm])

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Add Position</Button>
      </DialogTrigger>
      <DialogContent className="flex h-[90vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Select Market</DialogTitle>
          <DialogDescription>
            Search and select a market to add to your portfolio.
          </DialogDescription>
        </DialogHeader>
        <input
          type="text"
          placeholder="Search markets"
          value={searchTerm}
          onChange={event => {
            setSearchTerm(event.target.value)
          }}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        {tickersError && (
          <p className="text-sm text-rose-400">{tickersError.message}</p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
          {isTickersLoading ? (
            <div className="p-4 text-sm text-muted-foreground">
              Loading markets...
            </div>
          ) : filteredTickers.length ? (
            filteredTickers.map(symbol => {
              const alreadySelected = selectedTokens.some(
                token => token.symbol === symbol,
              )
              return (
                <button
                  key={symbol}
                  type="button"
                  onClick={() => {
                    onAddToken(symbol)
                  }}
                  disabled={alreadySelected}
                  className={twMerge(
                    clsx(
                      "flex w-full items-center justify-between border-b border-border/60 px-4 py-2 text-left text-sm hover:bg-muted/40",
                      alreadySelected && "cursor-not-allowed opacity-50",
                    ),
                  )}
                >
                  {symbol}
                  {alreadySelected && (
                    <span className="text-xs text-muted-foreground">added</span>
                  )}
                </button>
              )
            })
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              Nothing found
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
