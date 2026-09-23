import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import {
  OptionsBootstrap,
  decodeOptionsSnapshotEither,
} from "./optionsSnapshot"

const decodeBootstrap = Schema.decodeUnknownEither(OptionsBootstrap)

const emptySnapshot = {
  asset: "BTC",
  updated_at: "2026-09-22T00:00:00Z",
  active_expiry_unix: null,
  expiry_unixes: [],
  spot_price: 0,
  expiry_dates: [],
  strikes: [],
  quotes: [],
}

const emptyBootstrap = {
  asset: "BTC",
  assets: ["BTC"],
  default_expiry_unix: null,
  tabs: [],
}

describe("empty options catalogue payloads", () => {
  it("decodes an empty snapshot with no active expiry", () => {
    expect(decodeOptionsSnapshotEither(emptySnapshot)).toEqual(
      Either.right(emptySnapshot),
    )
  })

  it("decodes an empty bootstrap without inventing a default expiry", () => {
    expect(decodeBootstrap(emptyBootstrap)).toEqual(
      Either.right(emptyBootstrap),
    )
  })

  it("still rejects an omitted snapshot expiry", () => {
    expect(
      Either.isLeft(
        decodeOptionsSnapshotEither({
          ...emptySnapshot,
          active_expiry_unix: undefined,
        }),
      ),
    ).toBe(true)
  })

  it("still rejects an omitted bootstrap expiry", () => {
    expect(
      Either.isLeft(
        decodeBootstrap({
          ...emptyBootstrap,
          default_expiry_unix: undefined,
        }),
      ),
    ).toBe(true)
  })
})
