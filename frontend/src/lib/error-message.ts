import * as Cause from "effect/Cause"
import * as Option from "effect/Option"
import * as Runtime from "effect/Runtime"

/**
 * Turns any error surfaced to the UI into human-readable display text.
 *
 * Effects bridged to TanStack Query via `Effect.runPromise` reject with a
 * `FiberFailure` whose own `message` is generic, so the tagged error has to be
 * unwrapped from its `Cause` before it can be matched on `_tag`. Components must
 * render errors through this helper instead of reading `error.message`.
 */
export const getErrorMessage = (error: unknown): string => {
  const unwrapped = unwrapTaggedError(error)

  if (hasTag(unwrapped)) {
    const message = messageForTag(unwrapped)
    if (message !== null) return message
  }

  if (unwrapped instanceof Error) return unwrapped.message

  return String(unwrapped)
}

/** Unwraps ExchangeRequestError to the underlying exchange failure for logs. */
export const getExchangeErrorDetail = (error: unknown): string => {
  const unwrapped = unwrapTaggedError(error)

  if (
    hasTag(unwrapped) &&
    unwrapped._tag === "ExchangeRequestError" &&
    "cause" in unwrapped
  ) {
    const cause = (unwrapped as { cause: unknown }).cause
    if (cause instanceof Error) return cause.message
    return String(cause)
  }

  return getErrorMessage(error)
}

const unwrapTaggedError = (error: unknown): unknown => {
  if (Runtime.isFiberFailure(error)) {
    const failure = Cause.failureOption(error[Runtime.FiberFailureCauseId])
    if (Option.isSome(failure)) return failure.value
  }
  return error
}

interface TaggedError {
  readonly _tag: string
  readonly status?: number
  readonly detail?: string
  readonly message?: string
}

const hasTag = (value: unknown): value is TaggedError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  typeof (value as { _tag: unknown })._tag === "string"

const messageForTag = (error: TaggedError): string | null => {
  switch (error._tag) {
    case "NetworkError":
      return "Network request failed. Check your connection and try again."
    case "HttpStatusError":
      return (
        error.detail ??
        (error.status
          ? `Request failed with status ${error.status}.`
          : "Request failed.")
      )
    case "JsonParseError":
      return "The server returned a response we could not read."
    case "JsonSerializeError":
      return "We could not encode the request."
    case "MissingTickerError":
      return "Select a ticker to continue."
    case "EmptyStreamError":
      return "The server returned an empty response."
    case "StreamReadError":
      return "We lost the connection while reading the server response."
    case "ApiMessageError":
      return error.message ?? "The server reported an error."
    case "WalletNotConnected":
      return "Connect a wallet to continue."
    case "ExchangeRequestError": {
      const cause =
        "cause" in error && error.cause instanceof Error ? error.cause : null
      if (cause !== null && cause.message.length > 0) {
        return cause.message
      }
      return "The exchange rejected the request. Please try again."
    }
    case "WalletConnectError":
      return "Failed to save wallet credentials. Please try again."
    case "WalletUnlockError":
      return "Failed to unlock wallet. Please try again."
    case "WalletIncorrectPin":
      return "Incorrect PIN"
    case "WalletCredentialCryptoFailure":
      return "Failed to unlock wallet. Please try again."
    case "WalletSessionMissing":
      return "No saved wallet session found."
    default:
      return null
  }
}
