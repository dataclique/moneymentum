import {
  useHyperliquidClient,
  type OrderSide,
  type RebalanceParams,
} from "@/hooks/useTrading"

import type { PortfolioInterface } from "@/pages/Portfolio/hooks/usePortfolioState"

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

/**
 * Build RebalanceParams payload for Hyperliquid from current/target portfolios.
 * Does not interact with Solid or query cache.
 */
export const buildApiPayload = (
  current: Record<string, PortfolioInterface>,
  target: Record<string, PortfolioInterface>,
  precise: boolean,
): RebalanceParams => {
  const actions = diffPortfolios(current, target)

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
): RebalanceAction[] => {
  const actions: RebalanceAction[] = []
  const allSymbols = new Set([...Object.keys(current), ...Object.keys(target)])

  for (const symbol of allSymbols) {
    const c = current[symbol]
    const t = target[symbol]

    const currentSigned = c ? getSignedNotional(c.side, c.notional) : 0
    const targetSigned = t ? getSignedNotional(t.side, t.notional) : 0

    const delta = targetSigned - currentSigned

    if (c && !t) {
      actions.push({
        kind: "close",
        symbol,
        side: c.side,
      })
      continue
    }

    if (t) {
      const leverageChanged = !c || Number(c.leverage) !== Number(t.leverage)

      // Погрешность: если дельта меньше 10 центов и плечо не менялось — игнорируем
      const NOTIONAL_EPSILON = 0.1
      const hasSignificantDelta = Math.abs(delta) > NOTIONAL_EPSILON

      if (hasSignificantDelta || leverageChanged) {
        actions.push({
          kind: "rebalance",
          symbol,
          notional: delta,
          leverage: Number(t.leverage),
          leverageChanged,
        })
      }
    }
  }

  return actions
}
