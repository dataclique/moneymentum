import { useEffect, useState } from "react";
import { columns, type TradingData } from "./components/ui/columns";
import { DataTable } from "./components/ui/data-table";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";

async function getDateRange(): Promise<
  { min_date: string; max_date: string; last_timestamp: string | null }
> {
  const response = await fetch("http://localhost:8000/api/date-range");
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(
      errorData.detail || `HTTP error! status: ${response.status}`,
    );
  }
  return response.json();
}

async function getData(
  startDate: string,
  endDate: string,
): Promise<{ data: TradingData[]; message: string | null }> {
  try {
    // Convert dates to ISO format with time
    const startDateTime = new Date(startDate + "T00:00:00Z").toISOString();
    const endDateTime = new Date(endDate + "T23:59:59Z").toISOString();

    const response = await fetch("http://localhost:8000/api/data", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start_date: startDateTime,
        end_date: endDateTime,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        errorData.detail || `HTTP error! status: ${response.status}`,
      );
    }

    return response.json();
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

function App() {
  const [data, setData] = useState<TradingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const [dateRange, setDateRange] = useState({
    startDate: null as Date | null,
    endDate: null as Date | null,
  });
  const [lastTimestamp, setLastTimestamp] = useState<Date | null>(null);
  const [firstTimestamp, setFirstTimestamp] = useState<Date | null>(null);

  // Fetch date range and set initial dates
  useEffect(() => {
    const initializeDates = async () => {
      try {
        const range = await getDateRange();
        if (range.last_timestamp) {
          const lastDate = new Date(range.last_timestamp);
          const firstDate = new Date(range.min_date);
          setLastTimestamp(lastDate);
          setFirstTimestamp(firstDate);
          setDateRange({
            startDate: lastDate,
            endDate: lastDate,
          });
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.error("Error fetching date range:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load date range.",
        );
        setLoading(false);
      }
    };

    initializeDates();
  }, []);

  // Fetch data when date range changes
  useEffect(() => {
    if (!dateRange.startDate || !dateRange.endDate) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        setMessage(null);
        const result = await getData(
          dateRange.startDate!.toISOString().split("T")[0],
          dateRange.endDate!.toISOString().split("T")[0],
        );
        setData(result.data);
        setMessage(result.message);
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
    setError(null);
    setLoading(true);
    setIsReloading(true);

    const controller = new AbortController();

    try {
      const response = await fetch(
        "http://localhost:8000/api/reload_data/stream",
        {
          method: "POST",
          signal: controller.signal,
        },
      );

      if (!response.body) {
        throw new Error("No response body received");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      const read = async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          console.log(decoder.decode(value, { stream: true }));
        }
        setLoading(false);
        setIsReloading(false);
        // refresh data after reload
        const result = await getData(
          dateRange.startDate?.toISOString().split("T")[0] || "",
          dateRange.endDate?.toISOString().split("T")[0] || "",
        );
        setData(result.data);
        setMessage(result.message);
      };

      read();
    } catch (err) {
      console.error("Error reloading data:", err);
      setError(err instanceof Error ? err.message : "Failed to reload data.");
      setLoading(false);
      setIsReloading(false);
    }
  };

  const handleStopReload = async () => {
    try {
      const response = await fetch("http://localhost:8000/api/stop_reload", {
        method: "POST",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.detail || `HTTP error! status: ${response.status}`,
        );
      }

      setIsReloading(false);
      setLoading(false);
    } catch (err) {
      console.error("Error stopping reload:", err);
      setError(err instanceof Error ? err.message : "Failed to stop reload.");
    }
  };

  if (loading) {
    return (
      <>
        <div className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap rounded bg-black/30 p-4 text-sm text-green-200">
          <div className="flex items-center gap-1">
            <span>Загрузка данных</span>
            <span className="inline-flex">
              <span className="animate-bounce [animation-delay:-0.3s]">.</span>
              <span className="animate-bounce [animation-delay:-0.15s]">.</span>
              <span className="animate-bounce">.</span>
            </span>
          </div>
        </div>

        {isReloading && (
          <button
            onClick={handleStopReload}
            className="rounded-md border border-red-700 bg-red-800 px-3 py-2 text-gray-100 hover:bg-red-700 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 cursor-pointer"
          >
            Stop reloading
          </button>
        )}
      </>
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
            <label className="text-sm font-medium text-gray-300">
              Start Date
            </label>
            <DatePicker
              selected={dateRange.startDate}
              onChange={(date) =>
                setDateRange((prev) => ({ ...prev, startDate: date }))}
              className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              dateFormat="yyyy-MM-dd"
              wrapperClassName="w-auto"
              minDate={firstTimestamp || undefined}
              maxDate={dateRange.endDate || undefined}
              popperClassName="!bg-gray-800 !border !border-gray-700 !text-gray-100 [&_.react-datepicker__header]:!bg-gray-800 [&_.react-datepicker__header]:!border-gray-700 [&_.react-datepicker__current-month]:!text-gray-100 [&_.react-datepicker__day-name]:!text-gray-300 [&_.react-datepicker__day]:!text-gray-100 [&_.react-datepicker__day:hover]:!bg-gray-700 [&_.react-datepicker__day--selected]:!bg-blue-500 [&_.react-datepicker__day--keyboard-selected]:!bg-blue-500 [&_.react-datepicker__day--outside-month]:!text-gray-600 [&_.react-datepicker__navigation-icon]:!before:!border-gray-300 [&_.react-datepicker__navigation:hover]:!bg-gray-700 [&_.react-datepicker__navigation]:!top-2 [&_.react-datepicker__day--disabled]:!text-gray-600 [&_.react-datepicker__day--disabled]:!bg-transparent [&_.react-datepicker__day--disabled]:!cursor-not-allowed"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-300">
              End Date
            </label>
            <DatePicker
              selected={dateRange.endDate}
              onChange={(date) =>
                setDateRange((prev) => ({ ...prev, endDate: date }))}
              className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              dateFormat="yyyy-MM-dd"
              wrapperClassName="w-auto"
              minDate={dateRange.startDate || undefined}
              maxDate={lastTimestamp || undefined}
              popperClassName="!bg-gray-800 !border !border-gray-700 !text-gray-100 [&_.react-datepicker__header]:!bg-gray-800 [&_.react-datepicker__header]:!border-gray-700 [&_.react-datepicker__current-month]:!text-gray-100 [&_.react-datepicker__day-name]:!text-gray-300 [&_.react-datepicker__day]:!text-gray-100 [&_.react-datepicker__day:hover]:!bg-gray-700 [&_.react-datepicker__day--selected]:!bg-blue-500 [&_.react-datepicker__day--keyboard-selected]:!bg-blue-500 [&_.react-datepicker__day--outside-month]:!text-gray-600 [&_.react-datepicker__navigation-icon]:!before:!border-gray-300 [&_.react-datepicker__navigation:hover]:!bg-gray-700 [&_.react-datepicker__navigation]:!top-2 [&_.react-datepicker__day--disabled]:!text-gray-600 [&_.react-datepicker__day--disabled]:!bg-transparent [&_.react-datepicker__day--disabled]:!cursor-not-allowed"
            />
          </div>
          <button
            onClick={handleReload}
            className="rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 hover:bg-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
          >
            Reload data
          </button>
        </div>
        {message && (
          <div className="mb-4 text-center text-yellow-400">
            {message}
          </div>
        )}
        <div className="rounded-lg border border-gray-700 bg-gray-800 shadow-lg">
          <DataTable
            columns={columns}
            data={data}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
