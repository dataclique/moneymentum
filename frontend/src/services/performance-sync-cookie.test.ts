import { describe, expect, it, beforeEach, afterEach } from "vitest"

import {
  PERFORMANCE_SYNC_MAX_AGE_MS,
  isPerformanceSyncStale,
  readPerformanceSyncedAt,
  writePerformanceSyncedAt,
} from "./performance-sync-cookie"

describe("performance-sync-cookie", () => {
  beforeEach(() => {
    document.cookie.split("; ").forEach(part => {
      const name = part.split("=")[0] ?? ""
      if (name.startsWith("perf_synced_")) {
        document.cookie = `${name}=; path=/; max-age=0`
      }
    })
  })

  afterEach(() => {
    document.cookie.split("; ").forEach(part => {
      const name = part.split("=")[0] ?? ""
      if (name.startsWith("perf_synced_")) {
        document.cookie = `${name}=; path=/; max-age=0`
      }
    })
  })

  it("treats missing cookie as stale", () => {
    expect(isPerformanceSyncStale("0xabc")).toBe(true)
  })

  it("writes and reads synced timestamp", () => {
    writePerformanceSyncedAt("0xAbC", 1_700_000_000_000)
    expect(readPerformanceSyncedAt("0xabc")).toBe(1_700_000_000_000)
    expect(
      isPerformanceSyncStale(
        "0xabc",
        1_700_000_000_000 + PERFORMANCE_SYNC_MAX_AGE_MS - 1,
      ),
    ).toBe(false)
    expect(
      isPerformanceSyncStale(
        "0xabc",
        1_700_000_000_000 + PERFORMANCE_SYNC_MAX_AGE_MS + 1,
      ),
    ).toBe(true)
  })
})
