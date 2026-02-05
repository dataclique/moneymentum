import { describe, it, expect } from "vitest"
import type { SortState } from "./components/SortableHeaderButton"
import { sortTokens } from "./index"
import type { TokenAllocation } from "./hooks/usePortfolioState"

const createToken = (overrides: Partial<TokenAllocation>): TokenAllocation => {
  return {
    symbol: "BTC/USDC:USDC",
    percentage: 0,
    side: "buy",
    leverage: 1,
    status: "idle",
    message: null,
    notional: 0,
    lockedUsd: 0,
    previousPercentage: 0,
    previousNotional: 0,
    targetNotional: 0,
    currentNotional: 0,
    deltaInsufficient: false,
    ...overrides,
  }
}

const applySort = (tokens: TokenAllocation[], sortState: SortState) =>
  sortTokens(tokens, sortState!).map(token => token.symbol)

const buildWeightSnapshot = (tokens: TokenAllocation[]) =>
  tokens
    .map(token => `${token.symbol}:${token.percentage}`)
    .join("|")

const buildNotionalSnapshot = (tokens: TokenAllocation[]) =>
  tokens
    .map(
      token => `${token.symbol}:${token.notional ?? token.targetNotional ?? 0}`,
    )
    .join("|")

const buildSideSnapshot = (tokens: TokenAllocation[]) =>
  tokens.map(token => `${token.symbol}:${token.side}`).join("|")

