import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import Decimal from "decimal.js"

import type { OrderSide } from "@/hooks/useTrading"

const READONLY_BTC_STORAGE_KEY = "portfolio-readonly-btc-addresses"

interface ReadonlyBtcEntry {
  address: string
  includeInBeta: boolean
}

interface ExposureResponse {
  ubtc_price_usd: string
  positions: Array<{
    source: "hyperliquid" | "btc_address"
    source_id: string | null
    symbol: string
    side: OrderSide
    notional_usd: string
    quantity_btc: string | null
    tradability: "tradable" | "read_only"
    include_in_beta: "included" | "excluded"
  }>
  gross_long_usd: string
  gross_short_usd: string
  net_usd: string
}

interface ApiErrorResponse {
  error?: string
}

interface ReadonlyBtcRow {
  address: string
  includeInBeta: boolean
  quantityBtc: Decimal
  notionalUsd: Decimal
}

interface ReadonlyBetaPosition {
  symbol: string
  side: OrderSide
  notionalUsd: Decimal
  includeInBeta: boolean
}

const parseApiDecimal = (value: string | null | undefined): Decimal => {
  if (!value) return new Decimal(0)
  const parsed = new Decimal(value)
  return parsed.isFinite() ? parsed : new Decimal(0)
}

const readEntriesFromStorage = (): ReadonlyBtcEntry[] => {
  if (typeof localStorage === "undefined") return []
  const rawValue = localStorage.getItem(READONLY_BTC_STORAGE_KEY)
  if (!rawValue) return []

  try {
    const parsed = JSON.parse(rawValue) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((candidate): candidate is ReadonlyBtcEntry => {
        if (typeof candidate !== "object" || candidate === null) return false
        const address = (candidate as { address?: unknown }).address
        const includeInBeta = (candidate as { includeInBeta?: unknown })
          .includeInBeta
        return typeof address === "string" && typeof includeInBeta === "boolean"
      })
      .map(entry => ({
        address: entry.address.trim(),
        includeInBeta: entry.includeInBeta,
      }))
      .filter(entry => entry.address.length > 0)
  } catch {
    return []
  }
}

const writeEntriesToStorage = (entries: ReadonlyBtcEntry[]): void => {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(READONLY_BTC_STORAGE_KEY, JSON.stringify(entries))
}

const fetchExposure = async (
  entries: ReadonlyBtcEntry[],
  signal?: AbortSignal,
): Promise<ExposureResponse> => {
  const response = await fetch(
    `${import.meta.env.BASE_URL}api/portfolio/exposure`,
    {
      method: "POST",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hyperliquid_positions: [],
        readonly_btc_entries: entries.map(entry => ({
          address: entry.address,
          include_in_beta: entry.includeInBeta,
        })),
      }),
    },
  )

  if (!response.ok) {
    const responseText = await response.text()
    let errorDetail = responseText.trim()
    if (errorDetail.length > 0) {
      try {
        const parsed = JSON.parse(responseText) as ApiErrorResponse
        if (
          typeof parsed.error === "string" &&
          parsed.error.trim().length > 0
        ) {
          errorDetail = parsed.error.trim()
        }
      } catch {
        // Keep raw response text as error details when body is not JSON.
      }
    }
    if (errorDetail.length === 0) {
      errorDetail = "no additional error details from server"
    }
    throw new Error(
      `readonly exposure request failed (${String(response.status)}): ${errorDetail}`,
    )
  }
  return response.json() as Promise<ExposureResponse>
}

export const useReadonlyPortfolioState = () => {
  const [entries, setEntries] = createStore<ReadonlyBtcEntry[]>(
    readEntriesFromStorage(),
  )

  const query = useQuery(() => {
    const readonlyAddresses = entries.map(entry => entry.address)
    const enabled = readonlyAddresses.length > 0

    return {
      queryKey: ["readonly-btc-exposure", readonlyAddresses] as const,
      queryFn: (ctx: { signal: AbortSignal }) =>
        fetchExposure(entries, ctx.signal),
      enabled,
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }
  })

  const addAddress = (rawAddress: string) => {
    const normalizedAddress = rawAddress.trim()
    if (!normalizedAddress) return
    if (entries.some(entry => entry.address === normalizedAddress)) return

    const nextEntries = [
      ...entries,
      { address: normalizedAddress, includeInBeta: true },
    ]
    setEntries(nextEntries)
    writeEntriesToStorage(nextEntries)
  }

  const removeAddress = (address: string) => {
    const nextEntries = entries.filter(entry => entry.address !== address)
    setEntries(nextEntries)
    writeEntriesToStorage(nextEntries)
  }

  const setIncludeInBeta = (address: string, includeInBeta: boolean) => {
    const nextEntries = entries.map(entry =>
      entry.address === address ? { ...entry, includeInBeta } : entry,
    )
    setEntries(nextEntries)
    writeEntriesToStorage(nextEntries)
  }

  const readonlyRows = createMemo<ReadonlyBtcRow[]>(() => {
    const exposurePositions =
      query.data?.positions.filter(
        position => position.source === "btc_address",
      ) ?? []
    const byAddress = new Map(
      exposurePositions.map(position => [position.source_id ?? "", position]),
    )

    return entries.map(entry => {
      const position = byAddress.get(entry.address)
      return {
        address: entry.address,
        includeInBeta: entry.includeInBeta,
        quantityBtc: parseApiDecimal(position?.quantity_btc),
        notionalUsd: parseApiDecimal(position?.notional_usd),
      }
    })
  })

  const betaPositions = createMemo<ReadonlyBetaPosition[]>(() =>
    readonlyRows().map(row => ({
      symbol: "BTC",
      side: "buy",
      notionalUsd: row.notionalUsd,
      includeInBeta: row.includeInBeta,
    })),
  )

  return {
    get rows() {
      return readonlyRows()
    },
    get betaPositions() {
      return betaPositions()
    },
    get isLoading() {
      return query.isLoading
    },
    get error() {
      return query.error?.message ?? null
    },
    addAddress,
    removeAddress,
    setIncludeInBeta,
  }
}

export type { ReadonlyBtcRow, ReadonlyBetaPosition }
