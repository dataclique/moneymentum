import { describe, expect, it } from "vitest"

import { diffPortfolios, preciseRebalanceLegs } from "./portfolioRebalancer"
import { MIN_USD, type PortfolioInterface } from "./usePortfolioState"

const buy = (notional: number, leverage = 2): PortfolioInterface => ({
  symbol: "BTC/USDC:USDC",
  side: "buy",
  leverage,
  notional,
})

const sell = (notional: number, leverage = 2): PortfolioInterface => ({
  symbol: "BTC/USDC:USDC",
  side: "sell",
  leverage,
  notional,
})

describe("preciseRebalanceLegs", () => {
  const m = MIN_USD
  const current = 100

  it("long increase by 2: close m then open m+2", () => {
    expect(preciseRebalanceLegs("buy", 2, current)).toEqual({
      closeNotional: m,
      openNotional: m + 2,
    })
  })

  it("long decrease by 2: close m+2 then open m", () => {
    expect(preciseRebalanceLegs("buy", -2, current)).toEqual({
      closeNotional: m + 2,
      openNotional: m,
    })
  })

  it("short deeper by 2 (signed delta -2): close m then open m+2", () => {
    expect(preciseRebalanceLegs("sell", -2, current)).toEqual({
      closeNotional: m,
      openNotional: m + 2,
    })
  })

  it("short reduce by 2 (signed delta +2): close m+2 then open m", () => {
    expect(preciseRebalanceLegs("sell", 2, current)).toEqual({
      closeNotional: m + 2,
      openNotional: m,
    })
  })

  it("caps close leg by current notional when current is below min", () => {
    expect(preciseRebalanceLegs("buy", 2, 5)).toEqual({
      closeNotional: 5,
      openNotional: 7,
    })
  })
})

describe("diffPortfolios precise mode", () => {
  const sym = "BTC/USDC:USDC"

  it("uses preciseRebalance when precise, same side, delta below min order", () => {
    const current: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100), symbol: sym },
    }
    const target: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(102), symbol: sym },
    }

    const actions = diffPortfolios(current, target, true)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: "preciseRebalance",
      symbol: sym,
      side: "buy",
      closeNotional: MIN_USD,
      openNotional: MIN_USD + 2,
    })
  })

  it("uses single rebalance when precise but delta at or above min order", () => {
    const current: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100), symbol: sym },
    }
    const target: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100 + MIN_USD), symbol: sym },
    }

    const actions = diffPortfolios(current, target, true)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: "rebalance",
      notional: MIN_USD,
    })
  })

  it("uses rebalance when not precise even if delta is small", () => {
    const current: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100), symbol: sym },
    }
    const target: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(102), symbol: sym },
    }

    const actions = diffPortfolios(current, target, false)
    expect(actions[0]).toMatchObject({ kind: "rebalance", notional: 2 })
  })

  it("never emits preciseRebalance when side flips (uses rebalance)", () => {
    const current: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100), symbol: sym },
    }
    const target: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...sell(100), symbol: sym },
    }

    const actions = diffPortfolios(current, target, true)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: "rebalance" })
  })

  it("emits preciseRebalance for short same-side delta below min order", () => {
    const current: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...sell(100), symbol: sym },
    }
    const target: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...sell(102), symbol: sym },
    }

    const actions = diffPortfolios(current, target, true)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: "preciseRebalance",
      side: "sell",
      closeNotional: MIN_USD,
      openNotional: MIN_USD + 2,
    })
  })

  it("emits nothing when notional delta is within NOTIONAL_EPSILON", () => {
    const current: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100), symbol: sym },
    }
    const target: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100.05), symbol: sym },
    }

    expect(diffPortfolios(current, target, true)).toHaveLength(0)
  })

  it("emits rebalance with zero notional when only leverage changes", () => {
    const current: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100), symbol: sym, leverage: 2 },
    }
    const target: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100), symbol: sym, leverage: 5 },
    }

    const actions = diffPortfolios(current, target, true)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: "rebalance",
      notional: 0,
      leverage: 5,
      leverageChanged: true,
    })
  })

  it("emits close when symbol drops out of target portfolio", () => {
    const current: Record<string, PortfolioInterface | undefined> = {
      [sym]: { ...buy(100), symbol: sym },
    }
    const target: Record<string, PortfolioInterface | undefined> = {}

    const actions = diffPortfolios(current, target, false)
    expect(actions).toEqual([
      expect.objectContaining({
        kind: "close",
        symbol: sym,
        side: "buy",
      }),
    ])
  })
})
