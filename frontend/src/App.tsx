import { Route, Routes, useLocation } from "react-router-dom"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import MainPage from "./pages/MainPage"
import TokenPage from "./pages/TokenPage"
import PortfolioPage from "./pages/Portfolio"
import { ModeToggle } from "./components/ui/mode-toggle"
import { WalletHeader } from "./components/wallet-header"
import { useNetwork } from "@/hooks/useNetwork"
import { useWallet } from "@/hooks/useWallet"

const App = () => {
  const { isNetworkSwitching } = useNetwork()
  const { networkMode } = useWallet()
  const location = useLocation()
  const isPortfolioPage = location.pathname === "/portfolio"

  return (
    <div
      className={twMerge(
        clsx(
          "flex min-h-screen flex-col bg-background text-foreground",
          isNetworkSwitching && "pointer-events-none opacity-80",
        ),
      )}
    >
      <header className="flex w-full items-center justify-between border-b border-border px-4 py-2 pl-28 pr-28">
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
      </header>
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route path="/token/:ticker" element={<TokenPage timeframe="1h" />} />
        <Route
          path="/portfolio"
          element={<PortfolioPage key={networkMode} />}
        />
      </Routes>
    </div>
  )
}

export default App
