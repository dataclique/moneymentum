# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Common Development Commands

### Python Backend

- **Run pipeline**: `python pipeline.py`
- **Lint Python code**: `ruff check .`
- **Format Python code**: `ruff format .`
- **Run tests**: `pytest`
- **Type checking**: `mypy yang/` (if enabled in flake.nix)
- **Pre-commit checks**: Before completing a task `pre-commit run -a` command
  has to be run and pass. For formatting failures, just run it twice and on the
  second run formatters should pass unless the syntax is malformed

### Frontend (React + Vite)

- **Development server**: `cd frontend && npm run dev`
- **Build frontend**: `cd frontend && npm run build`
- **Lint frontend**: `cd frontend && npm run lint`
- **Preview build**: `cd frontend && npm run preview`
- **Serve production build**: `cd frontend && npm run serve:spa`

### Environment Setup

- **Nix + Direnv**: Run `direnv allow` to activate the development environment
- **Install Python dependencies**: Dependencies are managed through Nix and
  requirements.txt
- **Install frontend dependencies**: `cd frontend && npm install`

## Architecture Overview

### Core Components

**Yang Trading System**: The main Python package (`yang/`) containing:

- `chronos.py`: Time series analysis engine using PySpark for calculating
  returns, volatility, autocorrelation, SMA, z-scores, beta, Sharpe ratios, and
  other financial metrics
- `strat.py`: Trading strategy implementation that orchestrates the Chronos
  analysis pipeline
- `exe.py`: Execution engine for trade execution and portfolio management
- `util.py`: Utilities for Spark session management, logging, and timeframe
  configurations

**Data Loading**: Hyperliquid exchange data integration
(`yang/dataloader/hyperliquid/`)

- OHLCV data fetching
- Funding rates data
- Market information

**Frontend**: React + TypeScript application with:

- Token analysis page with interactive charts using LightweightCharts
- Data tables with sorting and filtering
- Dark/light theme support
- Responsive design with Tailwind CSS and Radix UI components

### Key Data Flow

1. `pipeline.py` orchestrates the entire trading pipeline
2. Data is loaded from Hyperliquid via the dataloader
3. Chronos engine performs time series analysis using PySpark
4. Strategy generates trading signals based on analysis
5. Execution engine manages portfolio and trades
6. Frontend displays analysis results and charts

### Technology Stack

- **Backend**: Python 3.11, PySpark, FastAPI, Pandas, CCXT
- **Frontend**: React 19, TypeScript, Vite, TailwindCSS, Radix UI,
  LightweightCharts
- **Development**: Nix + Direnv for reproducible environments
- **Code Quality**: Ruff for Python linting/formatting, ESLint for TypeScript

## Development Environment

This project uses Nix flakes with devenv for a reproducible development
environment. The flake.nix configures:

- Python 3.11 with virtual environment
- Node.js for frontend development
- Required system libraries (zlib, libffi, etc.)
- Pre-commit hooks for code quality (ruff, nixfmt)

## Testing

- Python tests are located in `tests/` directory
- Run with `pytest` command
- Test data available in `test_data/` directory

## Data Files

- `data/`: Production data files (funding_rate1h.csv, ohlcv15m.csv)
- `test_data/`: Test datasets for development and testing
- Pipeline logs are written to `pipeline.log`
