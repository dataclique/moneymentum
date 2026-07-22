/**
 * Lazy loader for the CCXT-backed Hyperliquid client module.
 *
 * Prefetch on Portfolio mount so the UI can paint while the chunk downloads;
 * trading code awaits `ensureHyperliquidClientModule` only when building a
 * client instance.
 */

type HyperliquidClientModule = typeof import("@/services/hyperliquid-client")

let loadPromise: Promise<HyperliquidClientModule> | null = null

export const prefetchHyperliquidClientModule = (): void => {
  void ensureHyperliquidClientModule()
}

export const ensureHyperliquidClientModule =
  (): Promise<HyperliquidClientModule> => {
    loadPromise ??= import("@/services/hyperliquid-client")
    return loadPromise
  }
