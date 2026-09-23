import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal, type JSX } from "solid-js"
import { afterEach, expect, it } from "vitest"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

afterEach(cleanup)

const SelectFixture = (props: {
  content?: JSX.Element
  virtualized?: boolean
}) => {
  const [selection, setSelection] = createSignal<string | null>("First")
  return (
    <>
      <Select<string>
        options={["First", "Second"]}
        virtualized={props.virtualized}
        value={selection()}
        onChange={setSelection}
        itemComponent={props => (
          <SelectItem item={props.item}>{props.item.rawValue}</SelectItem>
        )}
      >
        <SelectTrigger aria-label="Metric">
          <SelectValue<string>>{state => state.selectedOption()}</SelectValue>
        </SelectTrigger>
        <SelectContent>{props.content}</SelectContent>
      </Select>
      <button type="button">Next control</button>
    </>
  )
}

it("keeps decorative icons out of keyboard navigation", async () => {
  const user = userEvent.setup()
  render(() => <SelectFixture />)
  await user.tab()
  expect(screen.getByRole("button", { name: /^Metric / })).toHaveFocus()
  await user.tab()
  expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus()
})

it("renders and selects default collection items", async () => {
  const user = userEvent.setup()
  render(() => <SelectFixture />)
  await user.click(screen.getByRole("button", { name: /^Metric / }))
  await user.click(screen.getByRole("option", { name: "Second" }))
  expect(screen.getByRole("button", { name: /^Metric / })).toHaveTextContent(
    "Second",
  )
})

it("renders explicitly supplied content through the virtualized listbox renderer", async () => {
  const user = userEvent.setup()
  render(() => (
    <SelectFixture virtualized content={<span>Custom list content</span>} />
  ))
  await user.click(screen.getByRole("button", { name: /^Metric / }))
  expect(screen.getByText("Custom list content")).toBeInTheDocument()
})
