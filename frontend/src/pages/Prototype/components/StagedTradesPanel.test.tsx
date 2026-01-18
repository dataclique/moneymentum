import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { StagedTradesPanel } from "./StagedTradesPanel"
import type { StagedTrade } from "../mockData"

const mockTrades: StagedTrade[] = [
  { id: "1", symbol: "BTC", side: "buy", notional: 1000, leverage: 3 },
  { id: "2", symbol: "ETH", side: "sell", notional: 500, leverage: 2 },
]

describe("StagedTradesPanel", () => {
  const defaultProps = {
    stagedTrades: [] as StagedTrade[],
    leverage: 1.0,
    effectiveLeverage: 0.8,
    onLeverageChange: vi.fn(),
    onRemoveTrade: vi.fn(),
    onClearAll: vi.fn(),
    onExecute: vi.fn(),
  }

  it("shows empty state when no trades staged", () => {
    render(<StagedTradesPanel {...defaultProps} />)

    expect(screen.getByText(/No pending trades/)).toBeInTheDocument()
  })

  it("renders leverage control", () => {
    render(<StagedTradesPanel {...defaultProps} />)

    expect(screen.getByText("Leverage")).toBeInTheDocument()
    expect(screen.getByRole("slider")).toBeInTheDocument()
  })

  it("displays staged trades", () => {
    render(<StagedTradesPanel {...defaultProps} stagedTrades={mockTrades} />)

    expect(screen.getByText("BTC")).toBeInTheDocument()
    expect(screen.getByText("ETH")).toBeInTheDocument()
    expect(screen.getByText("BUY")).toBeInTheDocument()
    expect(screen.getByText("SELL")).toBeInTheDocument()
  })

  it("shows Clear all button when trades exist", () => {
    render(<StagedTradesPanel {...defaultProps} stagedTrades={mockTrades} />)

    expect(screen.getByText("Clear all")).toBeInTheDocument()
  })

  it("calls onClearAll when Clear all clicked", () => {
    const onClearAll = vi.fn()
    render(
      <StagedTradesPanel
        {...defaultProps}
        stagedTrades={mockTrades}
        onClearAll={onClearAll}
      />,
    )

    fireEvent.click(screen.getByText("Clear all"))
    expect(onClearAll).toHaveBeenCalled()
  })

  it("calls onRemoveTrade when X clicked on a trade", () => {
    const onRemoveTrade = vi.fn()
    render(
      <StagedTradesPanel
        {...defaultProps}
        stagedTrades={mockTrades}
        onRemoveTrade={onRemoveTrade}
      />,
    )

    const removeButtons = screen.getAllByRole("button", { name: "" })
    // First remove button (X icons don't have accessible names by default)
    const xButtons = removeButtons.filter(
      btn => btn.querySelector("svg.lucide-x") !== null,
    )
    fireEvent.click(xButtons[0])

    expect(onRemoveTrade).toHaveBeenCalledWith("1")
  })

  it("calls onExecute when Execute button clicked", () => {
    const onExecute = vi.fn()
    render(
      <StagedTradesPanel
        {...defaultProps}
        stagedTrades={mockTrades}
        onExecute={onExecute}
      />,
    )

    fireEvent.click(screen.getByText(/Execute 2 trades/))
    expect(onExecute).toHaveBeenCalled()
  })

  it("shows singular 'trade' when only one trade staged", () => {
    render(
      <StagedTradesPanel {...defaultProps} stagedTrades={[mockTrades[0]]} />,
    )

    expect(screen.getByText(/Execute 1 trade$/)).toBeInTheDocument()
  })
})
