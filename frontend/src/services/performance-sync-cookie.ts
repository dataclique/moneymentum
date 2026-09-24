/**
 * Client cookie for performance cache freshness (2h).
 * Keyed by public wallet address — never stores private keys.
 */

const COOKIE_PREFIX = "perf_synced_"
export const PERFORMANCE_SYNC_MAX_AGE_MS = 2 * 60 * 60 * 1000

const cookieNameForWallet = (walletAddress: string): string =>
  `${COOKIE_PREFIX}${walletAddress.trim().toLowerCase()}`

export const readPerformanceSyncedAt = (
  walletAddress: string,
): number | null => {
  if (typeof document === "undefined") return null
  const name = cookieNameForWallet(walletAddress)
  const match = document.cookie
    .split("; ")
    .find(part => part.startsWith(`${name}=`))
  if (match === undefined) return null
  const raw = match.slice(name.length + 1)
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export const writePerformanceSyncedAt = (
  walletAddress: string,
  syncedAtMs: number = Date.now(),
): void => {
  if (typeof document === "undefined") return
  const name = cookieNameForWallet(walletAddress)
  const maxAgeSeconds = Math.floor(PERFORMANCE_SYNC_MAX_AGE_MS / 1000)
  document.cookie = `${name}=${syncedAtMs}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`
}

export const isPerformanceSyncStale = (
  walletAddress: string,
  nowMs: number = Date.now(),
): boolean => {
  const syncedAt = readPerformanceSyncedAt(walletAddress)
  if (syncedAt === null) return true
  return nowMs - syncedAt > PERFORMANCE_SYNC_MAX_AGE_MS
}
