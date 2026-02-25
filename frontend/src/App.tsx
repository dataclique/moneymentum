import { Link, Route, Routes, useLocation } from "react-router-dom"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import MainPage from "./pages/MainPage"
import TokenPage from "./pages/TokenPage"
import PortfolioPage from "./pages/Portfolio"
import PrototypePage from "./pages/Prototype"
import { useNetwork } from "@/hooks/useNetwork"
import { useWallet } from "@/hooks/useWallet"

const NotFoundPage = () => (
  <div className="flex flex-1 flex-col items-center justify-center gap-4">
    <h2 className="text-2xl font-semibold">Page not found</h2>
    <p className="text-sm text-muted-foreground">
      The page you are looking for does not exist.
    </p>
    <Link
      to="/"
      className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    >
      Go home
    </Link>
  </div>
)

const App = () => {
  const { isNetworkSwitching } = useNetwork()
  const { networkMode } = useWallet()
  const location = useLocation()
  // const isPortfolioPage = location.pathname === "/portfolio"
  const isPrototypePage = location.pathname.startsWith("/prototype")

  // Prototype page has its own full-screen layout
  if (isPrototypePage) {
    return (
      <Routes>
        <Route path="/prototype/*" element={<PrototypePage />} />
      </Routes>
    )
  }

  return (
    <div
      className={twMerge(
        clsx(
          "flex h-screen flex-col overflow-hidden bg-background text-foreground text-[11px]",
          isNetworkSwitching && "pointer-events-none opacity-80",
        ),
      )}
    >
      {/* <header className="flex w-full items-center justify-between border-b border-border px-4 py-2 pl-28 pr-28">
        <h1 className="text-lg font-semibold">Moneymentum</h1>
        <div className="flex items-center gap-4">
          <WalletHeader autoOpen={isPortfolioPage} />
          <ModeToggle />
        </div>
        {isNetworkSwitching && (
          <div className="container mx-auto mt-2 text-center text-sm text-muted-foreground">
            Switching network... All data will reload automatically
          </div>
        )}
      </header> */}
      <Routes>
        <Route path="/" element={<PortfolioPage key={networkMode} />} />
        <Route path="/dashboard" element={<MainPage />} />
        <Route path="/token/:ticker" element={<TokenPage timeframe="1h" />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </div>
  )
}

export default App
