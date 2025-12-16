import { useState, type ReactNode } from "react"
import { NetworkContext } from "./network-context"

export const NetworkProvider = ({ children }: { children: ReactNode }) => {
  const [isNetworkSwitching, setIsNetworkSwitching] = useState(false)

  return (
    <NetworkContext.Provider
      value={{ isNetworkSwitching, setIsNetworkSwitching }}
    >
      {children}
    </NetworkContext.Provider>
  )
}
