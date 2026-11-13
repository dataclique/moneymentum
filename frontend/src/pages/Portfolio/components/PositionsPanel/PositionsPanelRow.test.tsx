import { render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { createSignal } from "solid-js"

import type { OptionPortfolioPosition } from "../../hooks/portfolioRebalancer"
import { PositionsPanelRow } from "./PositionsPanelRow"

const portfolioPosition = () => ({
  symbol: "ETH/USDC:USDC",
  side: "buy" as const,
  kind: "perp" as const,
  venue: "hyperliquid" as const,
  leverage: 2,
  notional: 500,
})

const defaultRowMetrics = {
  signedFundingRate: null,
  beta: null,
  volatility: null,
  sharpe: null,
  sortino: null,
  momentum: null,
  carry: null,
}

describe("PositionsPanelRow", () => {
  it.each([
    {
      symbol: "ETH-20261225-2000-C",
      longHint: "Profits if underlying rises",
      shortHint: "Profits if underlying falls or stays flat",
    },
    {
      symbol: "ETH-20261225-2000-P",
      longHint: "Profits if underlying falls",
      shortHint: "Profits if underlying rises or stays flat",
    },
    {
      symbol: "ETH-20261225-2000-X",
      longHint: "Option payoff unavailable",
      shortHint: "Option payoff unavailable",
    },
  ])(
    "shows reactive option payoff hints for $symbol",
    async ({ symbol, longHint, shortHint }) => {
      const user = userEvent.setup()
      const [side, setSide] =
        createSignal<OptionPortfolioPosition["side"]>("buy")
      const position = (): OptionPortfolioPosition => ({
        kind: "option",
        venue: "derive",
        symbol,
        side: side(),
        notional: 500,
        contracts: 0,
        markPrice: 0,
        entryPrice: 0,
      })
      render(() => (
        <table>
          <tbody>
            <PositionsPanelRow
              symbol={symbol}
              position={position}
              status="unchanged"
              visibleMetricColumns={[]}
              rowMetrics={defaultRowMetrics}
              leverageLimitsIsLoading={false}
              isPrecise={false}
              fundingIsLoading={false}
              factorsIsLoading={false}
              onRemove={vi.fn()}
              onUndoRemove={vi.fn()}
              onSideChange={(_symbol, nextSide) => {
                setSide(nextSide)
              }}
              onLeverageChange={vi.fn()}
              onNotionalChange={vi.fn()}
              onWeightChange={vi.fn()}
              totalNotional={500}
              symbolsBelowMinimum={[]}
              symbolsDeltaBelowMinimum={[]}
              symbolDelta={0}
            />
          </tbody>
        </table>
      ))
      const sideButton = screen.getByRole("button", {
        name: `Switch ${symbol} side`,
      })
      expect(sideButton).toHaveTextContent("LONG")
      const hint = screen.getByText(longHint)
      expect(hint.closest("td")).toBe(sideButton.closest("td"))
      await user.click(sideButton)
      expect(sideButton).toHaveTextContent("SHORT")
      expect(hint).toHaveTextContent(shortHint)
      expect(screen.getByText(shortHint).closest("td")).toBe(
        sideButton.closest("td"),
      )
    },
  )

  it("replaces side, weight, and notional with a compact leverage editor", async () => {
    const user = userEvent.setup()

    render(() => (
      <table>
        <tbody>
          <PositionsPanelRow
            symbol="ETH/USDC:USDC"
            position={portfolioPosition}
            status="unchanged"
            visibleMetricColumns={["rate"]}
            rowMetrics={defaultRowMetrics}
            maxLeverage={5}
            leverageLimitsIsLoading={false}
            isPrecise={true}
            fundingIsLoading={false}
            factorsIsLoading={false}
            onRemove={vi.fn()}
            onUndoRemove={vi.fn()}
            onSideChange={vi.fn()}
            onLeverageChange={vi.fn()}
            onNotionalChange={vi.fn()}
            onWeightChange={vi.fn()}
            totalNotional={1000}
            symbolsBelowMinimum={[]}
            symbolsDeltaBelowMinimum={[]}
            symbolDelta={0}
          />
        </tbody>
      </table>
    ))

    expect(screen.queryByText(/Profits if underlying/)).not.toBeInTheDocument()
    const assetCell = screen.getByText("ETH").closest("td")
    if (assetCell === null) {
      throw new Error("asset cell not found")
    }
    expect(assetCell).not.toHaveAttribute("colspan")

    await user.click(screen.getByRole("button", { name: "2x" }))

    expect(assetCell).not.toHaveAttribute("colspan")
    expect(
      screen.queryByRole("button", { name: "Switch ETH side" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Remove ETH/USDC:USDC" }),
    ).not.toBeInTheDocument()
    const sliderCell = screen
      .getByLabelText("Leverage for ETH/USDC:USDC")
      .closest("td")
    if (sliderCell === null) {
      throw new Error("slider cell not found")
    }
    expect(sliderCell).toHaveAttribute("colspan", "3")

    await user.click(document.body)

    expect(assetCell).not.toHaveAttribute("colspan")
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Switch ETH side" }),
      ).toBeInTheDocument()
    })
  })

  it("uses numeric keyboard input while the leverage editor is open", async () => {
    const user = userEvent.setup()
    const onLeverageChange = vi.fn()

    render(() => (
      <table>
        <tbody>
          <PositionsPanelRow
            symbol="ETH/USDC:USDC"
            position={portfolioPosition}
            status="unchanged"
            visibleMetricColumns={["rate"]}
            rowMetrics={defaultRowMetrics}
            maxLeverage={40}
            leverageLimitsIsLoading={false}
            isPrecise={true}
            fundingIsLoading={false}
            factorsIsLoading={false}
            onRemove={vi.fn()}
            onUndoRemove={vi.fn()}
            onSideChange={vi.fn()}
            onLeverageChange={onLeverageChange}
            onNotionalChange={vi.fn()}
            onWeightChange={vi.fn()}
            totalNotional={1000}
            symbolsBelowMinimum={[]}
            symbolsDeltaBelowMinimum={[]}
            symbolDelta={0}
          />
        </tbody>
      </table>
    ))

    await user.click(screen.getByRole("button", { name: "2x" }))
    await user.keyboard("32")

    expect(onLeverageChange).toHaveBeenNthCalledWith(1, "ETH/USDC:USDC", 3)
    expect(onLeverageChange).toHaveBeenNthCalledWith(2, "ETH/USDC:USDC", 32)
  })

  it("ignores modified digit shortcuts while the leverage editor is open", async () => {
    const user = userEvent.setup()
    const onLeverageChange = vi.fn()

    render(() => (
      <table>
        <tbody>
          <PositionsPanelRow
            symbol="ETH/USDC:USDC"
            position={portfolioPosition}
            status="unchanged"
            visibleMetricColumns={["rate"]}
            rowMetrics={defaultRowMetrics}
            maxLeverage={40}
            leverageLimitsIsLoading={false}
            isPrecise={true}
            fundingIsLoading={false}
            factorsIsLoading={false}
            onRemove={vi.fn()}
            onUndoRemove={vi.fn()}
            onSideChange={vi.fn()}
            onLeverageChange={onLeverageChange}
            onNotionalChange={vi.fn()}
            onWeightChange={vi.fn()}
            totalNotional={1000}
            symbolsBelowMinimum={[]}
            symbolsDeltaBelowMinimum={[]}
            symbolDelta={0}
          />
        </tbody>
      </table>
    ))

    await user.click(screen.getByRole("button", { name: "2x" }))
    await user.keyboard("{Meta>}3{/Meta}")

    expect(onLeverageChange).not.toHaveBeenCalled()
  })

  it("closes the leverage editor on Escape", async () => {
    const user = userEvent.setup()

    render(() => (
      <table>
        <tbody>
          <PositionsPanelRow
            symbol="ETH/USDC:USDC"
            position={portfolioPosition}
            status="unchanged"
            visibleMetricColumns={["rate"]}
            rowMetrics={defaultRowMetrics}
            maxLeverage={5}
            leverageLimitsIsLoading={false}
            isPrecise={true}
            fundingIsLoading={false}
            factorsIsLoading={false}
            onRemove={vi.fn()}
            onUndoRemove={vi.fn()}
            onSideChange={vi.fn()}
            onLeverageChange={vi.fn()}
            onNotionalChange={vi.fn()}
            onWeightChange={vi.fn()}
            totalNotional={1000}
            symbolsBelowMinimum={[]}
            symbolsDeltaBelowMinimum={[]}
            symbolDelta={0}
          />
        </tbody>
      </table>
    ))

    const assetCell = screen.getByText("ETH").closest("td")
    if (assetCell === null) {
      throw new Error("asset cell not found")
    }

    await user.click(screen.getByRole("button", { name: "2x" }))

    const sliderCell = screen
      .getByLabelText("Leverage for ETH/USDC:USDC")
      .closest("td")
    if (sliderCell === null) {
      throw new Error("slider cell not found")
    }
    expect(sliderCell).toHaveAttribute("colspan", "3")

    await user.keyboard("{Escape}")

    expect(
      screen.getByRole("button", { name: "Switch ETH side" }),
    ).toBeInTheDocument()
    expect(assetCell).not.toHaveAttribute("colspan")
    expect(
      screen.queryByLabelText("Leverage for ETH/USDC:USDC"),
    ).not.toBeInTheDocument()
  })

  it("keeps the previous numeric keyboard input when the combined leverage is too high", async () => {
    const user = userEvent.setup()
    const onLeverageChange = vi.fn()

    render(() => (
      <table>
        <tbody>
          <PositionsPanelRow
            symbol="ETH/USDC:USDC"
            position={portfolioPosition}
            status="unchanged"
            visibleMetricColumns={["rate"]}
            rowMetrics={defaultRowMetrics}
            maxLeverage={5}
            leverageLimitsIsLoading={false}
            isPrecise={true}
            fundingIsLoading={false}
            factorsIsLoading={false}
            onRemove={vi.fn()}
            onUndoRemove={vi.fn()}
            onSideChange={vi.fn()}
            onLeverageChange={onLeverageChange}
            onNotionalChange={vi.fn()}
            onWeightChange={vi.fn()}
            totalNotional={1000}
            symbolsBelowMinimum={[]}
            symbolsDeltaBelowMinimum={[]}
            symbolDelta={0}
          />
        </tbody>
      </table>
    ))

    await user.click(screen.getByRole("button", { name: "2x" }))
    await user.keyboard("32")

    expect(onLeverageChange).toHaveBeenCalledOnce()
    expect(onLeverageChange).toHaveBeenLastCalledWith("ETH/USDC:USDC", 3)
  })
})
