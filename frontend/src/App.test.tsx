import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import App from "./App"
import { ThemeProvider } from "@/components/ui/theme-provider"
import { NetworkProvider } from "@/contexts/NetworkContext"

// Mock window.matchMedia for ThemeProvider
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Track useAnalysisData calls to verify date parameters
// Use vi.hoisted to make this available before vi.mock hoisting
const useAnalysisDataMock = vi.hoisted(() =>
  vi.fn(() => ({
    data: null,
    error: null,
    isLoading: false,
  })),
)

// Mock CCXT to prevent initialization errors
vi.mock("ccxt", () => ({
  default: {
    hyperliquid: class MockHyperliquid {
      setSandboxMode = vi.fn()
      fetchBalance = vi.fn()
      fetchPositions = vi.fn()
      fetchTickers = vi.fn()
      fetchMarkets = vi.fn()
      createOrder = vi.fn()
    },
  },
}))

// Mock the trading hooks
vi.mock("@/hooks/useTrading", () => ({
  useHyperliquidBalance: vi.fn(() => ({ data: null, isLoading: true })),
  useHyperliquidPositions: vi.fn(() => ({ data: null, isLoading: true })),
  useHyperliquidTickers: vi.fn(() => ({ data: null, isLoading: true })),
  useHyperliquidLeverageLimits: vi.fn(() => ({ data: null, isLoading: true })),
  useRebalanceHyperliquidPositions: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useWalletSettings: vi.fn(() => ({ data: null, isLoading: true })),
  useSwitchNetwork: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  refreshClientData: vi.fn(),
}))

// Mock the API hooks
vi.mock("@/hooks/useApi", () => ({
  useDateRange: vi.fn(() => ({
    data: null,
    error: null,
    isLoading: true,
  })),
  useAnalysisData: useAnalysisDataMock,
  useReloadData: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useStopReload: vi.fn(() => ({
    mutate: vi.fn(),
  })),
}))

// Mock useNetwork hook
vi.mock("@/hooks/useNetwork", () => ({
  useNetwork: vi.fn(() => ({
    isNetworkSwitching: false,
    setIsNetworkSwitching: vi.fn(),
  })),
}))

// Mock components that aren't relevant to the test
vi.mock("./components/wallet-header", () => ({
  WalletHeader: () => <div data-testid="wallet-header">WalletHeader</div>,
}))

