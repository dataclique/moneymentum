import { useState, useEffect } from 'react';
import { columns, type TradingData } from "./components/ui/columns"
import { DataTable } from "./components/ui/data-table"

async function reloadData(): Promise<string> {
  const response = await fetch('http://localhost:8000/api/reload_data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
  }
  
  const data = await response.json();
  return data.message;
}

async function getData(startDate: string, endDate: string): Promise<TradingData[]> {
  try {
    // Convert dates to ISO format with time
    const startDateTime = new Date(startDate + 'T00:00:00Z').toISOString();
    const endDateTime = new Date(endDate + 'T23:59:59Z').toISOString();

    const response = await fetch('http://localhost:8000/api/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        start_date: startDateTime,
        end_date: endDateTime,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
}

function App() {
  const [data, setData] = useState<TradingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState({
    startDate: '2025-05-05',
    endDate: '2025-05-05',
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const result = await getData(dateRange.startDate, dateRange.endDate);
        setData(result);
      } catch (err) {
        console.error("Error fetching data:", err);
        setError(err instanceof Error ? err.message : "Failed to load data.");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [dateRange]);

  const handleReload = async () => {
    try {
      setLoading(true);
      setError(null);
      const message = await reloadData();
      setReloadMessage(message);
      // Refresh the data after reload
      const result = await getData(dateRange.startDate, dateRange.endDate);
      setData(result);
    } catch (err) {
      console.error("Error reloading data:", err);
      setError(err instanceof Error ? err.message : "Failed to reload data.");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto py-10 text-center text-gray-200">
        Загрузка данных...
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-10 text-center text-red-400">
        Ошибка: {error}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <div className="container mx-auto py-10">
        <div className="mb-4 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="startDate" className="text-sm font-medium text-gray-300">
              Start Date
            </label>
            <input
              id="startDate"
              type="date"
              value={dateRange.startDate}
              onChange={(e) => setDateRange(prev => ({ ...prev, startDate: e.target.value }))}
              className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="endDate" className="text-sm font-medium text-gray-300">
              End Date
            </label>
            <input
              id="endDate"
              type="date"
              value={dateRange.endDate}
              onChange={(e) => setDateRange(prev => ({ ...prev, endDate: e.target.value }))}
              className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button 
            onClick={handleReload}
            className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 hover:bg-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
          >
            Reload data
          </button>
          {reloadMessage && (
            <span className="text-sm text-gray-300">
              {reloadMessage}
            </span>
          )}
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800 shadow-lg">
          <DataTable columns={columns} data={data} />
        </div>
      </div>
    </div>
  );
}

export default App;