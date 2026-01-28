# Roadmap

> **Purpose**: This document describes the **practical path** from where we are today to the north star in [SPEC.md](./SPEC.md). Each milestone adds value without breaking what works. The prototype page (`/prototype`) embodies the target UX; milestones progressively wire it to real data and actions.

## Starting Point

What we already have:

- **Data**: Historical OHLCV and funding rate data accumulated via collection scripts (more than what's available from Hyperliquid API directly)
- **/portfolio page**: Production tool for managing Hyperliquid perps positions—already useful, already in daily use
- **Prototype** (`/prototype`): Interactive UI mockup with screener, staged trades, keyboard navigation, inline editing, multi-metric charts. Uses mock data, no real actions—but it's code, not Figma, so wiring it up is straightforward.

The prototype is the **design source of truth**, owned by humans. It will continue to evolve through human iteration. AI contributors wire it up to real data and actions but do not change the design without explicit request/approval.

**Core constraint**: The /portfolio page must remain functional throughout. Evolution is gradual—users never lose functionality, only gain it.

## Milestone 1: Converge to Prototype Layout

Replace /portfolio with the prototype layout. Move it to / (portfolio is the main thing, other data supports portfolio decisions).

- Adopt prototype layout with all panels
- Wire up panels that already have real data/actions (positions, execution)
- Show "Coming soon..." for panels not yet functional
- No more maintaining two diverging systems

## Milestone 2: Wire Up Analytics

Connect prototype analytics panels to real data:

- Sharpe/Beta/Momentum from accumulated historical data
- Factor exposure summary
- Multi-metric charts with real OHLCV

## Milestone 3: Staged Trades with Real Execution

Wire up the staged trades workflow:

- Preview changes with real position data
- Execute trades on Hyperliquid
- Global leverage with real calculations

## Milestone 4: Screener with Real Data

Wire up the screener panel:

- Rank assets by real factor loadings
- Click-to-add to staged portfolio

## Milestone 5: Hyperliquid Spot

Extend to spot positions:

- Combined perp/spot portfolio view
- Unified notional and weight calculations

## Milestone 6: Risk Analytics

Wire up risk panels:

- VaR/CVaR calculations
- Correlation matrix
- Stress testing

## Milestone 7: TradFi Integration

Add TradFi factor exposure:

- SPY/TLT beta calculations
- Yahoo Finance data adapter

## Milestone 8: Options (Derive)

Extend to options:

- Greeks engine
- Options pricing
- Vol surface
- Aggregated Greeks by underlying

## Milestone 9: Additional Venues

Extend to other DeFi venues:

- Solana DEX spot
- st0x (tokenized equities)
- Pendle (yield trading)
