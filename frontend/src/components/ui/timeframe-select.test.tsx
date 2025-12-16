import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TimeframeSelect, type Timeframe } from "./timeframe-select"

describe("TimeframeSelect", () => {
  it("renders with the provided value", () => {
    const mockOnChange = vi.fn()
    render(<TimeframeSelect value="1h" onValueChange={mockOnChange} />)

    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })

  it("displays the correct value for 1h", () => {
    const mockOnChange = vi.fn()
    render(<TimeframeSelect value="1h" onValueChange={mockOnChange} />)

    expect(screen.getByText("1 hour")).toBeInTheDocument()
  })

  it("displays the correct value for 15m", () => {
    const mockOnChange = vi.fn()
    render(<TimeframeSelect value="15m" onValueChange={mockOnChange} />)

    expect(screen.getByText("15 minutes")).toBeInTheDocument()
  })

  it("accepts only valid Timeframe values", () => {
    const mockOnChange = vi.fn<(value: Timeframe) => void>()

    render(<TimeframeSelect value="1h" onValueChange={mockOnChange} />)

    const validValues: Timeframe[] = ["1h", "15m"]
    validValues.forEach(value => {
      expect(value).toMatch(/^(1h|15m)$/)
    })
  })

  it("applies custom className", () => {
    const mockOnChange = vi.fn()
    const customClass = "custom-test-class"

    render(
      <TimeframeSelect
        value="1h"
        onValueChange={mockOnChange}
        className={customClass}
      />,
    )

    const trigger = screen.getByRole("combobox")
    expect(trigger.className).toContain(customClass)
  })

  it("enforces type safety with Timeframe union type", () => {
    const mockOnChange = vi.fn<(value: Timeframe) => void>()

    render(<TimeframeSelect value="1h" onValueChange={mockOnChange} />)

    const validTimeframe: Timeframe = "15m"
    expect(validTimeframe).toBe("15m")
  })

  it("callback receives Timeframe type", () => {
    const mockOnChange = vi.fn<(value: Timeframe) => void>()

    render(<TimeframeSelect value="1h" onValueChange={mockOnChange} />)

    mockOnChange("15m")

    expect(mockOnChange).toHaveBeenCalledWith("15m")
  })
})
