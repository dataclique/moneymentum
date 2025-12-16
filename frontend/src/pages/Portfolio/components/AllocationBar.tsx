import { useState } from "react"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import type { OrderSide } from "@/hooks/useTrading"
import type { TokenAllocation } from "../hooks/usePortfolioState"

const getSideColor = (side: OrderSide) =>
  side === "buy" ? "rgba(34, 197, 94, 0.8)" : "rgba(239, 68, 68, 0.8)"

interface AllocationBarTokenProps {
  token: TokenAllocation
  budget: number
  isHovered: boolean
}

const AllocationBarToken = ({
  token,
  budget,
  isHovered,
}: AllocationBarTokenProps) => {
  const isSmall = token.percentage < 4
  const usdAmount = (token.percentage / 100) * budget

  return (
    <div
      className="flex items-center justify-center overflow-hidden border-b border-background p-1 text-center text-white"
      style={{
        height: `${token.percentage}%`,
        backgroundColor: getSideColor(token.side),
      }}
    >
      <div
        className={twMerge(
          clsx("flex", isSmall ? "flex-row gap-1" : "flex-col"),
        )}
      >
        <span className="font-bold">{token.symbol.split("/")[0]}</span>
        <span>
          {isHovered
            ? `$${usdAmount.toFixed(2)}`
            : `${token.percentage.toFixed(1)}%`}
        </span>
      </div>
    </div>
  )
}

interface AllocationBarProps {
  tokens: TokenAllocation[]
  remainingPercent: number
  budget: number
}

export const AllocationBar = ({
  tokens,
  remainingPercent,
  budget,
}: AllocationBarProps) => {
  const [isHovered, setIsHovered] = useState(false)
  const longs = tokens.filter(t => t.side === "buy")
  const shorts = tokens.filter(t => t.side === "sell")

  return (
    <div
      className="fixed left-0 top-0 z-20 flex h-screen w-20 flex-col border-r border-border bg-background/50 text-xs backdrop-blur-sm"
      onMouseEnter={() => {
        setIsHovered(true)
      }}
      onMouseLeave={() => {
        setIsHovered(false)
      }}
    >
      {longs.map(token => (
        <AllocationBarToken
          key={token.symbol}
          token={token}
          budget={budget}
          isHovered={isHovered}
        />
      ))}

      {remainingPercent > 0.1 && (
        <div
          className="flex items-center justify-center text-center"
          style={{ height: `${remainingPercent.toFixed(2)}%` }}
        >
          <span className="text-muted-foreground">Free</span>
        </div>
      )}

      {shorts.map(token => (
        <AllocationBarToken
          key={token.symbol}
          token={token}
          budget={budget}
          isHovered={isHovered}
        />
      ))}
    </div>
  )
}
