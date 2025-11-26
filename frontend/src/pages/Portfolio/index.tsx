import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  useHyperliquidBalance,
  useHyperliquidTickers,
  useOpenHyperliquidPositions,
  type OrderSide,
  type OrderStatus,
} from "@/hooks/useApi"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type AllocationStatus = OrderStatus["status"] | "idle"

interface TokenAllocation {
  symbol: string
  percentage: number
  side: OrderSide
  status: AllocationStatus
  message?: string | null
}

const STORAGE_KEY = "portfolio-allocation-state"
const MIN_USD = 11

const getSymbolColor = (symbol: string) => {
  let hash = 0
  for (let index = 0; index < symbol.length; index += 1) {
    hash = symbol.charCodeAt(index) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 65% 55%)`
}

function PortfolioPage() {
  const [searchTerm, setSearchTerm] = useState("")
  const [budget, setBudget] = useState(0)
  const [isBudgetInitialized, setIsBudgetInitialized] = useState(false)
  const [selectedTokens, setSelectedTokens] = useState<TokenAllocation[]>([])

  const {
    data: tickersData,
    isLoading: isTickersLoading,
    error: tickersError,
  } = useHyperliquidTickers()
  const {
    data: balanceData,
    isLoading: isBalanceLoading,
    error: balanceError,
  } = useHyperliquidBalance()
  const openPositionsMutation = useOpenHyperliquidPositions()

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (typeof parsed?.budget === "number") {
          setBudget(parsed.budget)
          setIsBudgetInitialized(true)
        }
        if (Array.isArray(parsed?.tokens)) {
          setSelectedTokens(
            parsed.tokens.map((token: TokenAllocation) => ({
              ...token,
              status: "idle",
              message: null,
            })),
          )
        }
      } catch (error) {
        console.error("Failed to parse saved allocations", error)
      }
    }
  }, [])

  useEffect(() => {
    if (isBudgetInitialized) {
      return
    }
    if (typeof balanceData?.perp_usdc_balance === "number") {
      setBudget(balanceData.perp_usdc_balance)
      setIsBudgetInitialized(true)
    }
  }, [balanceData, isBudgetInitialized])

  useEffect(() => {
    const payload = {
      budget,
      tokens: selectedTokens.map(({ symbol, percentage, side }) => ({
        symbol,
        percentage,
        side,
      })),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }, [budget, selectedTokens])

  const tickers = tickersData?.data ?? []
  const filteredTickers = useMemo(() => {
    if (!searchTerm.trim()) {
      return tickers.slice(0, 50)
    }
    return tickers.filter(ticker =>
      ticker.toLowerCase().includes(searchTerm.toLowerCase()),
    )
  }, [tickers, searchTerm])

  const totalPercent = selectedTokens.reduce(
    (acc, token) => acc + token.percentage,
    0,
  )
  const remainingPercent = Math.max(0, 100 - totalPercent)
  const minPercentOfBudget =
    budget > 0 ? Math.min(100, (MIN_USD / budget) * 100) : 0
  const minPercentFloor = budget >= MIN_USD ? minPercentOfBudget : 0
  const requiredBudgetForTokens = selectedTokens.length * MIN_USD
  const budgetIsPositive = budget > 0
  const budgetBelowMinimum =
    selectedTokens.length > 0 && budgetIsPositive && budget < MIN_USD
  const insufficientBudgetForTokens =
    selectedTokens.length > 0 &&
    budgetIsPositive &&
    requiredBudgetForTokens > budget
  const hasBlockingBudgetIssue =
    budgetBelowMinimum || insufficientBudgetForTokens
  const blockingReasons: string[] = []
  if (budgetBelowMinimum) {
    blockingReasons.push(
      "Minimum portfolio budget is $11. Increase the amount to allocate capital.",
    )
  }
  if (insufficientBudgetForTokens) {
    blockingReasons.push(
      `You need at least $${requiredBudgetForTokens} for ${selectedTokens.length} token(s). Increase the budget or remove some positions.`,
    )
  }

  useEffect(() => {
    setSelectedTokens(prevTokens => {
      if (!prevTokens.length || budget <= 0) {
        return prevTokens
      }
      const minPercent = minPercentFloor
      if (minPercent === 0) {
        return prevTokens
      }

      let changed = false
      const adjustedTokens = prevTokens.map(token => {
        if (token.percentage >= minPercent) {
          return token
        }
        changed = true
        return {
          ...token,
          percentage: parseFloat(Math.min(100, minPercent).toFixed(2)),
          status: "idle",
          message: null,
        } as TokenAllocation
      })

      return changed ? adjustedTokens : prevTokens
    })
  }, [budget, minPercentFloor])

  const handleAddToken = (symbol: string) => {
    if (selectedTokens.some(token => token.symbol === symbol)) {
      return
    }
    if (remainingPercent <= 0) {
      return
    }
    const initialPercent = Math.min(
      remainingPercent || minPercentFloor || 100,
      Math.max(minPercentFloor, 5),
    )
    setSelectedTokens(prev => [
      ...prev,
      {
        symbol,
        percentage: parseFloat(initialPercent.toFixed(2)),
        side: "buy",
        status: "idle",
        message: null,
      },
    ])
  }

  const handleRemoveToken = (symbol: string) => {
    setSelectedTokens(prev => prev.filter(token => token.symbol !== symbol))
  }

  const enforceLimits = (symbol: string, targetPercent: number) => {
    setSelectedTokens(prev =>
      prev.map(token => {
        if (token.symbol !== symbol) {
          return token
        }
        const totalWithoutCurrent = prev.reduce((sum, item) => {
          if (item.symbol === symbol) return sum
          return sum + item.percentage
        }, 0)
        const maxForToken = Math.max(
          0,
          Math.min(100, 100 - totalWithoutCurrent),
        )
        let nextValue = Math.min(targetPercent, maxForToken)

        nextValue = Math.max(nextValue, minPercentFloor)

        return {
          ...token,
          percentage: parseFloat(Math.min(nextValue, 100).toFixed(2)),
          status: "idle",
          message: null,
        }
      }),
    )
  }

  const handleSideChange = (symbol: string, side: OrderSide) => {
    setSelectedTokens(prev =>
      prev.map(token => (token.symbol === symbol ? { ...token, side } : token)),
    )
  }

  const handleBudgetChange = (value: number) => {
    setIsBudgetInitialized(true)
    setBudget(Math.max(0, value))
  }

  const handleOpenPositions = () => {
    if (
      !selectedTokens.length ||
      budget <= 0 ||
      hasBlockingBudgetIssue ||
      totalPercent <= 0
    ) {
      return
    }

    setSelectedTokens(prev =>
      prev.map(token => ({ ...token, status: "working", message: null })),
    )

    openPositionsMutation.mutate(
      {
        budget,
        positions: selectedTokens.map(token => ({
          symbol: token.symbol,
          side: token.side,
          percentage: token.percentage / 100,
        })),
      },
      {
        onSuccess: data => {
          setSelectedTokens(prev =>
            prev.map(token => {
              const status = data.orders.find(
                order => order.symbol === token.symbol,
              )
              if (!status) return token
              return {
                ...token,
                status: status.status,
                message: status.message ?? null,
              }
            }),
          )
        },
        onError: error => {
          setSelectedTokens(prev =>
            prev.map(token => ({
              ...token,
              status: "failed",
              message: error.message,
            })),
          )
        },
      },
    )
  }

  const renderStatusBadge = (status: AllocationStatus) => {
    const colorMap: Record<AllocationStatus, string> = {
      idle: "bg-muted text-muted-foreground border border-border",
      working: "bg-amber-500/20 text-amber-400 border border-amber-500/40",
      filled: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40",
      failed: "bg-rose-500/20 text-rose-400 border border-rose-500/40",
    }
    const labelMap: Record<AllocationStatus, string> = {
      idle: "idle",
      working: "processing",
      filled: "filled",
      failed: "failed",
    }
    return (
      <span
        className={cn(
          "rounded-full px-3 py-1 text-xs font-medium capitalize",
          colorMap[status],
        )}
      >
        {labelMap[status]}
      </span>
    )
  }

  const allocationCard = (token: TokenAllocation) => {
    const otherPercent = totalPercent - token.percentage
    const maxForToken = Math.max(0, Math.min(100, 100 - otherPercent))
    const sliderMax = Math.max(
      token.percentage,
      Math.min(100, maxForToken || token.percentage),
    )
    const usdAmount = ((token.percentage / 100) * budget).toFixed(2)
    const availableExtra = Math.max(0, sliderMax - token.percentage)
    const displayGradientStop = Math.min(100, token.percentage + availableExtra)
    const gradient = `linear-gradient(90deg, rgba(59,130,246,0.9) 0% ${token.percentage}%, rgba(250,204,21,0.6) ${token.percentage}% ${displayGradientStop}%, rgba(107,114,128,0.3) ${displayGradientStop}% 100%)`

    return (
      <Card key={token.symbol}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg font-semibold">
            {token.symbol}
          </CardTitle>
          {renderStatusBadge(token.status)}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>
              {token.percentage.toFixed(2)}% (~${usdAmount})
            </span>
            <select
              value={token.side}
              onChange={event =>
                handleSideChange(token.symbol, event.target.value as OrderSide)
              }
              className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            >
              <option value="buy">Long</option>
              <option value="sell">Short</option>
            </select>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleRemoveToken(token.symbol)}
            >
              Remove
            </Button>
          </div>
          <div className="space-y-2">
            <div className="relative w-full">
              <div className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2 px-2">
                <div
                  className="h-2 rounded-full"
                  style={{ background: gradient }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={sliderMax || 100}
                step={0.5}
                value={token.percentage}
                className="portfolio-slider relative z-10"
                onChange={event =>
                  enforceLimits(token.symbol, Number(event.target.value))
                }
              />
            </div>
            <div className="text-xs text-muted-foreground">
              Additional allocation available for this token:{" "}
              {availableExtra.toFixed(2)}%
            </div>
          </div>
          {token.message && (
            <div className="text-sm text-muted-foreground">{token.message}</div>
          )}
        </CardContent>
      </Card>
    )
  }

  const disableSubmit =
    !selectedTokens.length ||
    budget <= 0 ||
    openPositionsMutation.isPending ||
    totalPercent <= 0 ||
    hasBlockingBudgetIssue

  return (
    <div className="container mx-auto flex max-w-5xl flex-col gap-6 py-8">
      <div>
        <h1 className="text-3xl font-bold">Portfolio builder</h1>
        <p className="text-muted-foreground">
          Select perp tokens, distribute percentages, and submit orders to
          Hyperliquid.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_3fr]">
        <Card>
          <CardHeader>
            <CardTitle>Token list</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              type="text"
              placeholder="Search by ticker"
              value={searchTerm}
              onChange={event => setSearchTerm(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            {tickersError && (
              <p className="text-sm text-rose-400">{tickersError.message}</p>
            )}
            <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
              {isTickersLoading ? (
                <div className="p-4 text-sm text-muted-foreground">
                  Loading tickers...
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
                      onClick={() => handleAddToken(symbol)}
                      disabled={alreadySelected}
                      className={cn(
                        "flex w-full items-center justify-between border-b border-border/60 px-4 py-2 text-left text-sm hover:bg-muted/40",
                        alreadySelected && "cursor-not-allowed opacity-50",
                      )}
                    >
                      {symbol}
                      {alreadySelected && (
                        <span className="text-xs text-muted-foreground">
                          added
                        </span>
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
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Total budget</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {balanceError && (
                <p className="text-sm text-rose-400">{balanceError.message}</p>
              )}
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span>
                  Perp account balance:{" "}
                  {isBalanceLoading
                    ? "loading..."
                    : `${
                        typeof balanceData?.perp_usdc_balance === "number"
                          ? balanceData.perp_usdc_balance.toFixed(2)
                          : "0.00"
                      } USDC`}
                </span>
                {typeof balanceData?.perp_usdc_balance === "number" &&
                  budget > balanceData.perp_usdc_balance && (
                    <span className="text-rose-400">
                      Exceeds available balance
                    </span>
                  )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={MIN_USD}
                  step={10}
                  value={Number.isNaN(budget) ? "" : budget}
                  onChange={event =>
                    handleBudgetChange(
                      Number.isNaN(Number(event.target.value))
                        ? 0
                        : Number(event.target.value),
                    )
                  }
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <span className="text-sm text-muted-foreground">USDC</span>
              </div>
              <div className="text-sm text-muted-foreground">
                Allocated: {totalPercent.toFixed(2)}% — free:{" "}
                {remainingPercent.toFixed(2)}%
              </div>
            </CardContent>
          </Card>

          {selectedTokens.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Add tokens from the list on the left to configure allocations.
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Allocation block</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                    <span>Total allocated</span>
                    <span>
                      {totalPercent.toFixed(2)}% · $
                      {((totalPercent / 100) * budget).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex h-12 overflow-hidden rounded-lg border border-border text-xs font-medium text-background">
                    {selectedTokens.map(token => (
                      <div
                        key={token.symbol}
                        className="flex items-center justify-center px-2 text-center"
                        style={{
                          flexGrow: Math.max(token.percentage, 0.1),
                          flexBasis: 0,
                          backgroundColor: getSymbolColor(token.symbol),
                        }}
                      >
                        {token.symbol} · {token.percentage.toFixed(1)}%
                      </div>
                    ))}
                    {remainingPercent > 0 && (
                      <div
                        className="flex items-center justify-center bg-muted px-2 text-center text-foreground"
                        style={{
                          flexGrow: remainingPercent,
                          flexBasis: 0,
                        }}
                      >
                        Free {remainingPercent.toFixed(1)}%
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    {selectedTokens.map(token => (
                      <div
                        key={`${token.symbol}-summary`}
                        className="flex items-center justify-between"
                      >
                        <span className="font-medium text-foreground">
                          {token.symbol}
                        </span>
                        <span>
                          {token.percentage.toFixed(2)}% · $
                          {((token.percentage / 100) * budget).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
              <div className="space-y-4">
                {selectedTokens.map(allocationCard)}
              </div>
            </>
          )}
          {blockingReasons.length > 0 && (
            <Card>
              <CardContent className="space-y-2 text-sm text-rose-400">
                {blockingReasons.map(reason => (
                  <p key={reason}>{reason}</p>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 bg-background/80 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
          <div className="text-sm text-muted-foreground">
            Each token must receive at least ${MIN_USD}. Remove extra positions
            if you run out of budget.
          </div>
          <Button onClick={handleOpenPositions} disabled={disableSubmit}>
            {openPositionsMutation.isPending ? "Sending..." : "Open positions"}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default PortfolioPage
