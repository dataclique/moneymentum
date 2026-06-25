/**
 * The app is served under a base path (e.g. `/moneymentum/`, exposed as
 * `import.meta.env.BASE_URL`), not the server root. Every backend call must be
 * relative to that base so the same build works at any mount point.
 */

/** URL for a backend API path, e.g. `apiUrl("date-range")` -> `/moneymentum/api/date-range`. */
export const apiUrl = (path: string): string =>
  `${import.meta.env.BASE_URL}api/${path}`

/** URL for a base-relative path, e.g. the hyperliquid proxies `baseUrl("hl")` -> `/moneymentum/hl`. */
export const baseUrl = (path: string): string =>
  `${import.meta.env.BASE_URL}${path}`
