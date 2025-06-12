from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import pandas as pd
import numpy as np
from typing import List, Optional
import uvicorn
import os
import subprocess
from yang.dataloader.hyperliquid import HyperliquidDataLoader
from yang.strat import Strategy
from pyspark.sql import SparkSession
from yang.util import TIMEFRAME_CONFIGS, Timeframe, get_spark
import subprocess
from typing import Iterator
from fastapi.responses import StreamingResponse
import signal

# TODO: clear bullshit of cache
# TODO: return some logs of reloading data
# TODO: default show data for last date in df
# TODO: fix EXPORT_JAVA bullshit
# TODO: try to deploy

app = FastAPI()

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # React app URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Spark with proper configuration
spark = get_spark()

# Cache for storing data and time range
class DataCache:
    def __init__(self):
        self.df = None
        self.min_date = None
        self.max_date = None
        self.initialized = False

    def initialize(self, file_path: str):
        if not self.initialized:
            try:
                # Get absolute path
                abs_path = os.path.abspath(file_path)
                print(f"Loading data from: {abs_path}")
                
                # Check if file exists
                if not os.path.exists(abs_path):
                    print(f"File {abs_path} does not exist. Initializing with empty DataFrame.")
                    self.df = pd.DataFrame(columns=['timestamp'])
                    # Set a wide default date range (1 year ago to 1 year ahead)
                    now = datetime.now(timezone.utc)
                    self.min_date = now - timedelta(days=365)
                    self.max_date = now + timedelta(days=365)
                    self.initialized = True
                    return
                
                # Read only timestamp column first to get date range
                self.df = pd.read_csv(abs_path, parse_dates=['timestamp'])
                
                # Ensure timestamp column is datetime
                self.df['timestamp'] = pd.to_datetime(self.df['timestamp'])
                
                # Get min and max dates
                self.min_date = self.df['timestamp'].min()
                self.max_date = self.df['timestamp'].max()
                
                if self.min_date is pd.NaT or self.max_date is pd.NaT:
                    raise ValueError("Invalid date range in data")
                
                self.initialized = True
                print(f"Data loaded. Date range: {self.min_date} to {self.max_date}")
            except Exception as e:
                print(f"Error initializing data: {str(e)}")
                # Initialize with empty DataFrame on error
                self.df = pd.DataFrame(columns=['timestamp'])
                # Set a wide default date range (1 year ago to 1 year ahead)
                now = datetime.now(timezone.utc)
                self.min_date = now - timedelta(days=365)
                self.max_date = now + timedelta(days=365)
                self.initialized = True

    def get_date_range(self):
        if not self.initialized:
            raise HTTPException(status_code=500, detail="Data not initialized")
        return {
            "min_date": self.min_date.isoformat(),
            "max_date": self.max_date.isoformat()
        }

    def get_data(self, start_date: datetime, end_date: datetime) -> pd.DataFrame:
        if not self.initialized:
            raise HTTPException(status_code=500, detail="Data not initialized")
        if self.df.empty:
            return pd.DataFrame(columns=['timestamp'])
            
        # Convert input dates to UTC if they're naive
        if start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)
        if end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)
            
        mask = (self.df['timestamp'] >= start_date) & (self.df['timestamp'] <= end_date)
        return self.df[mask]

# Initialize cache
cache = DataCache()
cache.initialize('data/analysis_df.csv')  # Update this path to your CSV file

class DateRange(BaseModel):
    start_date: str
    end_date: str

@app.get("/api/date-range")
async def get_date_range():
    """Get the available date range from the data"""
    try:
        date_range = cache.get_date_range()
        # Get the last timestamp from the data
        if not cache.df.empty:
            last_timestamp = cache.df['timestamp'].max()
            return {
                **date_range,
                "last_timestamp": last_timestamp.isoformat()
            }
        return {
            **date_range,
            "last_timestamp": None
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/data")
async def get_data(date_range: DateRange):
    """Get data for the specified date range"""
    try:
        start_date = datetime.fromisoformat(date_range.start_date)
        end_date = datetime.fromisoformat(date_range.end_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    print(date_range)
    if start_date >= end_date:
        raise HTTPException(status_code=400, detail="Start date must be before end date")

    try:
        df = cache.get_data(start_date, end_date)
        
        # If DataFrame is empty, check if it's because of date range
        if df.empty:
            # Get the actual date range from the data
            if not cache.df.empty:
                min_timestamp = cache.df['timestamp'].min()
                max_timestamp = cache.df['timestamp'].max()
                
                # Check if the requested range is completely outside our data
                if end_date < min_timestamp:
                    return {
                        "data": [],
                        "message": f"No records found for date range: {start_date.date()} to {end_date.date()} (earliest record is from {min_timestamp.date()})"
                    }
                elif start_date > max_timestamp:
                    return {
                        "data": [],
                        "message": f"No records found for date range: {start_date.date()} to {end_date.date()} (latest record is from {max_timestamp.date()})"
                    }
                else:
                    # This case shouldn't happen if get_data is working correctly
                    return {
                        "data": [],
                        "message": f"No records found for date range: {start_date.date()} to {end_date.date()}"
                    }
            else:
                return {
                    "data": [],
                    "message": "No data available in the system"
                }
            
        # Group by both date and ticker to get the last record for each ticker each day
        df['date'] = df['timestamp'].dt.date
        df = df.sort_values('timestamp').groupby(['date', 'ticker']).last().reset_index()
        df = df.drop('date', axis=1)  # Remove the temporary date column
        
        # Replace both numpy NaN and pandas NA with None
        df = df.replace({np.nan: None, pd.NA: None})
        
        # Convert DataFrame to list of dictionaries
        return {
            "data": df.to_dict(orient='records'),
            "message": None
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Global variable to track the current process
current_process: subprocess.Popen[str] | None = None

@app.post("/api/reload_data/stream")
def reload_data_stream() -> StreamingResponse:
    """Stream logs while running backtest.py"""
    global current_process

    def run_script() -> Iterator[str]:
        global current_process
        env = os.environ.copy()
        yield "Running backtest.py...\n"

        current_process = subprocess.Popen(
            ["python3", "backtest.py"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )

        try:
            if current_process.stdout is None:
                yield "Error: No stdout available\n"
                return

            for line in iter(current_process.stdout.readline, ''):
                if not line:
                    break
                print(line, end='')
                yield line  # Send line by line to frontend

            current_process.wait()

            if current_process.returncode != 0:
                yield f"\nError: backtest.py exited with code {current_process.returncode}\n"
            else:
                yield "\n✅ backtest.py finished successfully.\n"

            # Optional: reload cache
            try:
                cache.initialize('data/analysis_df.csv')
                yield "✅ Cache reloaded.\n"
            except Exception as e:
                yield f"❌ Error reloading cache: {e}\n"
        finally:
            current_process = None

    return StreamingResponse(run_script(), media_type="text/plain")

@app.post("/api/stop_reload")
async def stop_reload():
    """Stop the current reload process"""
    global current_process
    if current_process is None:
        raise HTTPException(status_code=400, detail="No process is currently running")
    
    try:
        # Send SIGTERM only to the specific process
        current_process.terminate()
        # Wait for the process to terminate
        current_process.wait(timeout=5)
        current_process = None
        return {"message": "Process stopped successfully"}
    except subprocess.TimeoutExpired:
        # If process doesn't terminate gracefully, force kill it
        current_process.kill()
        current_process = None
        return {"message": "Process force stopped"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error stopping process: {str(e)}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000) 