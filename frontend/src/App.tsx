// WHOLE APP WORKING IN UTC TIMEZONE, NO LOCAL TIME
import { useEffect, useState } from "react";
import { columns, type TradingData } from "./components/ui/columns";
import { DataTable } from "./components/ui/data-table";
import { Calendar22 as DatePicker } from "./components/ui/date-picker";
import { Route, Routes, useNavigate } from "react-router-dom";
import TokenPage from "./pages/TokenPage";
import { ModeToggle } from "./components/ui/mode-toggle";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

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
  const [maxAvailableDate, setMaxAvailableDate] = useState<Date | null>(null);
  const [minAvailableDate, setMinAvailableDate] = useState<Date | null>(null);
  const navigate = useNavigate();

  // Fetch date range and set initial dates
  useEffect(() => {
    const initializeDates = async () => {
      try {
        const range = await getDateRange();
        const maxDate = new Date(`${range.max_date.split("T")[0]}T00:00:00Z`);
        const minDate = new Date(`${range.min_date.split("T")[0]}T00:00:00Z`);
        setMaxAvailableDate(maxDate);
        setMinAvailableDate(minDate);
        // After first load show only last day data
        setDateRange({
          startDate: maxDate,
          endDate: maxDate,
        });
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
    if (dateRange.startDate && dateRange.endDate) {
      console.log(
        dateRange.startDate.toISOString().split("T")[0],
        dateRange.endDate.toISOString().split("T")[0],
      );

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
    }
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

  // Move table to a separate component for the main page
  const MainPage = () => (
    <div className="container mx-auto py-10">
      <div className="mb-4 flex items-end justify-start gap-4">
        <DatePicker
          label="Start Date"
          selected={dateRange.startDate}
          onChange={(date) =>
            setDateRange((prev) => ({ ...prev, startDate: date }))}
          minDate={minAvailableDate || undefined}
          maxDate={maxAvailableDate || undefined}
        />
        <DatePicker
          label="End Date"
          selected={dateRange.endDate}
          onChange={(date) =>
            setDateRange((prev) => ({ ...prev, endDate: date }))}
          minDate={minAvailableDate || undefined}
          maxDate={maxAvailableDate || undefined}
        />

        <Button
          variant="outline"
          onClick={handleReload}
          className="cursor-pointer"
        >
          Reload data
        </Button>
        <ModeToggle /> {/* Added ModeToggle here for easy access */}
      </div>
      {message && (
        <div className="mb-4 text-center">
          {message}
        </div>
      )}
      <DataTable
        columns={columns}
        data={data}
      />
    </div>
  );

  // Define a common wrapper for all states (loading, error, main content)
  const AppWrapper = ({ children }: { children: React.ReactNode }) => (
    <div
      className={cn(
        "min-h-screen flex flex-col bg-background text-foreground", // Apply theme classes here
        // You can add other global styles here if needed
      )}
    >
      {children}
    </div>
  );

  if (loading) {
    return (
      <AppWrapper>
        <div className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap rounded p-4 text-sm">
          <div className="flex items-center gap-1">
            <span>Loading data</span>
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
            className="rounded-md border px-3 py-2"
          >
            Stop reloading
          </button>
        )}
      </AppWrapper>
    );
  }

  if (error) {
    return (
      <AppWrapper>
        <div className="container mx-auto py-10 text-center">
          Error: {error}
        </div>
      </AppWrapper>
    );
  }

  return (
    <AppWrapper>
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route path="/token/:ticker" element={<TokenPage />} />
      </Routes>
    </AppWrapper>
  );
}

export default App;
