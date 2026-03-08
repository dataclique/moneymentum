import { Data, Effect } from "effect"

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly cause: unknown
}> {}

export class HttpStatusError extends Data.TaggedError("HttpStatusError")<{
  readonly status: number
  readonly detail?: string | undefined
}> {}

export class JsonParseError extends Data.TaggedError("JsonParseError")<{
  readonly cause: unknown
}> {}

const request = (
  url: string,
  init?: RequestInit,
): Effect.Effect<Response, NetworkError> =>
  Effect.tryPromise({
    try: () => fetch(url, init),
    catch: cause => new NetworkError({ cause }),
  })

const ensureOk = (
  response: Response,
): Effect.Effect<Response, HttpStatusError> =>
  response.ok
    ? Effect.succeed(response)
    : Effect.tryPromise({
        try: () => response.json() as Promise<{ detail?: string }>,
        catch: () => ({ detail: undefined }),
      }).pipe(
        Effect.catchAll(() => Effect.succeed({ detail: undefined })),
        Effect.flatMap(body =>
          Effect.fail(
            new HttpStatusError({
              status: response.status,
              detail: body.detail,
            }),
          ),
        ),
      )

const parseJson = <A>(response: Response): Effect.Effect<A, JsonParseError> =>
  Effect.tryPromise({
    try: () => response.json() as Promise<A>,
    catch: cause => new JsonParseError({ cause }),
  })

export const fetchJson = <A>(
  url: string,
  init?: RequestInit,
): Effect.Effect<A, NetworkError | HttpStatusError | JsonParseError> =>
  request(url, init).pipe(Effect.flatMap(ensureOk), Effect.flatMap(parseJson))

export const postJson = <A>(
  url: string,
  body: unknown,
  init?: RequestInit,
): Effect.Effect<A, NetworkError | HttpStatusError | JsonParseError> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (init?.headers) {
    const entries =
      init.headers instanceof Headers
        ? Array.from(init.headers.entries())
        : Array.isArray(init.headers)
          ? init.headers
          : Object.entries(init.headers)
    for (const [key, value] of entries) {
      headers[key] = value
    }
  }

  return fetchJson(url, {
    ...init,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

export const postEmpty = (
  url: string,
  init?: RequestInit,
): Effect.Effect<void, NetworkError | HttpStatusError> =>
  request(url, { ...init, method: "POST" }).pipe(
    Effect.flatMap(ensureOk),
    Effect.asVoid,
  )
