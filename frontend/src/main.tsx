/* @refresh reload */
import { render } from "solid-js/web"
import { Router, Route } from "@solidjs/router"
import { lazy } from "solid-js"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { AppLayout, FullscreenLayout } from "./App"
import { NetworkProvider } from "./contexts/NetworkContext"
import { WalletProvider } from "./contexts/WalletProvider"
import { ThemeProvider } from "./components/ui/theme-provider"
import "./index.css"

const PortfolioPage = lazy(() => import("./pages/Portfolio"))
const MainPage = lazy(() => import("./pages/MainPage"))
const PrototypePage = lazy(() => import("./pages/Prototype"))
const TokenPage = lazy(() => import("./pages/TokenPage"))

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

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
        <NetworkProvider>
          <WalletProvider>
            <Router>
              <Route path="/prototype" component={FullscreenLayout}>
                <Route path="/*" component={PrototypePage} />
              </Route>
              <Route path="/" component={AppLayout}>
                <Route path="/" component={PortfolioPage} />
                <Route path="/dashboard" component={MainPage} />
                <Route path="/token/:ticker" component={TokenPage} />
              </Route>
            </Router>
          </WalletProvider>
        </NetworkProvider>
      </ThemeProvider>
    </QueryClientProvider>
  ),
  rootElement,
)
