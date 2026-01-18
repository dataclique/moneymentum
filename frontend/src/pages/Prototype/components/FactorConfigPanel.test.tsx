import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FactorConfigPanel } from "./FactorConfigPanel"
import type { FactorExposure } from "../mockData"

const mockFactors: FactorExposure[] = [
  { name: "β to BTC", value: 0.85, color: "hsl(var(--chart-1))" },
  { name: "β to SPY", value: 0.42, color: "hsl(var(--chart-2))" },
  { name: "Momentum", value: 0.28, color: "hsl(var(--chart-3))" },
]

describe("FactorConfigPanel", () => {
  const defaultProps = {
    factors: mockFactors,
    onClose: vi.fn(),
    onSave: vi.fn(),
  }

  it("displays existing factors", () => {
    render(<FactorConfigPanel {...defaultProps} />)

    expect(screen.getByText("β to BTC")).toBeInTheDocument()
    expect(screen.getByText("β to SPY")).toBeInTheDocument()
    expect(screen.getByText("Momentum")).toBeInTheDocument()
  })

  it("shows available benchmarks to add", () => {
    render(<FactorConfigPanel {...defaultProps} />)

    expect(screen.getByText("ETH")).toBeInTheDocument()
    expect(screen.getByText("QQQ")).toBeInTheDocument()
    expect(screen.queryByText("BTC")).not.toBeInTheDocument() // Already in factors
    expect(screen.queryByText("SPY")).not.toBeInTheDocument() // Already in factors
  })

  it("calls onClose when Cancel clicked", () => {
    const onClose = vi.fn()
    render(<FactorConfigPanel {...defaultProps} onClose={onClose} />)

    fireEvent.click(screen.getByText("Cancel"))
    expect(onClose).toHaveBeenCalled()
  })

  it("calls onSave with current factors when Save clicked", () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(
      <FactorConfigPanel {...defaultProps} onSave={onSave} onClose={onClose} />,
    )

    fireEvent.click(screen.getByText("Save"))
    expect(onSave).toHaveBeenCalledWith(mockFactors)
    expect(onClose).toHaveBeenCalled()
  })

  it("removes factor when X clicked", () => {
    const onSave = vi.fn()
    render(<FactorConfigPanel {...defaultProps} onSave={onSave} />)

    // Find the remove buttons (X icons) in the factor list
    const factorRow = screen.getByText("β to BTC").closest("div")
    const removeButton = factorRow?.querySelector("button")
    if (removeButton) {
      fireEvent.click(removeButton)
    }

    // After removing, BTC should now be available to add
    expect(screen.queryByText("β to BTC")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /BTC/ })).toBeInTheDocument()
  })

  it("adds new factor when benchmark clicked", () => {
    render(<FactorConfigPanel {...defaultProps} />)

    fireEvent.click(screen.getByRole("button", { name: /ETH/ }))

    expect(screen.getByText("β to ETH")).toBeInTheDocument()
  })
})