vi.mock("./components/ui/data-table", () => ({
  DataTable: () => <div data-testid="data-table">DataTable</div>,
}))

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <NetworkProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </NetworkProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("date range useEffect", () => {
    it("shows loading state when date range is loading", async () => {
      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: null,
        error: null,
        isLoading: true,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      render(<App />, { wrapper: createWrapper() })

      expect(screen.getByText(/Loading data/)).toBeInTheDocument()
    })

    it("initializes date range to max date when data is received", async () => {
      const useApiModule = await import("@/hooks/useApi")

      // First render with loading
      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: null,
        error: null,
        isLoading: true,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      const { rerender } = render(<App />, { wrapper: createWrapper() })

      // Then update with data
      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: {
          min_date: "2024-01-01T00:00:00Z",
          max_date: "2024-12-31T00:00:00Z",
          last_timestamp: "2024-12-31T23:00:00Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      vi.mocked(useApiModule.useAnalysisData).mockReturnValue({
        data: { data: [], message: null },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useAnalysisData>)

      rerender(<App />)

      // After data loads, the app should render the main page (not loading)
      await waitFor(() => {
        expect(screen.queryByText(/Loading data/)).not.toBeInTheDocument()
      })
    })

    it("shows error state when date range query fails", async () => {
      const useApiModule = await import("@/hooks/useApi")

      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: null,
        error: { message: "Failed to fetch date range" },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      render(<App />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(
          screen.getByText(/Error: Failed to fetch date range/),
        ).toBeInTheDocument()
      })
    })

    it("shows error state when analysis query fails", async () => {
      const useApiModule = await import("@/hooks/useApi")

      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: {
          min_date: "2024-01-01T00:00:00Z",
          max_date: "2024-12-31T00:00:00Z",
          last_timestamp: "2024-12-31T23:00:00Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      vi.mocked(useApiModule.useAnalysisData).mockReturnValue({
        data: null,
        error: { message: "Analysis failed" },
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useAnalysisData>)

      render(<App />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/Error: Analysis failed/)).toBeInTheDocument()
      })
    })
  })

  describe("network switching state", () => {
    it("shows network switching message when switching", async () => {
      const useNetworkModule = await import("@/hooks/useNetwork")
      vi.mocked(useNetworkModule.useNetwork).mockReturnValue({
        isNetworkSwitching: true,
        setIsNetworkSwitching: vi.fn(),
      })

      const useApiModule = await import("@/hooks/useApi")
      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: null,
        error: null,
        isLoading: true,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      render(<App />, { wrapper: createWrapper() })

      expect(
        screen.getByText(/Switching network... All data will reload/),
      ).toBeInTheDocument()
    })
  })

  describe("reload functionality", () => {
    it("shows stop button when reload is pending", async () => {
      const useApiModule = await import("@/hooks/useApi")

      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: {
          min_date: "2024-01-01T00:00:00Z",
          max_date: "2024-12-31T00:00:00Z",
          last_timestamp: "2024-12-31T23:00:00Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      vi.mocked(useApiModule.useAnalysisData).mockReturnValue({
        data: null,
        error: null,
        isLoading: true,
      } as unknown as ReturnType<typeof useApiModule.useAnalysisData>)

      vi.mocked(useApiModule.useReloadData).mockReturnValue({
        mutate: vi.fn(),
        isPending: true,
      } as unknown as ReturnType<typeof useApiModule.useReloadData>)

      render(<App />, { wrapper: createWrapper() })

      expect(screen.getByText("Stop reloading")).toBeInTheDocument()
    })
  })

  describe("date range initialization and updates", () => {
    it("calls useAnalysisData with maxDate for both start and end after dateRangeData loads", async () => {
      const useApiModule = await import("@/hooks/useApi")

      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: {
          min_date: "2024-01-01T00:00:00Z",
          max_date: "2024-06-15T00:00:00Z",
          last_timestamp: "2024-06-15T23:00:00Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      useAnalysisDataMock.mockReturnValue({
        data: { data: [], message: null },
        error: null,
        isLoading: false,
      } as never)

      render(<App />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(useAnalysisDataMock).toHaveBeenCalledWith({
          startDate: "2024-06-15",
          endDate: "2024-06-15",
          timeframe: "1h",
        })
      })
    })

    it("passes correct timeframe to useDateRange", async () => {
      const useApiModule = await import("@/hooks/useApi")
      const useDateRangeMock = vi.mocked(useApiModule.useDateRange)

      useDateRangeMock.mockReturnValue({
        data: {
          min_date: "2024-01-01T00:00:00Z",
          max_date: "2024-06-15T00:00:00Z",
          last_timestamp: "2024-06-15T23:00:00Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      useAnalysisDataMock.mockReturnValue({
        data: { data: [], message: null },
        error: null,
        isLoading: false,
      } as never)

      render(<App />, { wrapper: createWrapper() })

      expect(useDateRangeMock).toHaveBeenCalledWith("1h")
    })

    it("resets dates to new maxDate when dateRangeData changes", async () => {
      const useApiModule = await import("@/hooks/useApi")
      const useDateRangeMock = vi.mocked(useApiModule.useDateRange)

      // Reset mocks that may have been modified by previous tests
      const useNetworkModule = await import("@/hooks/useNetwork")
      vi.mocked(useNetworkModule.useNetwork).mockReturnValue({
        isNetworkSwitching: false,
        setIsNetworkSwitching: vi.fn(),
      })
      vi.mocked(useApiModule.useReloadData).mockReturnValue({
        mutate: vi.fn(),
        isPending: false,
      } as unknown as ReturnType<typeof useApiModule.useReloadData>)

      // Initial state
      useDateRangeMock.mockReturnValue({
        data: {
          min_date: "2024-01-01T00:00:00Z",
          max_date: "2024-06-15T00:00:00Z",
          last_timestamp: "2024-06-15T23:00:00Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      useAnalysisDataMock.mockReturnValue({
        data: { data: [], message: null },
        error: null,
        isLoading: false,
      } as never)

      const { rerender } = render(<App />, { wrapper: createWrapper() })

      // Verify initial call with maxDate
      await waitFor(() => {
        expect(useAnalysisDataMock).toHaveBeenCalledWith({
          startDate: "2024-06-15",
          endDate: "2024-06-15",
          timeframe: "1h",
        })
      })

      // Clear mock calls to verify the next call
      useAnalysisDataMock.mockClear()

      // Simulate dateRangeData changing (e.g., from timeframe change or data refresh)
      useDateRangeMock.mockReturnValue({
        data: {
          min_date: "2024-03-01T00:00:00Z",
          max_date: "2024-07-20T00:00:00Z",
          last_timestamp: "2024-07-20T23:00:00Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      rerender(<App />)

      // Should now call with new maxDate
      await waitFor(() => {
        expect(useAnalysisDataMock).toHaveBeenCalledWith({
          startDate: "2024-07-20",
          endDate: "2024-07-20",
          timeframe: "1h",
        })
      })
    })

    it("strips time component from dates, using only YYYY-MM-DD", async () => {
      const useApiModule = await import("@/hooks/useApi")

      // Dates with various time components
      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: {
          min_date: "2024-01-15T12:30:45.123Z",
          max_date: "2024-06-20T18:45:30.999Z",
          last_timestamp: "2024-06-20T23:59:59Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      useAnalysisDataMock.mockReturnValue({
        data: { data: [], message: null },
        error: null,
        isLoading: false,
      } as never)

      render(<App />, { wrapper: createWrapper() })

      // Should strip time and only use date portion
      await waitFor(() => {
        expect(useAnalysisDataMock).toHaveBeenCalledWith({
          startDate: "2024-06-20",
          endDate: "2024-06-20",
          timeframe: "1h",
        })
      })
    })

    it("calls useAnalysisData with empty strings when dateRange is not yet set", async () => {
      const useApiModule = await import("@/hooks/useApi")

      // No data yet - dates will be null
      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: null,
        error: null,
        isLoading: true,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      useAnalysisDataMock.mockReturnValue({
        data: null,
        error: null,
        isLoading: false,
      } as never)

      render(<App />, { wrapper: createWrapper() })

      // With null dates, should call with empty strings
      expect(useAnalysisDataMock).toHaveBeenCalledWith({
        startDate: "",
        endDate: "",
        timeframe: "1h",
      })
    })
  })
})
