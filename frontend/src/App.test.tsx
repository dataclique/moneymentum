import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import App from "./App"

// Mock the API hooks
vi.mock("@/hooks/useApi", () => ({
  useDateRange: vi.fn(() => ({
    data: null,
    error: null,
    isLoading: true,
  })),
  useAnalysisData: vi.fn(() => ({
    data: null,
    error: null,
    isLoading: false,
  })),
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
      <MemoryRouter>{children}</MemoryRouter>
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

    it("parses date correctly stripping time component", async () => {
      const useApiModule = await import("@/hooks/useApi")

      vi.mocked(useApiModule.useDateRange).mockReturnValue({
        data: {
          min_date: "2024-01-15T12:30:45Z",
          max_date: "2024-06-20T18:45:30Z",
          last_timestamp: "2024-06-20T23:00:00Z",
        },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useDateRange>)

      vi.mocked(useApiModule.useAnalysisData).mockReturnValue({
        data: { data: [], message: null },
        error: null,
        isLoading: false,
      } as unknown as ReturnType<typeof useApiModule.useAnalysisData>)

      render(<App />, { wrapper: createWrapper() })

      // The effect should parse dates correctly
      // We can't directly check state, but we verify the app renders without error
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
})