describe("Portfolio table sorting", () => {
  it("sorts by market A->Z and Z->A", () => {
    const tokens = [
      createToken({ symbol: "ETH/USDC:USDC" }),
      createToken({ symbol: "BTC/USDC:USDC" }),
      createToken({ symbol: "SOL/USDC:USDC" }),
    ]

    const asc: SortState = { column: "market", direction: "asc" }
    const desc: SortState = { column: "market", direction: "desc" }

    expect(applySort(tokens, asc)).toEqual([
      "BTC/USDC:USDC",
      "ETH/USDC:USDC",
      "SOL/USDC:USDC",
    ])
    expect(applySort(tokens, desc)).toEqual([
      "SOL/USDC:USDC",
      "ETH/USDC:USDC",
      "BTC/USDC:USDC",
    ])
  })

  it("sorts by weight from smaller to larger and back", () => {
    const tokens = [
      createToken({ symbol: "BTC/USDC:USDC", percentage: 30 }),
      createToken({ symbol: "ETH/USDC:USDC", percentage: 10 }),
      createToken({ symbol: "SOL/USDC:USDC", percentage: 60 }),
    ]

    const asc: SortState = { column: "weight", direction: "asc" }
    const desc: SortState = { column: "weight", direction: "desc" }

    expect(applySort(tokens, asc)).toEqual([
      "ETH/USDC:USDC",
      "BTC/USDC:USDC",
      "SOL/USDC:USDC",
    ])
    expect(applySort(tokens, desc)).toEqual([
      "SOL/USDC:USDC",
      "BTC/USDC:USDC",
      "ETH/USDC:USDC",
    ])
  })

  it("sorts by notional using notional then targetNotional fallback", () => {
    const tokens = [
      createToken({ symbol: "BTC/USDC:USDC", notional: 200 }),
      createToken({ symbol: "ETH/USDC:USDC", targetNotional: 150, notional: undefined }),
      createToken({ symbol: "SOL/USDC:USDC", notional: 50 }),
    ]

    const asc: SortState = { column: "notional", direction: "asc" }
    const desc: SortState = { column: "notional", direction: "desc" }

    expect(applySort(tokens, asc)).toEqual([
      "SOL/USDC:USDC",
      "ETH/USDC:USDC",
      "BTC/USDC:USDC",
    ])
    expect(applySort(tokens, desc)).toEqual([
      "BTC/USDC:USDC",
      "ETH/USDC:USDC",
      "SOL/USDC:USDC",
    ])
  })

  it("sorts by side grouping longs and shorts deterministically", () => {
    const tokens = [
      createToken({ symbol: "BTC/USDC:USDC", side: "buy" }),
      createToken({ symbol: "ETH/USDC:USDC", side: "sell" }),
      createToken({ symbol: "SOL/USDC:USDC", side: "buy" }),
    ]

    const asc: SortState = { column: "side", direction: "asc" }
    const desc: SortState = { column: "side", direction: "desc" }

    // In asc, shorts (0) come before longs (1)
    expect(applySort(tokens, asc)).toEqual([
      "ETH/USDC:USDC",
      "BTC/USDC:USDC",
      "SOL/USDC:USDC",
    ])

    // In desc, longs come before shorts, secondary sort by market name (desc)
    expect(applySort(tokens, desc)).toEqual([
      "SOL/USDC:USDC",
      "BTC/USDC:USDC",
      "ETH/USDC:USDC",
    ])
  })

  it("marks weight sort as stale after notional-driven percentage change and resorts correctly", () => {
    // Initial state: sorted by weight desc
    const initialTokens = [
      createToken({ symbol: "BTC/USDC:USDC", percentage: 60, notional: 600 }),
      createToken({ symbol: "ETH/USDC:USDC", percentage: 30, notional: 300 }),
      createToken({ symbol: "SOL/USDC:USDC", percentage: 10, notional: 100 }),
    ]

    const sortState: SortState = { column: "weight", direction: "desc" }

    const sortedInitial = sortTokens(initialTokens, sortState!)
    const snapshotBefore = buildWeightSnapshot(sortedInitial)

    // User changes notional for SOL, making it the heaviest position by percentage
    const updatedTokens = [
      createToken({ symbol: "BTC/USDC:USDC", percentage: 40, notional: 400 }),
      createToken({ symbol: "ETH/USDC:USDC", percentage: 20, notional: 200 }),
      createToken({ symbol: "SOL/USDC:USDC", percentage: 40, notional: 400 }),
    ]

    const sortedUpdated = sortTokens(updatedTokens, sortState!)
    const snapshotAfter = buildWeightSnapshot(sortedUpdated)

    // Snapshot mismatch ⇒ needsResort.weight должно стать true
    expect(snapshotAfter).not.toEqual(snapshotBefore)

    // При повторном применении сортировки порядок должен отражать новые веса
    // и вторичную сортировку по market (desc) для одинаковых весов
    expect(sortedUpdated.map(token => token.symbol)).toEqual([
      "SOL/USDC:USDC",
      "BTC/USDC:USDC",
      "ETH/USDC:USDC",
    ])
  })

  it("marks notional sort as stale after weight-driven notional change and resorts correctly", () => {
    // Initial state: sorted by notional desc
    const initialTokens = [
      createToken({ symbol: "BTC/USDC:USDC", percentage: 60, notional: 600 }),
      createToken({ symbol: "ETH/USDC:USDC", percentage: 30, notional: 300 }),
      createToken({ symbol: "SOL/USDC:USDC", percentage: 10, notional: 100 }),
    ]

    const sortState: SortState = { column: "notional", direction: "desc" }

    const sortedInitial = sortTokens(initialTokens, sortState!)
    const snapshotBefore = buildNotionalSnapshot(sortedInitial)

    // User changes weight for ETH to become heaviest; hook логика пересчитает ее notional
    const updatedTokens = [
      createToken({ symbol: "BTC/USDC:USDC", percentage: 30, notional: 300 }),
      createToken({ symbol: "ETH/USDC:USDC", percentage: 50, notional: 500 }),
      createToken({ symbol: "SOL/USDC:USDC", percentage: 20, notional: 200 }),
    ]

    const sortedUpdated = sortTokens(updatedTokens, sortState!)
    const snapshotAfter = buildNotionalSnapshot(sortedUpdated)

    // Snapshot mismatch ⇒ needsResort.notional должно стать true
    expect(snapshotAfter).not.toEqual(snapshotBefore)

    // При повторном применении сортировки порядок должен отражать новые notionals
    expect(sortedUpdated.map(token => token.symbol)).toEqual([
      "ETH/USDC:USDC",
      "BTC/USDC:USDC",
      "SOL/USDC:USDC",
    ])
  })

  it("marks notional sort as stale when notionals change under active notional sort and resorts correctly", () => {
    const initialTokens = [
      createToken({ symbol: "BTC/USDC:USDC", notional: 100 }),
      createToken({ symbol: "ETH/USDC:USDC", notional: 200 }),
      createToken({ symbol: "SOL/USDC:USDC", notional: 300 }),
    ]

    const sortState: SortState = { column: "notional", direction: "desc" }

    const sortedInitial = sortTokens(initialTokens, sortState!)
    const snapshotBefore = buildNotionalSnapshot(sortedInitial)

    // Пользователь меняет notional напрямую (например, через инпут)
    const updatedTokens = [
      createToken({ symbol: "BTC/USDC:USDC", notional: 400 }),
      createToken({ symbol: "ETH/USDC:USDC", notional: 150 }),
      createToken({ symbol: "SOL/USDC:USDC", notional: 50 }),
    ]

    const sortedUpdated = sortTokens(updatedTokens, sortState!)
    const snapshotAfter = buildNotionalSnapshot(sortedUpdated)

    // Snapshot mismatch ⇒ needsResort.notional должно стать true
    expect(snapshotAfter).not.toEqual(snapshotBefore)

    // Пересортировка даёт новый корректный порядок по notional desc
    expect(sortedUpdated.map(token => token.symbol)).toEqual([
      "BTC/USDC:USDC",
      "ETH/USDC:USDC",
      "SOL/USDC:USDC",
    ])
  })

  it("marks weight sort as stale when weights change under active weight sort and resorts correctly", () => {
    const initialTokens = [
      createToken({ symbol: "BTC/USDC:USDC", percentage: 10 }),
      createToken({ symbol: "ETH/USDC:USDC", percentage: 20 }),
      createToken({ symbol: "SOL/USDC:USDC", percentage: 30 }),
    ]

    const sortState: SortState = { column: "weight", direction: "desc" }

    const sortedInitial = sortTokens(initialTokens, sortState!)
    const snapshotBefore = buildWeightSnapshot(sortedInitial)

    // Пользователь меняет weight напрямую
    const updatedTokens = [
      createToken({ symbol: "BTC/USDC:USDC", percentage: 5 }),
      createToken({ symbol: "ETH/USDC:USDC", percentage: 50 }),
      createToken({ symbol: "SOL/USDC:USDC", percentage: 45 }),
    ]

    const sortedUpdated = sortTokens(updatedTokens, sortState!)
    const snapshotAfter = buildWeightSnapshot(sortedUpdated)

    // Snapshot mismatch ⇒ needsResort.weight должно стать true
    expect(snapshotAfter).not.toEqual(snapshotBefore)

    // Пересортировка даёт новый корректный порядок по weight desc
    expect(sortedUpdated.map(token => token.symbol)).toEqual([
      "ETH/USDC:USDC",
      "SOL/USDC:USDC",
      "BTC/USDC:USDC",
    ])
  })

  it("marks side sort as stale when sides change under active side sort and resorts correctly", () => {
    const initialTokens = [
      createToken({ symbol: "BTC/USDC:USDC", side: "buy" }),
      createToken({ symbol: "ETH/USDC:USDC", side: "buy" }),
      createToken({ symbol: "SOL/USDC:USDC", side: "sell" }),
    ]

    const sortState: SortState = { column: "side", direction: "asc" }

    const sortedInitial = sortTokens(initialTokens, sortState!)
    const snapshotBefore = buildSideSnapshot(sortedInitial)

    // Пользователь меняет направление позиции
    const updatedTokens = [
      createToken({ symbol: "BTC/USDC:USDC", side: "sell" }),
      createToken({ symbol: "ETH/USDC:USDC", side: "buy" }),
      createToken({ symbol: "SOL/USDC:USDC", side: "sell" }),
    ]

    const sortedUpdated = sortTokens(updatedTokens, sortState!)
    const snapshotAfter = buildSideSnapshot(sortedUpdated)

    // Snapshot mismatch ⇒ needsResort.side должно стать true
    expect(snapshotAfter).not.toEqual(snapshotBefore)

    // Пересортировка даёт новый корректный порядок: сначала все shorts, затем longs
    expect(sortedUpdated.map(token => token.symbol)).toEqual([
      "BTC/USDC:USDC",
      "SOL/USDC:USDC",
      "ETH/USDC:USDC",
    ])
  })
})

