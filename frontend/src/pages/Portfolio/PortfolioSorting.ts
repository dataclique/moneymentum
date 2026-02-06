import type { SortState } from "./components/SortableHeaderButton"
import type { TokenAllocation } from "./hooks/usePortfolioState"

export const sortTokens = (tokens: TokenAllocation[], sortState: SortState) => {
  if (!sortState) {
    return tokens
  }

  const directionMultiplier = sortState.direction === "asc" ? 1 : -1

  const getComparable = (token: TokenAllocation) => {
    switch (sortState.column) {
      case "market": {
        const [base] = token.symbol.split("/")
        return base.toUpperCase()
      }
      case "weight":
        return token.percentage
      case "notional":
        return token.notional ?? token.targetNotional ?? 0
      case "side":
        return token.side === "buy" ? 1 : 0
      default:
        return 0
    }
  }

  return [...tokens].sort((a, b) => {
    const aValue = getComparable(a)
    const bValue = getComparable(b)

    if (aValue < bValue) return -1 * directionMultiplier
    if (aValue > bValue) return 1 * directionMultiplier

    const [aBase] = a.symbol.split("/")
    const [bBase] = b.symbol.split("/")
    return aBase.localeCompare(bBase) * directionMultiplier
  })
}
