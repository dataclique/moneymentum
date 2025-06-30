import logging
import os
import subprocess
import sys
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from yang.util import get_spark

# TODO: clear bullshit of cache
# TODO: return some logs of reloading data
# TODO: default show data for last date in df
# TODO: fix EXPORT_JAVA bullshit
# TODO: try to deploy

app = FastAPI()

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],  # React app URLs
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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


# Initialize cache
cache = DataCache()
cache.initialize("data/analysis_df.csv")


class DateRange(BaseModel):
    start_date: str
    end_date: str


# Global variable to track the current process
# Use a mutable container to avoid global statement
process_holder: dict[str, subprocess.Popen[str] | None] = {"current": None}


@app.get("/api/date-range")
async def get_date_range() -> dict[str, Any]:
    """Get the available date range from the data"""
    try:
        date_range = cache.get_date_range()
        logger.info("%s", date_range)

        last_timestamp = None
        if cache.df is not None and not cache.df.empty:
            last_timestamp = cache.df["timestamp"].max().isoformat()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return {**date_range, "last_timestamp": last_timestamp}


@app.post("/api/data")
async def get_data(date_range: DateRange) -> dict[str, Any]:
    """Get data for the specified date range"""
    try:
        start_date = datetime.fromisoformat(date_range.start_date)
        end_date = datetime.fromisoformat(date_range.end_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format") from None

    if start_date >= end_date:
        raise HTTPException(status_code=400, detail="Start date must be before end date")

    try:
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
                        f"No records found for date range: {start_date.date()} to "
                        f"{end_date.date()}"
                    ),
                }
            return {"data": [], "message": "No data available in the system"}

        # Group by both date and ticker to get the last record for each ticker each day
        data_frame["date"] = data_frame["timestamp"].dt.date
        data_frame = (
            data_frame.sort_values("timestamp").groupby(["date", "ticker"]).last().reset_index()
        )
        data_frame = data_frame.drop("date", axis=1)  # Remove the temporary date column

        # Replace both numpy NaN and pandas NA with None
        data_frame = data_frame.replace({np.nan: None, pd.NA: None})

        # Convert DataFrame to list of dictionaries
        return {"data": data_frame.to_dict(orient="records"), "message": None}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/api/reload_data/stream")
def reload_data_stream() -> StreamingResponse:
    """Stream logs while running backtest.py"""

    def run_script() -> Iterator[str]:
        env = os.environ.copy()
        yield "Running backtest.py...\n"
        python_path = sys.executable

        if not Path(python_path).exists():
            yield f"Error: Python executable not found at {python_path}\n"
            return

        logger.info("Attempting to run backtest.py using: %s", python_path)
        # Use shell=False and pass arguments as list to avoid shell injection
        process_holder["current"] = subprocess.Popen(  # noqa: S603
            [python_path, "backtest.py"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            proc = process_holder["current"]
            if proc is None or proc.stdout is None:
                yield "Error: No stdout available\n"
                return
            for line in iter(proc.stdout.readline, ""):
                if not line:
                    break
                logger.info("%s", line.rstrip())
                yield line
            proc.wait()
            if proc.returncode != 0:
                yield f"\nError: backtest.py exited with code {proc.returncode}\n"
            else:
                yield "\n✅ backtest.py finished successfully.\n"
            try:
                # Убедитесь, что 'cache' и 'pd' импортированы и доступны
                cache.initialize("data/analysis_df.csv", force=True)
                yield "✅ Cache reloaded.\n"
            except (ValueError, FileNotFoundError, pd.errors.EmptyDataError) as e:
                yield f"❌ Error reloading cache: {e}\n"
        finally:
            process_holder["current"] = None

    return StreamingResponse(run_script(), media_type="text/plain")


@app.post("/api/stop_reload")
async def stop_reload() -> dict[str, str]:
    """Stop the current reload process"""
    proc = process_holder["current"]
    if proc is None:
        raise HTTPException(status_code=400, detail="No process is currently running")
    try:
        proc.terminate()
        proc.wait(timeout=5)
        process_holder["current"] = None
    except subprocess.TimeoutExpired:
        if process_holder["current"] is not None:
            process_holder["current"].kill()
        process_holder["current"] = None
        return {"message": "Process force stopped"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error stopping process: {str(e)}") from e
    else:
        return {"message": "Process stopped successfully"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
