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

async def run_pipeline(start_date: datetime) -> datetime:
    """Run the trading pipeline and return the latest timestamp"""
    try:
        # Initialize components
        timeframe: Timeframe = "1h"
        config = TIMEFRAME_CONFIGS[timeframe]
        
        dataloader = HyperliquidDataLoader(
            start_date=start_date,
            timeframe=timeframe,
            config=config,
            spark=spark,
            min_leverage=1
        )
            
        strategy = Strategy(
            timeframe=timeframe,
            config=config,
            leverage=1.0,
            starting_equity=10000.0,
            min_position_size=100.0,
        )

        # Get candles data
        candles_df = await dataloader.get_candles_df()
        
        # Generate analysis
        analysis_df = strategy.generate_analysis(candles_df)
        
        # Convert to pandas and save
        analysis_pd = analysis_df.toPandas()
        analysis_pd.to_csv('data/analysis_df.csv', index=False)
        
        # Get the latest timestamp
        latest_timestamp = analysis_pd['timestamp'].max()
        
        # Reinitialize cache with new data
        cache.initialize('data/analysis_df.csv')
        
        return latest_timestamp
        
    except Exception as e:
        print(f"Error in pipeline: {str(e)}")
        raise

@app.get("/api/date-range")
async def get_date_range():
    """Get the available date range from the data"""
    try:
        return cache.get_date_range()
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

    if start_date > end_date:
        raise HTTPException(status_code=400, detail="Start date must be before end date")

    if start_date < cache.min_date or end_date > cache.max_date:
        raise HTTPException(
            status_code=400,
            detail=f"Date range must be between {cache.min_date.isoformat()} and {cache.max_date.isoformat()}"
        )

    try:
        df = cache.get_data(start_date, end_date)
        
        # If DataFrame is empty, return empty list
        if df.empty:
            return []
            
        # Group by both date and ticker to get the last record for each ticker each day
        df['date'] = df['timestamp'].dt.date
        df = df.sort_values('timestamp').groupby(['date', 'ticker']).last().reset_index()
        df = df.drop('date', axis=1)  # Remove the temporary date column
        
        # Replace both numpy NaN and pandas NA with None
        df = df.replace({np.nan: None, pd.NA: None})
        
        # Convert DataFrame to list of dictionaries
        return df.to_dict(orient='records')
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/reload_data")
async def reload_data():
    """Reload data using backtest.py script"""
    try:
        # Set JAVA_HOME and run backtest.py
        env = os.environ.copy()
        env['JAVA_HOME'] = '/usr/lib/jvm/java-11-openjdk-amd64'
        
        print("Running backtest.py")

        result = subprocess.run(
            ['python3', 'backtest.py'],
            env=env,
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Error running backtest.py: {result.stderr}"
            )
            
        # Reinitialize cache with new data
        cache.initialize('data/analysis_df.csv')
        
        return {
            "message": "Data reloaded successfully using backtest.py",
            "output": result.stdout
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000) 