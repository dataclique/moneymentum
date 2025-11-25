import logging
import os
import subprocess
import sys
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Literal
from threading import Lock

import numpy as np
import pandas as pd
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backtest import PipelineRunMode
from yang.util import Timeframe, get_spark
from hyperliquid.main import Position, Trader
from hyperliquid.settings import UserSettings

app = FastAPI()

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],  # React app URLs
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class BacktestRequest(BaseModel):
    mode: PipelineRunMode = Field(
        default=PipelineRunMode.FULL_BACKTEST,
        description="The mode to run the backtest in: 'full_backtest' or 'analysis_only'",
    )


# Initialize Spark with proper configuration
spark = get_spark()

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# Cache for storing data and time range
class DataCache:
    def __init__(self) -> None:
        self.df: pd.DataFrame | None = None
        self.min_date: datetime | None = None
        self.max_date: datetime | None = None
        self.initialized = False

    def initialize(self, file_path: str, *, force: bool = False) -> None:
        if self.initialized and not force:
            return

        def _validate_date_range() -> None:
            if self.min_date is pd.NaT or self.max_date is pd.NaT:
                error_msg = "Invalid date range in data"
                raise ValueError(error_msg)

        try:
            # Get absolute path
            abs_path = Path(file_path).resolve()
            logger.info("Loading data from: %s", abs_path)

            # Check if file exists
            if not abs_path.exists():
                logger.warning(
                    "File %s does not exist. Initializing with empty DataFrame.", abs_path
                )
                self.df = pd.DataFrame(columns=["timestamp"])
                # Set a wide default date range (1 year ago to 1 year ahead)
                now = datetime.now(timezone.utc)
                self.min_date = now - timedelta(days=365)
                self.max_date = now + timedelta(days=365)
                self.initialized = True
                return

            # Read only timestamp column first to get date range
            self.df = pd.read_csv(abs_path, parse_dates=["timestamp"])

            # Ensure timestamp column is datetime
            self.df["timestamp"] = pd.to_datetime(self.df["timestamp"])

            # Get min and max dates
            self.min_date = self.df["timestamp"].min()
            self.max_date = self.df["timestamp"].max()

            _validate_date_range()

            self.initialized = True
            logger.info("Data loaded. Date range: %s to %s", self.min_date, self.max_date)
        except (ValueError, FileNotFoundError, pd.errors.EmptyDataError):
            logger.exception("Error initializing data")
            # Initialize with empty DataFrame on error
            self.df = pd.DataFrame(columns=["timestamp"])
            # Set a wide default date range (1 year ago to 1 year ahead)
            now = datetime.now(timezone.utc)
            self.min_date = now - timedelta(days=365)
            self.max_date = now + timedelta(days=365)
            self.initialized = True

    def get_date_range(self) -> dict[str, str]:
        if not self.initialized or self.min_date is None or self.max_date is None:
            raise HTTPException(status_code=500, detail="Data not initialized")
        return {"min_date": self.min_date.isoformat(), "max_date": self.max_date.isoformat()}

    def get_data(self, start_date: datetime, end_date: datetime) -> pd.DataFrame:
        if not self.initialized or self.df is None:
            raise HTTPException(status_code=500, detail="Data not initialized")
        if self.df.empty:
            return pd.DataFrame(columns=["timestamp"])

        # Convert input dates to UTC if they're naive
        if start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)
        if end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)

        mask = (self.df["timestamp"] >= start_date) & (self.df["timestamp"] <= end_date)
        return self.df[mask]


# Initialize cache for each timeframe
TIME_FRAMES: list[Timeframe] = ["1h", "15m"]
caches: dict[Timeframe, DataCache] = {tf: DataCache() for tf in TIME_FRAMES}
for tf in TIME_FRAMES:
    caches[tf].initialize(f"data/analysis_df_{tf}.csv")


class DateRange(BaseModel):
    start_date: str
    end_date: str


class PositionPayload(BaseModel):
    symbol: str
    percentage: float
    side: Literal["buy", "sell"]


class OpenPositionsPayload(BaseModel):
    budget: float
    positions: list[PositionPayload]


class OrderStatusResponse(BaseModel):
    symbol: str
    side: str
    percentage: float
    status: str
    message: str | None = None


_trader_lock = Lock()
_trader_instance: Trader | None = None


def get_trader() -> Trader:
    global _trader_instance
    with _trader_lock:
        if _trader_instance is None:
            settings = UserSettings()
            _trader_instance = Trader(settings)
        return _trader_instance


@app.get("/api/date-range")
async def get_date_range(
    timeframe: Annotated[Timeframe, Query(enum=TIME_FRAMES)] = "1h",
) -> dict[str, Any]:
    """Get the available date range from the data"""
    try:
        cache = caches[timeframe]
        date_range = cache.get_date_range()
        logger.info("%s", date_range)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return {"min_date": date_range["min_date"], "max_date": date_range["max_date"]}


