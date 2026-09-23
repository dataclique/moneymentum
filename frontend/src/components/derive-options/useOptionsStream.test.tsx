import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useOptionsStream } from "./useOptionsStream"

const firstExpiry = 1_800_000_000
const secondExpiry = 1_810_000_000
const bootstrap = {
  asset: "BTC",
  assets: ["BTC", "ETH"],
  default_expiry_unix: firstExpiry,
  tabs: [firstExpiry, secondExpiry].map(expiry_unix => ({
    expiry_unix,
    instruments: [],
  })),
}
const snapshot = {
  asset: "BTC",
  updated_at: "2026-09-22T00:00:00Z",
  active_expiry_unix: firstExpiry,
  expiry_unixes: [firstExpiry, secondExpiry],
  expiry_dates: [firstExpiry, secondExpiry].map(expiry =>
    new Date(expiry * 1000).toISOString(),
  ),
  spot_price: 0,
  strikes: [],
  quotes: [],
}
const emptySnapshot = {
  ...snapshot,
  active_expiry_unix: null,
  expiry_unixes: [],
  expiry_dates: [],
}

class TestEventSource {
  static instances: TestEventSource[] = []
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()

  constructor() {
    TestEventSource.instances.push(this)
  }

  emit(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    )
  }
}

const Probe = () => {
  const options = useOptionsStream(
    () => "mainnet",
    () => true,
    { clear: vi.fn() },
  )
  return (
    <>
      <span data-testid="loaded">{String(options.book.loaded)}</span>
      <span data-testid="loading">{String(options.isLoading())}</span>
      <span data-testid="asset">{options.selectedAsset()}</span>
      <span data-testid="expiry">{String(options.selectedExpiryUnix())}</span>
      <span data-testid="tabs">{options.expiryTabList().length}</span>
      <span data-testid="error">{options.errorMessage()}</span>
      <button
        onClick={() => {
          const next = options
            .expiryTabList()
            .find(tab => tab.unix === secondExpiry)
          if (next !== undefined) options.switchExpiryTab(next.unix)
        }}
      >
        Switch expiry
      </button>
      <button
        onClick={() => {
          options.switchAssetTab("ETH")
        }}
      >
        Switch asset
      </button>
    </>
  )
}

const installVenue = (boot: unknown, initialSnapshot: unknown) => {
  const fetch = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.includes("/bootstrap")) {
        return Promise.resolve(Response.json(boot))
      }
      if (url.includes("/snapshot")) {
        return Promise.resolve(Response.json(initialSnapshot))
      }
      if (init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    },
  )
  vi.stubGlobal("fetch", fetch)
  return fetch
}

