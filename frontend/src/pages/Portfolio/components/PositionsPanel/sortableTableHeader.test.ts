import { describe, expect, it } from "vitest"

import { compareNullableNumbers } from "./sortableTableHeader"

const applyTableSort = (
  left: number | null,
  right: number | null,
  isDesc: boolean,
): number => {
  const sortInt = compareNullableNumbers(left, right, isDesc)
  return isDesc ? sortInt * -1 : sortInt
}

describe("compareNullableNumbers", () => {
  it("keeps null values after populated values when sorting ascending", () => {
    expect(applyTableSort(10, null, false)).toBeLessThan(0)
    expect(applyTableSort(null, 10, false)).toBeGreaterThan(0)
  })

  it("keeps null values after populated values when sorting descending", () => {
    expect(applyTableSort(10, null, true)).toBeLessThan(0)
    expect(applyTableSort(null, 10, true)).toBeGreaterThan(0)
  })

  it("sorts populated values in the requested direction", () => {
    expect(applyTableSort(5, 10, false)).toBeLessThan(0)
    expect(applyTableSort(5, 10, true)).toBeGreaterThan(0)
  })
})
