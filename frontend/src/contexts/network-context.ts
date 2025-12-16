import { createContext } from "react"

export interface NetworkContextType {
  isNetworkSwitching: boolean
  setIsNetworkSwitching: (value: boolean) => void
}

export const NetworkContext = createContext<NetworkContextType | undefined>(
  undefined,
)
