import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, expect, it } from "vitest"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"

afterEach(cleanup)

it("forwards polymorphic elements, reactive classes, and tab interactions", async () => {
  const user = userEvent.setup()
  const [className, setClassName] = createSignal("initial-class")
  render(() => (
    <Tabs defaultValue="first">
      <TabsList as="nav" aria-label="Book sections" class={className()}>
        <TabsTrigger as="a" href="#first" value="first">
          First
        </TabsTrigger>
        <TabsTrigger value="second">Second</TabsTrigger>
      </TabsList>
      {/* Presence needs an explicit nonanimated style in Happy DOM. */}
      <TabsContent value="first" style={{ "animation-name": "none" }}>
        First content
      </TabsContent>
      <TabsContent
        as="section"
        value="second"
        style={{ "animation-name": "none" }}
      >
        Second content
      </TabsContent>
    </Tabs>
  ))

  const list = screen.getByRole("tablist", { name: "Book sections" })
  expect(list.tagName).toBe("NAV")
  expect(list).toHaveClass("initial-class", "inline-flex")
  expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute(
    "href",
    "#first",
  )
  setClassName("updated-class")
  expect(list).toHaveClass("updated-class", "inline-flex")
  expect(list).not.toHaveClass("initial-class")

  await user.click(screen.getByRole("tab", { name: "Second" }))
  await waitFor(() => {
    expect(screen.getByRole("tabpanel").tagName).toBe("SECTION")
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Second content")
  })
})
