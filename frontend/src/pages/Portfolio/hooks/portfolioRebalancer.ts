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
      notional: number
      leverage: number
      leverageChanged: boolean
    }
  | {
      kind: "preciseRebalance"
      symbol: string
      currentNotionalAbs: number
      currentSide: OrderSide
      closeSide: OrderSide

      closeUsdAmount: number

      targetNotionalAbs: number
      targetSide: OrderSide
      openNotionalDelta: number

      leverage: number
      leverageChanged: boolean
    }

export const buildApiPayload = (
  current: Record<string, PortfolioInterface>,
  target: Record<string, PortfolioInterface>,
  precise: boolean,
): RebalanceParams => {
  const actions = diffPortfolios(current, target, precise)
  return { precise, actions }
}

/**
 * Compute minimal set of actions needed to transform current portfolio into target.
 * Pure function: does not know about UI status flags or external APIs.
 */
/** * Расчет знакового ношинала для математических операций.
 */
const getSignedNotional = (side: OrderSide, notional: number) =>
  side === "buy" ? notional : -notional

export const diffPortfolios = (
  current: Record<string, PortfolioInterface>,
  target: Record<string, PortfolioInterface>,
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

    console.log(symbol, ["symbol"])
    console.log(currentSigned, ["currentSigned"])
    console.log(targetSigned, ["targetSigned"])
    console.log(delta, ["delta"])
    console.log(deltaAbs, ["deltaAbs"])

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

    const leverageChanged = !c || Number(c.leverage) !== Number(t.leverage)

    const NOTIONAL_EPSILON = 0.1
    const hasSignificantDelta = deltaAbs > NOTIONAL_EPSILON

    //precise
    console.log(
      precise,
      ["precise"],
      hasSignificantDelta,
      ["hasSignificantDelta"],
      deltaAbs,
      ["deltaAbs"],
    )
    if (precise && hasSignificantDelta && deltaAbs < MIN_USD) {
      const targetNotionalAbs = Math.abs(t.notional)
      const currentNotionalAbs = Math.abs(c.notional)
      const closeSide: OrderSide = c.side === "buy" ? "sell" : "buy"
      const targetSide: OrderSide = t.side

      let closeUsdAmount: number
      let openUsdAbs: number

      const notionalDeltaAbs = Math.abs(targetNotionalAbs - currentNotionalAbs)

      if (targetNotionalAbs > currentNotionalAbs) {
        // Increase: sell $11 (or everything if smaller) then buy ($11 + delta)
        if (currentNotionalAbs <= MIN_USD) {
          closeUsdAmount = currentNotionalAbs
          openUsdAbs = targetNotionalAbs
        } else {
          closeUsdAmount = MIN_USD
          openUsdAbs = MIN_USD + notionalDeltaAbs
        }
      } else {
        // Decrease: sell ($11 + delta) then buy $11
        closeUsdAmount = MIN_USD + notionalDeltaAbs
        openUsdAbs = MIN_USD
      }

      const openNotionalDelta = targetSide === "buy" ? openUsdAbs : -openUsdAbs

      actions.push({
        kind: "preciseRebalance",
        symbol,
        currentNotionalAbs,
        currentSide: c.side,
        closeSide,
        closeUsdAmount,
        targetNotionalAbs,
        targetSide,
        openNotionalDelta,
        leverage: Number(t.leverage),
        leverageChanged,
      })
      continue
    }

    // Regular rebalance

    if (hasSignificantDelta || leverageChanged) {
      actions.push({
        kind: "rebalance",
        symbol,
        notional: delta,
        leverage: t.leverage,
        leverageChanged,
      })
      continue
    }
  }

  // This function is called from Solid `createMemo` as portfolios change,
  // so logging here provides visibility into every reactive update.
  console.log(actions, ["diffPortfolios"])

  return actions
}
