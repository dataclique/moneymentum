import { type OrderSide, type RebalanceParams } from "@/hooks/useTrading"

import type { PortfolioInterface } from "@/pages/Portfolio/hooks/usePortfolioState"

import { MIN_USD } from "@/pages/Portfolio/hooks/usePortfolioState"

export type RebalanceAction =
  | {
      kind: "close"
      symbol: string
      side: OrderSide
    }
  | {
      kind: "rebalance"
      symbol: string
      signedNotionalDelta: number
      leverage: number
      leverageChanged: boolean
    }
  | {
      kind: "preciseRebalance"
      symbol: string
      /** Target side for the open leg after the reduce-only close. */
      side: OrderSide
      leverage: number
      leverageChanged: boolean
      closeNotional: number
      openNotional: number
    }

export const buildApiPayload = (
  current: Record<string, PortfolioInterface | undefined>,
  target: Record<string, PortfolioInterface | undefined>,
  precise: boolean,
): RebalanceParams => {
  const actions = diffPortfolios(current, target, precise)
  return { actions }
}

const NOTIONAL_EPSILON = 0.1

/** Signed delta: targetSigned - currentSigned (same convention as diffPortfolios). */
export const preciseRebalanceLegs = (
  positionSide: OrderSide,
  deltaSigned: number,
  currentNotional: number,
): { closeNotional: number; openNotional: number } => {
  const m = MIN_USD

  const closeWanted =
    positionSide === "buy"
      ? deltaSigned > 0
        ? m
        : m + Math.abs(deltaSigned)
      : deltaSigned > 0
        ? m + deltaSigned
        : m

  const closeNotional = Math.min(currentNotional, closeWanted)
  const openNotional =
    positionSide === "buy"
      ? closeNotional + deltaSigned
      : closeNotional - deltaSigned

  return {
    closeNotional: Math.max(0, closeNotional),
    openNotional: Math.max(0, openNotional),
  }
}

const getSignedNotional = (side: OrderSide, notional: number) =>
  side === "buy" ? notional : -notional

/**
 * Compute minimal set of actions needed to transform current portfolio into target.
 * Pure function: does not know about UI status flags or external APIs.
 */
export const diffPortfolios = (
  current: Record<string, PortfolioInterface | undefined>,
  target: Record<string, PortfolioInterface | undefined>,
  precise: boolean,
): RebalanceAction[] => {
  const actions: RebalanceAction[] = []
  const allSymbols = new Set([...Object.keys(current), ...Object.keys(target)])

  for (const symbol of allSymbols) {
    const c = current[symbol]
    const t = target[symbol]

    const currentSigned = c ? getSignedNotional(c.side, c.notional) : 0
    const targetSigned = t ? getSignedNotional(t.side, t.notional) : 0

    const delta = targetSigned - currentSigned
    const deltaAbs = Math.abs(delta)

    if (c && !t) {
      actions.push({
        kind: "close",
        symbol,
        side: c.side,
      })
      continue
    }

    if (!t) {
      continue
    }

    const leverageChanged = c?.leverage !== t.leverage
    const hasSignificantDelta = deltaAbs > NOTIONAL_EPSILON

    if (!hasSignificantDelta && !leverageChanged) {
      continue
    }

    if (
      precise &&
      hasSignificantDelta &&
      deltaAbs < MIN_USD &&
      c?.side === t.side
    ) {
      const { closeNotional, openNotional } = preciseRebalanceLegs(
        t.side,
        delta,
        c.notional,
      )
      actions.push({
        kind: "preciseRebalance",
        symbol,
        side: t.side,
        leverage: t.leverage,
        leverageChanged,
        closeNotional,
        openNotional,
      })
      continue
    }

    actions.push({
      kind: "rebalance",
      symbol,
      signedNotionalDelta: delta,
      leverage: t.leverage,
      leverageChanged,
    })
  }

  return actions
}
