// WHOLE APP WORKING IN UTC TIMEZONE, NO LOCAL TIME
import { useEffect, useState } from "react"
import {
  columns,
  type TradingData as TableTradingData,
} from "./components/ui/columns"
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
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { Button } from "@/components/ui/button"
import { WalletHeader } from "./components/wallet-header"
import {
  useDateRange,
  useAnalysisData,
  useReloadData,
  useStopReload,
} from "@/hooks/useApi"
import { useNetwork } from "@/hooks/useNetwork"

const App = () => {
  const { isNetworkSwitching } = useNetwork()
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
    startDate: dateRange.startDate?.toISOString().split("T")[0] ?? "",
    endDate: dateRange.endDate?.toISOString().split("T")[0] ?? "",
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
  const error = dateRangeError?.message ?? analysisError?.message ?? null
  const data = analysisData?.data ?? []
  const tableData = data as unknown as TableTradingData[]
  const message = analysisData?.message ?? null

  const MainPage = () => (
    <div
      className={twMerge(
        clsx(
          "container mx-auto py-2",
          isNetworkSwitching && "pointer-events-none opacity-80",
        ),
      )}
    >
      <div className="mb-4 flex items-end justify-start gap-4">
        <TimeframeSelect
          value={timeframe}
          onValueChange={setTimeframe}
          className="w-[180px]"
        />
        <DatePicker
          label="Start Date"
          selected={dateRange.startDate}
          onChange={date => {
            setDateRange(prev => ({ ...prev, startDate: date }))
          }}
          minDate={minAvailableDate ?? undefined}
          maxDate={maxAvailableDate ?? undefined}
        />
        <DatePicker
          label="End Date"
          selected={dateRange.endDate}
          onChange={date => {
            setDateRange(prev => ({ ...prev, endDate: date }))
          }}
          minDate={minAvailableDate ?? undefined}
          maxDate={maxAvailableDate ?? undefined}
        />
        <div>
          {/* Calling only fetch + analysis */}
          <Button
            onClick={() => {
              handleReload("analysis_only")
            }}
            disabled={loading || isNetworkSwitching}
          >
            {loading ? "Loading..." : "Reload Data"}
          </Button>
        </div>
        <ModeToggle /> {/* Added ModeToggle here for easy access */}
      </div>
      {isNetworkSwitching && (
        <div className="mb-4 text-center text-sm text-muted-foreground">
          Switching network... Please wait
        </div>
      )}
      {message && <div className="mb-4 text-center">{message}</div>}
      <DataTable columns={columns} data={tableData} />
    </div>
  )

  // Define a common wrapper for all states (loading, error, main content)
  const AppWrapper = ({ children }: { children: React.ReactNode }) => (
    <div
      className={twMerge(
        clsx(
          "min-h-screen flex flex-col bg-background text-foreground", // Apply theme classes here
          isNetworkSwitching && "pointer-events-none opacity-80", // Disable whole app during network switch
          // You can add other global styles here if needed
        ),
      )}
    >
      <header className="border-b border-border px-4 py-2 pl-28 pr-28 flex items-center justify-between w-full">
        <h1 className="text-lg font-semibold">Moneymentum</h1>
        <div className="flex items-center gap-4">
          <WalletHeader />
          <ModeToggle />
        </div>
        {isNetworkSwitching && (
          <div className="container mx-auto mt-2 text-center text-sm text-muted-foreground">
            Switching network... All data will reload automatically
          </div>
        )}
      </header>
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
