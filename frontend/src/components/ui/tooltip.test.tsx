import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, expect, it } from "vitest"

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

afterEach(cleanup)

it("forwards the content element, attributes, children, and reactive classes", () => {
  const [className, setClassName] = createSignal("initial-class")
  render(() => (
    <Tooltip open>
      <TooltipTrigger>Details</TooltipTrigger>
      <TooltipContent as="section" id="description" class={className()}>
        Position details
      </TooltipContent>
    </Tooltip>
  ))

  const content = screen.getByRole("tooltip")
  expect(content.tagName).toBe("SECTION")
  expect(content).toHaveAttribute("id", "description")
  expect(content).toHaveTextContent("Position details")
  expect(content).toHaveClass("initial-class", "bg-primary")
  setClassName("updated-class")
  expect(content).toHaveClass("updated-class", "bg-primary")
  expect(content).not.toHaveClass("initial-class")
})
