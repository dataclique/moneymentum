import { createContext, useContext, useState, type ReactNode } from "react"

interface NetworkContextType {
  isNetworkSwitching: boolean
  setIsNetworkSwitching: (value: boolean) => void
}

const NetworkContext = createContext<NetworkContextType | undefined>(undefined)

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [isNetworkSwitching, setIsNetworkSwitching] = useState(false)

  return (
    <NetworkContext.Provider
      value={{ isNetworkSwitching, setIsNetworkSwitching }}
    >
      {children}
    </NetworkContext.Provider>
  )
}

export function useNetwork() {
  const context = useContext(NetworkContext)
  if (context === undefined) {
    throw new Error("useNetwork must be used within a NetworkProvider")
  }
  return context
}
