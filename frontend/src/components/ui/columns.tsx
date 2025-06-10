"use client"
 
import type { ColumnDef } from "@tanstack/react-table"
 
// This type is used to define the shape of our data.
// You can use a Zod schema here if you want.
export type TradingData = {
  timestamp: string
  close: number
  volume: number
  ticker: string
  log_return: number | null
  cum_return: number | null
  autocorrelation: number | null
  stddev: number | null
  annualized_volatility: number | null
  sma: number | null
  mean_return: number | null
  price_stddev: number | null
  return_stddev: number | null
  price_zscore: number | null
  covariance: number | null
  beta: number | null
  information_discreteness: number | null
  sharpe: number | null
  log_return_above_mar: number | null
  downside_deviation: number | null
  sortino: number | null
}
 
export const columns: ColumnDef<TradingData>[] = [
  {
    accessorKey: "timestamp",
    header: "Timestamp",
  },
  {
    accessorKey: "ticker",
    header: "Ticker",
  },
  {
    accessorKey: "close",
    header: "Close Price",
  },
  {
    accessorKey: "volume",
    header: "Volume",
  },
  {
    accessorKey: "log_return",
    header: "Log Return",
  },
  {
    accessorKey: "cum_return",
    header: "Cumulative Return",
  },
  {
    accessorKey: "sharpe",
    header: "Sharpe Ratio",
  },
  {
    accessorKey: "sortino",
    header: "Sortino Ratio",
  },
  {
    accessorKey: "beta",
    header: "Beta",
  },
  {
    accessorKey: "annualized_volatility",
    header: "Annualized Volatility",
  }
]