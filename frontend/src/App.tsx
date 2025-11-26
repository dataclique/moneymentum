// WHOLE APP WORKING IN UTC TIMEZONE, NO LOCAL TIME
import { useEffect, useState } from "react"
import { columns, type TradingData } from "./components/ui/columns"
import { DataTable } from "./components/ui/data-table"
import { Calendar22 as DatePicker } from "./components/ui/date-picker"
import { Route, Routes } from "react-router-dom"
import TokenPage from "./pages/TokenPage"
import PortfolioPage from "./pages/Portfolio"
import { ModeToggle } from "./components/ui/mode-toggle"
import {
  TimeframeSelect,
  type Timeframe,
} from "./components/ui/timeframe-select"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  useDateRange,
  useAnalysisData,
  useReloadData,
  useStopReload,
} from "@/hooks/useApi"

function App() {
  const [timeframe, setTimeframe] = useState<Timeframe>("1h")
  const [dateRange, setDateRange] = useState({
    startDate: null as Date | null,
    endDate: null as Date | null,
  })
  const [maxAvailableDate, setMaxAvailableDate] = useState<Date | null>(null)
  const [minAvailableDate, setMinAvailableDate] = useState<Date | null>(null)

  const {
    data: dateRangeData,
    error: dateRangeError,
    isLoading: isDateRangeLoading,
  } = useDateRange(timeframe)

  useEffect(() => {
    if (dateRangeData) {
      const maxDate = new Date(
        `${dateRangeData.max_date.split("T")[0]}T00:00:00Z`,
      )
      const minDate = new Date(
        `${dateRangeData.min_date.split("T")[0]}T00:00:00Z`,
      )
      setMaxAvailableDate(maxDate)
      setMinAvailableDate(minDate)
      // After first load show only last day data
      setDateRange({
        startDate: maxDate,
        endDate: maxDate,
      })
    }
  }, [dateRangeData])

  const {
    data: analysisData,
    error: analysisError,
    isLoading: isAnalysisLoading,
  } = useAnalysisData({
    startDate: dateRange.startDate?.toISOString().split("T")[0] || "",
    endDate: dateRange.endDate?.toISOString().split("T")[0] || "",
    timeframe,
  })

  const reloadMutation = useReloadData()
  const stopReloadMutation = useStopReload()

  const handleReload = (mode = "analysis_only") => {
    reloadMutation.mutate({ mode })
  }

  const handleStopReload = () => {
    stopReloadMutation.mutate()
  }

  const loading =
    isDateRangeLoading || isAnalysisLoading || reloadMutation.isPending
  const error = dateRangeError?.message || analysisError?.message || null
  const data = analysisData?.data || []
  const message = analysisData?.message || null

  const MainPage = () => (
    <div className="container mx-auto py-2">
      <div className="mb-4 flex items-end justify-start gap-4">
        <TimeframeSelect
          value={timeframe}
          onValueChange={setTimeframe}
          className="w-[180px]"
        />
        <DatePicker
          label="Start Date"
          selected={dateRange.startDate}
          onChange={date =>
            setDateRange(prev => ({ ...prev, startDate: date }))
          }
          minDate={minAvailableDate || undefined}
          maxDate={maxAvailableDate || undefined}
        />
        <DatePicker
          label="End Date"
          selected={dateRange.endDate}
          onChange={date => setDateRange(prev => ({ ...prev, endDate: date }))}
          minDate={minAvailableDate || undefined}
          maxDate={maxAvailableDate || undefined}
        />
        <div>
          {/* Calling only fetch + analysis */}
          <Button
            onClick={() => handleReload("analysis_only")}
            disabled={loading}
          >
            {loading ? "Loading..." : "Reload Data"}
          </Button>
        </div>
        <ModeToggle /> {/* Added ModeToggle here for easy access */}
      </div>
      {message && <div className="mb-4 text-center">{message}</div>}
      <DataTable columns={columns} data={data} />
    </div>
  )

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
  )

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

        {reloadMutation.isPending && (
          <button
            onClick={handleStopReload}
            className="rounded-md border px-3 py-2"
          >
            Stop reloading
          </button>
        )}
      </AppWrapper>
    )
  }

  if (error) {
    return (
      <AppWrapper>
        <div className="container mx-auto py-10 text-center">
          Error: {error}
        </div>
      </AppWrapper>
    )
  }

  return (
    <AppWrapper>
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route
          path="/token/:ticker"
          element={<TokenPage timeframe={timeframe} />}
        />
        <Route path="/portfolio" element={<PortfolioPage />} />
      </Routes>
    </AppWrapper>
  )
}

export default App