@app.get("/api/hyperliquid/tickers")
async def get_perp_tickers() -> dict[str, Any]:
    try:
        trader = get_trader()
        return {"data": trader.list_perp_tickers()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/hyperliquid/balance")
async def get_hyperliquid_balance() -> dict[str, Any]:
    try:
        trader = get_trader()
        return {"perp_usdc_balance": trader.get_available_budget()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/hyperliquid/open_positions")
async def open_hyperliquid_positions(payload: OpenPositionsPayload) -> dict[str, Any]:
    if payload.budget <= 0:
        raise HTTPException(status_code=400, detail="Budget must be positive")
    if not payload.positions:
        raise HTTPException(status_code=400, detail="At least one position is required")

    try:
        trader = get_trader()
        parsed_positions = [
            Position(symbol=item.symbol, percentage=item.percentage, side=item.side)
            for item in payload.positions
        ]
        order_results = trader.open_positions(parsed_positions, payload.budget)
        allowed_fields = {"symbol", "side", "percentage", "status", "message"}
        response = [
            OrderStatusResponse(
                **{field: result.get(field) for field in allowed_fields}  # type: ignore[arg-type]
            )
            for result in order_results
        ]
        return {"orders": [resp.model_dump() for resp in response]}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/data")
async def get_data(
    date_range: DateRange,
    timeframe: Annotated[Timeframe, Query(enum=TIME_FRAMES)] = "1h",
) -> dict[str, Any]:
    """Get data for the specified date range"""
    try:
        logger.info(
            "Fetching data for start: %s, end: %s", date_range.start_date, date_range.end_date
        )
        # Accept both Z and non-Z ISO formats
        start_str = date_range.start_date.replace("Z", "+00:00")
        end_str = date_range.end_date.replace("Z", "+00:00")
        start_date = datetime.fromisoformat(start_str)
        end_date = datetime.fromisoformat(end_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format") from None

    if start_date >= end_date:
        raise HTTPException(status_code=400, detail="Start date must be before end date")

    try:
        cache = caches[timeframe]
        data_frame = cache.get_data(start_date, end_date)

        # If DataFrame is empty, check if it's because of date range
        if data_frame.empty:
            # Get the actual date range from the data
            if cache.df is not None and not cache.df.empty:
                min_timestamp = cache.df["timestamp"].min()
                max_timestamp = cache.df["timestamp"].max()

                # Check if the requested range is completely outside our data
                if end_date < min_timestamp:
                    return {
                        "data": [],
                        "message": (
                            f"No records found for date range: {start_date.date()} to "
                            f"{end_date.date()} (earliest record is from {min_timestamp.date()})"
                        ),
                    }
                if start_date > max_timestamp:
                    return {
                        "data": [],
                        "message": (
                            f"No records found for date range: {start_date.date()} to "
                            f"{end_date.date()} (latest record is from {max_timestamp.date()})"
                        ),
                    }
                # This case shouldn't happen if get_data is working correctly
                return {
                    "data": [],
                    "message": (
                        f"No records found for date range: {start_date.date()} to {end_date.date()}"
                    ),
                }
            return {"data": [], "message": "No data available in the system"}

        # Sort data by ticker and timestamp for consistent order
        data_frame = data_frame.sort_values(["ticker", "timestamp"])

        # Replace both numpy NaN and pandas NA with None
        data_frame = data_frame.replace({np.nan: None, pd.NA: None})

        # Convert DataFrame to list of dictionaries
        return {"data": data_frame.to_dict(orient="records"), "message": None}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/api/token/{ticker}")
async def get_token_data(
    ticker: str,
    timeframe: Annotated[Timeframe, Query(enum=TIME_FRAMES)] = "1h",
) -> dict[str, Any]:
    """Get all data for a specific ticker"""
    cache = caches[timeframe]
    if not cache.initialized or cache.df is None:
        raise HTTPException(status_code=500, detail="Data not initialized")
    cached_data = cache.df
    if cached_data.empty:
        return {"data": [], "message": "No data available in the system"}
    filtered = cached_data[cached_data["ticker"] == ticker]
    if filtered.empty:
        return {"data": [], "message": f"No data found for ticker: {ticker}"}
    # Replace both numpy NaN and pandas NA with None
    filtered = filtered.replace({np.nan: None, pd.NA: None})
    return {"data": filtered.to_dict(orient="records"), "message": None}


def _run_backtest_script(mode: PipelineRunMode) -> Iterator[str]:
    """Helper function to run backtest.py and stream logs."""
    env = os.environ.copy()
    if "JAVA_HOME" not in env:
        yield "Warning: JAVA_HOME not set. Spark might fail.\n"
    if "LD_LIBRARY_PATH" not in env:
        yield "Warning: LD_LIBRARY_PATH not set. Spark might fail.\n"

    python_path = sys.executable

    if not Path(python_path).exists():
        yield f"Error: Python executable not found at {python_path}\n"
        return

    command = [python_path, "backtest.py", "--mode", mode.value]
    yield f"Running command: {' '.join(command)}\n"
    logger.info("Attempting to run backtest.py using: %s", python_path)
    logger.info("Subprocess environment includes JAVA_HOME: %s", env.get("JAVA_HOME"))
    logger.info("Subprocess environment includes LD_LIBRARY_PATH: %s", env.get("LD_LIBRARY_PATH"))

    try:
        process = subprocess.Popen(  # noqa: S603
            command,  # noqa: S603
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,  # Line-buffered
            universal_newlines=True,  # Ensures text mode
        )

        # Stream output
        if process.stdout:
            for line in iter(process.stdout.readline, ""):
                logger.info(line.strip())
                yield line
            process.stdout.close()

        # Wait for the process to complete
        return_code = process.wait()

        if return_code != 0:
            yield f"\nError: backtest.py exited with code {return_code}\n"
        else:
            yield "\n✅ backtest.py finished successfully.\n"

        # Reload cache after script execution
        try:
            for tf in TIME_FRAMES:
                caches[tf].initialize(f"data/analysis_df_{tf}.csv", force=True)
            yield "✅ Caches reloaded.\n"
        except (ValueError, FileNotFoundError, pd.errors.EmptyDataError) as e:
            yield f"❌ Error reloading caches: {e}\n"

    except (subprocess.SubprocessError, OSError) as e:
        yield f"An unexpected error occurred: {e}\n"


@app.post("/api/reload_data/stream")
def reload_data_stream(params: BacktestRequest) -> StreamingResponse:
    """Stream logs while running backtest.py"""
    return StreamingResponse(_run_backtest_script(params.mode), media_type="text/plain")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