beforeEach(() => {
  TestEventSource.instances = []
  vi.stubGlobal("EventSource", TestEventSource)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each(["bootstrap", "snapshot"])("%s initialization errors", stage => {
  it.each([
    {
      failure: "HTTP failure",
      response: () =>
        Response.json({ detail: "Options venue unavailable" }, { status: 503 }),
      message: "Options venue unavailable",
    },
    {
      failure: "invalid JSON",
      response: () => new Response("{", { status: 200 }),
      message: "The server returned a response we could not read.",
    },
    {
      failure: "invalid payload",
      response: () => Response.json({}),
      message: "Derive options data could not be read.",
    },
  ])(
    "renders the typed $failure instead of an opaque FiberFailure",
    async ({ response, message }) => {
      const fetch = installVenue(bootstrap, snapshot)
      if (stage === "snapshot") {
        fetch
          .mockResolvedValueOnce(Response.json(bootstrap))
          .mockResolvedValueOnce(new Response(null, { status: 204 }))
      }
      fetch.mockResolvedValueOnce(response())
      render(() => <Probe />)

      await waitFor(() => {
        expect(screen.getByTestId("loading").textContent).toBe("false")
      })
      expect(screen.getByTestId("error").textContent).toBe(message)
      expect(screen.getByTestId("loaded").textContent).toBe("false")
      expect(TestEventSource.instances).toHaveLength(0)
    },
  )
})

describe.each(["Switch expiry", "Switch asset"])(
  "%s completion ownership",
  buttonName => {
    it.each([204, 502])(
      "preserves the latest failure when an older POST returns %s",
      async status => {
        const olderPost = Effect.runSync(Deferred.make<Response>())
        const fetch = installVenue(bootstrap, snapshot)
        render(() => <Probe />)
        await waitFor(() => {
          expect(TestEventSource.instances).toHaveLength(1)
        })
        fetch
          .mockImplementationOnce(() =>
            Effect.runPromise(Deferred.await(olderPost)),
          )
          .mockResolvedValueOnce(
            Response.json(
              { detail: "Latest selection rejected" },
              { status: 503 },
            ),
          )

        screen.getByRole("button", { name: buttonName }).click()
        await waitFor(() => {
          expect(fetch).toHaveBeenCalledTimes(4)
        })
        screen.getByRole("button", { name: buttonName }).click()
        await waitFor(() => {
          expect(screen.getByTestId("error").textContent).toBe(
            "Latest selection rejected",
          )
        })
        expect(fetch.mock.calls[3][1]?.signal?.aborted).toBe(true)

        vi.useFakeTimers()
        Effect.runSync(
          Deferred.succeed(
            olderPost,
            status === 204
              ? new Response(null, { status })
              : Response.json(
                  { detail: "Older selection rejected" },
                  { status },
                ),
          ),
        )
        await vi.runAllTimersAsync()

        expect(screen.getByTestId("error").textContent).toBe(
          "Latest selection rejected",
        )
      },
    )
  },
)

describe("initialization and user-selection ordering", () => {
  it("does not replace a newer selection error with a late snapshot failure", async () => {
    const initialSnapshot = Effect.runSync(Deferred.make<Response>())
    const fetch = installVenue(bootstrap, snapshot)
    fetch
      .mockResolvedValueOnce(Response.json(bootstrap))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementationOnce(() =>
        Effect.runPromise(Deferred.await(initialSnapshot)),
      )
      .mockResolvedValueOnce(
        Response.json(
          { detail: "Selected expiry unavailable" },
          { status: 503 },
        ),
      )
    render(() => <Probe />)
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3)
    })

    screen.getByRole("button", { name: "Switch expiry" }).click()
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe(
        "Selected expiry unavailable",
      )
    })
    Effect.runSync(
      Deferred.succeed(
        initialSnapshot,
        Response.json({ detail: "Old snapshot failed" }, { status: 502 }),
      ),
    )
    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false")
    })

    expect(screen.getByTestId("error").textContent).toBe(
      "Selected expiry unavailable",
    )
    expect(screen.getByTestId("loaded").textContent).toBe("false")
    expect(TestEventSource.instances).toHaveLength(0)
  })

  it.each([200, 502])(
    "keeps a newer asset loading after the old snapshot returns %s",
    async status => {
      const initialSnapshot = Effect.runSync(Deferred.make<Response>())
      const fetch = installVenue(bootstrap, snapshot)
      fetch
        .mockResolvedValueOnce(Response.json(bootstrap))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockImplementationOnce(() =>
          Effect.runPromise(Deferred.await(initialSnapshot)),
        )
      render(() => <Probe />)
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(3)
      })

      screen.getByRole("button", { name: "Switch asset" }).click()
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(4)
      })
      Effect.runSync(
        Deferred.succeed(
          initialSnapshot,
          status === 200
            ? Response.json(snapshot)
            : Response.json({ detail: "Old snapshot unavailable" }, { status }),
        ),
      )
      await waitFor(() => {
        expect(TestEventSource.instances).toHaveLength(1)
      })

      expect(screen.getByTestId("asset").textContent).toBe("ETH")
      expect(screen.getByTestId("loaded").textContent).toBe("false")
      expect(screen.getByTestId("loading").textContent).toBe("true")
      TestEventSource.instances[0].emit({ ...snapshot, asset: "ETH" })
      expect(screen.getByTestId("loaded").textContent).toBe("true")
      expect(screen.getByTestId("loading").textContent).toBe("false")
    },
  )

  it("keeps the selected asset loading when an unrelated stream snapshot arrives", async () => {
    installVenue(bootstrap, snapshot)
    render(() => <Probe />)
    await waitFor(() => {
      expect(TestEventSource.instances).toHaveLength(1)
    })

    screen.getByRole("button", { name: "Switch asset" }).click()
    TestEventSource.instances[0].emit(snapshot)

    expect(screen.getByTestId("asset").textContent).toBe("ETH")
    expect(screen.getByTestId("loading").textContent).toBe("true")
    TestEventSource.instances[0].emit({ ...snapshot, asset: "ETH" })
    expect(screen.getByTestId("loading").textContent).toBe("false")
  })

  it.each([204, 502])(
    "preserves a newer selection failure after the default POST returns %s",
    async status => {
      const defaultPost = Effect.runSync(Deferred.make<Response>())
      const fetch = installVenue(bootstrap, snapshot)
      fetch
        .mockResolvedValueOnce(Response.json(bootstrap))
        .mockImplementationOnce(() =>
          Effect.runPromise(Deferred.await(defaultPost)),
        )
        .mockResolvedValueOnce(
          Response.json(
            { detail: "Selected expiry unavailable" },
            { status: 503 },
          ),
        )
      render(() => <Probe />)
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2)
      })
      expect(fetch.mock.calls[1][1]?.body).toBe(
        JSON.stringify({ expiry_unix: firstExpiry }),
      )

      screen.getByRole("button", { name: "Switch expiry" }).click()
      await waitFor(() => {
        expect(screen.getByTestId("error").textContent).toBe(
          "Selected expiry unavailable",
        )
      })
      expect(fetch.mock.calls[2][1]?.body).toBe(
        JSON.stringify({ expiry_unix: secondExpiry }),
      )
      Effect.runSync(
        Deferred.succeed(
          defaultPost,
          status === 204
            ? new Response(null, { status })
            : Response.json(
                { detail: "Old default expiry failed" },
                { status },
              ),
        ),
      )
      await waitFor(() => {
        expect(screen.getByTestId("loading").textContent).toBe("false")
      })

      expect(screen.getByTestId("error").textContent).toBe(
        "Selected expiry unavailable",
      )
      expect(screen.getByTestId("expiry").textContent).toBe(String(firstExpiry))
      expect(TestEventSource.instances).toHaveLength(1)
    },
  )
})

