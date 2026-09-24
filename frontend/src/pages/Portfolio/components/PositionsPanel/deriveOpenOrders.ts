import {
  parseDeriveNumeric,
  type DeriveApiOrder,
} from "@/services/derive/index"

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** Derive instrument_name: BTC-20250821-62000-P */
const DERIVE_INSTRUMENT_NAME = /^([A-Za-z]+)-(\d{8})-(\d+(?:\.\d+)?)-([CPcp])$/

export interface DeriveOpenOrderRow {
  id: string
  symbol: string
  label: string
  side: "buy" | "sell" | null
  amount: number | null
  price: number | null
  notional: number | null
  status: string
  orderType: string
}

const parseFiniteNumber = (value: unknown): number | null => {
  const parsed = parseDeriveNumeric(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : null
}

export const formatDeriveInstrumentLabel = (raw: string): string => {
  const match = DERIVE_INSTRUMENT_NAME.exec(raw.trim())
  if (match === null) {
    return raw
  }

  const underlyingRaw = match[1]
  const yyyymmdd = match[2]
  const strikeRaw = match[3]
  const optionCodeRaw = match[4]
  const monthIndex = Number.parseInt(yyyymmdd.slice(4, 6), 10) - 1
  if (monthIndex < 0 || monthIndex > 11) {
    return raw
  }
  const day = Number.parseInt(yyyymmdd.slice(6, 8), 10)
  if (day < 1 || day > 31) {
    return raw
  }

  const year = Number.parseInt(yyyymmdd.slice(0, 4), 10)
  if (!Number.isFinite(year) || year < 1970) {
    return raw
  }

  const month = MONTH_ABBREVIATIONS[monthIndex]
  const strike = Number.parseFloat(strikeRaw)
  const strikeLabel = Number.isFinite(strike)
    ? `$${strike.toLocaleString("en-US", { maximumFractionDigits: 4 })}`
    : `$${strikeRaw}`
  const optionLabel = optionCodeRaw.toUpperCase() === "P" ? "Put" : "Call"
  const currentYear = new Date().getUTCFullYear()
  const dateLabel =
    year === currentYear
      ? `${month} ${String(day)}`
      : `${month} ${String(day)} ${String(year)}`

  return `${underlyingRaw.toUpperCase()} ${strikeLabel} ${optionLabel} ${dateLabel}`
}

/**
 * Resting size in contracts: amount minus filled_amount from Derive wire.
 */
const readRestingAmount = (order: DeriveApiOrder): number | null => {
  const total = parseFiniteNumber(order.amount)
  if (total === null) {
    return null
  }

  const filled = parseFiniteNumber(order.filled_amount) ?? 0
  return Math.max(total - filled, 0)
}

const readLimitPrice = (order: DeriveApiOrder): number | null =>
  parseFiniteNumber(order.limit_price) ?? parseFiniteNumber(order.average_price)

/** USD notional for a resting order: |size * limit price|. */
const readNotional = (
  amount: number | null,
  price: number | null,
): number | null => {
  if (amount !== null && price !== null) {
    return Math.abs(amount * price)
  }
  return null
}

export const mapDeriveOpenOrderRow = (
  order: DeriveApiOrder,
): DeriveOpenOrderRow | null => {
  const id =
    typeof order.order_id === "string" && order.order_id.length > 0
      ? order.order_id
      : null
  const symbol =
    typeof order.instrument_name === "string" &&
    order.instrument_name.length > 0
      ? order.instrument_name
      : null

  if (id === null || symbol === null) {
    return null
  }

  const sideRaw = (order.direction ?? "").toLowerCase()
  const side: DeriveOpenOrderRow["side"] =
    sideRaw === "buy" || sideRaw === "sell" ? sideRaw : null

  const amount = readRestingAmount(order)
  const price = readLimitPrice(order)
  const notional = readNotional(amount, price)

  const status =
    typeof order.order_status === "string" && order.order_status.length > 0
      ? order.order_status
      : "open"

  const orderType =
    typeof order.order_type === "string" && order.order_type.length > 0
      ? order.order_type
      : "limit"

  return {
    id,
    symbol,
    label: formatDeriveInstrumentLabel(symbol),
    side,
    amount,
    price,
    notional,
    status,
    orderType,
  }
}

export const mapDeriveOpenOrderRows = (
  orders: DeriveApiOrder[],
): DeriveOpenOrderRow[] =>
  orders.flatMap(order => {
    const row = mapDeriveOpenOrderRow(order)
    return row === null ? [] : [row]
  })

/** Auto-refresh cadence for Derive open orders (matches the timer ring). */
export const OPEN_DERIVE_ORDERS_REFRESH_MS = 10_000

/** Progress 0..1 along a refresh cycle wall-clock window. */
export const refreshProgressAlongCycle = (
  startedAtMs: number,
  nowMs: number,
  durationMs: number,
): number => {
  if (durationMs <= 0) {
    return 1
  }
  return Math.min(1, Math.max(0, (nowMs - startedAtMs) / durationMs))
}
