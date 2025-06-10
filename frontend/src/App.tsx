import { useState, useEffect } from 'react';
import { columns, type TradingData } from "./components/ui/columns"
import { DataTable } from "./components/ui/data-table"

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
  const [dateRange, setDateRange] = useState({
    startDate: '2025-01-01',
    endDate: '2025-01-01',
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

  if (loading) {
    return (
      <div className="container mx-auto py-10 text-center">
        Загрузка данных...
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-10 text-center text-red-500">
        Ошибка: {error}
      </div>
    );
  }

  return (
    <div className="container mx-auto py-10">
      <div className="mb-4">
        <input
          type="date"
          value={dateRange.startDate}
          onChange={(e) => setDateRange(prev => ({ ...prev, startDate: e.target.value }))}
          className="mr-2 p-2 border rounded"
        />
        <input
          type="date"
          value={dateRange.endDate}
          onChange={(e) => setDateRange(prev => ({ ...prev, endDate: e.target.value }))}
          className="p-2 border rounded"
        />
      </div>
      <DataTable columns={columns} data={data} />
    </div>
  );
}

export default App;