describe("empty options catalogue lifecycle", () => {
  it("initializes an empty catalogue without posting a null expiry", async () => {
    const fetch = installVenue(
      { ...bootstrap, default_expiry_unix: null, tabs: [] },
      emptySnapshot,
    )
    render(() => <Probe />)

    await waitFor(() => {
      expect(screen.getByTestId("loaded").textContent).toBe("true")
    })
    expect(screen.getByTestId("expiry").textContent).toBe("null")
    expect(screen.getByTestId("tabs").textContent).toBe("0")
    expect(screen.getByTestId("error").textContent).toBe("")
    expect(TestEventSource.instances).toHaveLength(1)
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      false,
    )
  })

  it("does not restore stale bootstrap tabs after the last expiry disappears", async () => {
    installVenue(bootstrap, snapshot)
    render(() => <Probe />)
    await waitFor(() => {
      expect(TestEventSource.instances).toHaveLength(1)
    })
    expect(screen.getByTestId("tabs").textContent).toBe("2")

    TestEventSource.instances[0].emit(emptySnapshot)

    expect(screen.getByTestId("expiry").textContent).toBe("null")
    expect(screen.getByTestId("tabs").textContent).toBe("0")
  })

  it("clears a pending expiry when the stream removes the whole catalogue", async () => {
    installVenue(bootstrap, snapshot)
    render(() => <Probe />)
    await waitFor(() => {
      expect(TestEventSource.instances).toHaveLength(1)
    })
    screen.getByRole("button", { name: "Switch expiry" }).click()
    expect(screen.getByTestId("expiry").textContent).toBe(String(secondExpiry))

    TestEventSource.instances[0].emit(emptySnapshot)

    expect(screen.getByTestId("expiry").textContent).toBe("null")
    expect(screen.getByTestId("tabs").textContent).toBe("0")
  })
})
