from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import pandas as pd
import numpy as np
from typing import List, Optional
import uvicorn
import os

app = FastAPI()

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # React app URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
                raise

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
        mask = (self.df['timestamp'] >= start_date) & (self.df['timestamp'] <= end_date)
        return self.df[mask]

# Initialize cache
cache = DataCache()
cache.initialize('data/trading_data.csv')  # Update this path to your CSV file

class DateRange(BaseModel):
    start_date: str
    end_date: str

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
        
        # Replace both numpy NaN and pandas NA with None
        df = df.replace({np.nan: None, pd.NA: None})
        
        # Convert DataFrame to list of dictionaries
        return df.to_dict(orient='records')
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000) 