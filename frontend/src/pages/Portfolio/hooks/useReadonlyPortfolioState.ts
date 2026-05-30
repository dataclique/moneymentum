import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"

import type { OrderSide } from "@/hooks/useTrading"
import { useWallet } from "@/hooks/useWallet"
import { validateBitcoinAddress } from "./bitcoinAddress"

const READONLY_BTC_STORAGE_KEY = "portfolio-readonly-btc-addresses"

interface ReadonlyBtcEntry {
  address: string
  includeInBeta: boolean
}

interface ExposureResponse {
  ubtc_price_usd: number
  positions: Array<{
    source: "hyperliquid" | "btc_address"
    source_id: string | null
    symbol: string
    side: OrderSide
    notional_usd: number
    quantity_btc: number | null
    is_tradable: boolean
    include_in_beta: boolean
  }>
  gross_long_usd: number
  gross_short_usd: number
  net_usd: number
}

interface ApiErrorResponse {
  error?: string
}

interface ReadonlyBtcRow {
  address: string
  includeInBeta: boolean
  quantityBtc: number
  notionalUsd: number
}

interface ReadonlyBetaPosition {
  symbol: string
  side: OrderSide
  notionalUsd: number
  includeInBeta: boolean
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

const clearEntriesFromStorage = (): void => {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(READONLY_BTC_STORAGE_KEY)
}

const fetchExposure = async (
  entries: ReadonlyBtcEntry[],
  networkMode: "testnet" | "mainnet",
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
        btc_network: networkMode,
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
  const { networkMode } = useWallet()
  const [entries, setEntries] = createStore<ReadonlyBtcEntry[]>(
    readEntriesFromStorage(),
  )
  const [validationError, setValidationError] = createSignal<string | null>(
    null,
  )

  const query = useQuery(() => {
    const readonlyAddresses = entries.map(entry => entry.address)
    const enabled = readonlyAddresses.length > 0

    return {
      queryKey: [
        "readonly-btc-exposure",
        networkMode(),
        readonlyAddresses,
      ] as const,
      queryFn: (ctx: { signal: AbortSignal }) =>
        fetchExposure(entries, networkMode(), ctx.signal),
      enabled,
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }
  })

  const addAddress = (rawAddress: string) => {
    const normalizedAddress = rawAddress.trim()
    if (!normalizedAddress) {
      setValidationError(null)
      return false
    }
    const validation = validateBitcoinAddress(normalizedAddress, networkMode())
    if (!validation.ok) {
      console.warn(validation.error.message, {
        error: validation.error,
        network: networkMode(),
      })
      setValidationError(validation.error.message)
      return false
    }
    if (entries.some(entry => entry.address === normalizedAddress)) {
      setValidationError(null)
      return false
    }

    const nextEntries = [
      ...entries,
      { address: normalizedAddress, includeInBeta: true },
    ]
    setEntries(nextEntries)
    writeEntriesToStorage(nextEntries)
    setValidationError(null)
    return true
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

  const clearAddresses = () => {
    setEntries([])
    clearEntriesFromStorage()
    setValidationError(null)
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
        quantityBtc: position?.quantity_btc ?? 0,
        notionalUsd: position?.notional_usd ?? 0,
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
    get validationError() {
      return validationError()
    },
    addAddress,
    removeAddress,
    setIncludeInBeta,
    clearAddresses,
  }
}

export type { ReadonlyBtcRow, ReadonlyBetaPosition }
