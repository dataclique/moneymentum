import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { BrowserRouter } from "react-router-dom"
import { ThemeProvider } from "@/components/ui/theme-provider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { NetworkProvider } from "@/contexts/NetworkContext"
import { WalletProvider } from "@/contexts/WalletProvider"
import { Toaster } from "@/components/ui/sonner"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
})

const rootElement = document.getElementById("root")
if (!rootElement) {
  throw new Error("Root element not found")
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
        <WalletProvider>
          <NetworkProvider>
            <BrowserRouter basename={import.meta.env.BASE_URL}>
              <App />
            </BrowserRouter>
          </NetworkProvider>
        </WalletProvider>
        <Toaster />
      </ThemeProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  </StrictMode>,
)
