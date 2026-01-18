import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { LeverageControl } from "./LeverageControl"

describe("LeverageControl", () => {
  it("displays the effective leverage value", () => {
    render(
      <LeverageControl
        leverage={1.0}
        effectiveLeverage={0.8}
        onLeverageChange={() => {}}
      />,
    )

    expect(screen.getByText("0.80x")).toBeInTheDocument()
  })

  it("calls onLeverageChange when slider is moved", () => {
    const handleChange = vi.fn()
    render(
      <LeverageControl
        leverage={1.0}
        effectiveLeverage={0.8}
        onLeverageChange={handleChange}
      />,
    )

    const slider = screen.getByRole("slider")
    fireEvent.change(slider, { target: { value: "2.0" } })

    expect(handleChange).toHaveBeenCalledWith(2.0)
  })

  it("slider reflects current leverage value", () => {
    render(
      <LeverageControl
        leverage={2.5}
        effectiveLeverage={2.0}
        onLeverageChange={() => {}}
      />,
    )

    const slider = screen.getByRole("slider")
    expect(slider).toHaveValue("2.5")
  })
})
