import React, { useEffect, useState } from 'react';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { Box, Container, Typography, Stack, TextField } from '@mui/material';
import { TradingData } from '../types/trading';
import { subDays } from 'date-fns';

const columns: GridColDef[] = [
  { field: 'ticker', headerName: 'Ticker', width: 100 },
  { field: 'close', headerName: 'Close', width: 100, type: 'number' },
  { field: 'volume', headerName: 'Volume', width: 120, type: 'number' },
  { field: 'sharpe', headerName: 'Sharpe Ratio', width: 120, type: 'number' },
  { field: 'annualized_volatility', headerName: 'Annualized Volatility', width: 180, type: 'number' },
  { field: 'sortino', headerName: 'Sortino Ratio', width: 120, type: 'number' },
  { field: 'beta', headerName: 'Beta', width: 100, type: 'number' },
  { field: 'mean_return', headerName: 'Mean Return', width: 120, type: 'number' },
  { field: 'stddev', headerName: 'Standard Deviation', width: 150, type: 'number' },
];

const API_URL = 'http://localhost:8000';

const Dashboard: React.FC = () => {
  const [data, setData] = useState<TradingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minDate, setMinDate] = useState<Date | null>(null);
  const [maxDate, setMaxDate] = useState<Date | null>(null);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  useEffect(() => {
    const fetchDateRange = async () => {
      try {
        const response = await fetch(`${API_URL}/api/date-range`);
        const { min_date, max_date } = await response.json();
        console.log(min_date, max_date);
        const min = new Date(min_date);
        const max = new Date(max_date);
        setMinDate(min);
        setMaxDate(max);
        
        // Set default range to last day
        const lastDay = subDays(max, 1);
        setStartDate(lastDay.toISOString().split('T')[0]);
        setEndDate(max.toISOString().split('T')[0]);
      } catch (err) {
        setError('Failed to load date range');
        console.error(err);
      }
    };

    fetchDateRange();
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      if (!startDate || !endDate) return;

      try {
        setLoading(true);
        const response = await fetch(`${API_URL}/api/data`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            start_date: new Date(startDate).toISOString(),
            end_date: new Date(endDate).toISOString(),
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to fetch data');
        }

        const csvData = await response.json();
        const dataWithIds = csvData.map((row: any, index: number) => ({
          ...row,
          id: `${row.ticker}-${row.timestamp}-${index}`,
        }));
        setData(dataWithIds);
      } catch (err) {
        setError('Failed to load trading data');
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [startDate, endDate]);

  const handleStartDateChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newDate = event.target.value;
    if (newDate && endDate && newDate > endDate) {
      setEndDate(newDate);
    }
    setStartDate(newDate);
  };

  const handleEndDateChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newDate = event.target.value;
    if (newDate && startDate && newDate < startDate) {
      setStartDate(newDate);
    }
    setEndDate(newDate);
  };

  if (error) {
    return (
      <Container>
        <Typography color="error">{error}</Typography>
      </Container>
    );
  }

  return (
    <Container maxWidth="xl">
      <Box sx={{ height: '100vh', width: '100%', mt: 4 }}>
        <Typography variant="h4" gutterBottom>
          Trading Dashboard
        </Typography>
        
        <Stack direction="row" spacing={2} sx={{ mb: 4 }}>
          <TextField
            label="Start Date"
            type="date"
            value={startDate}
            onChange={handleStartDateChange}
            InputLabelProps={{ shrink: true }}
            inputProps={{
              min: minDate?.toISOString().split('T')[0],
              max: endDate || maxDate?.toISOString().split('T')[0],
            }}
          />
          <TextField
            label="End Date"
            type="date"
            value={endDate}
            onChange={handleEndDateChange}
            InputLabelProps={{ shrink: true }}
            inputProps={{
              min: startDate || minDate?.toISOString().split('T')[0],
              max: maxDate?.toISOString().split('T')[0],
            }}
          />
        </Stack>

        <DataGrid
          rows={data}
          columns={columns}
          loading={loading}
          initialState={{
            sorting: {
              sortModel: [{ field: 'sharpe', sort: 'desc' }],
            },
          }}
          pageSizeOptions={[10, 25, 50, 100]}
          disableRowSelectionOnClick
          autoHeight
        />
      </Box>
    </Container>
  );
};

export default Dashboard; 