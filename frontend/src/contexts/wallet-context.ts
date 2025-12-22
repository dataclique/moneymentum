import { createContext } from "react"

export type NetworkMode = "testnet" | "mainnet"

export interface WalletCredentials {
  publicKey: string
  privateKey: string
}

export interface WalletContextType {
  credentials: WalletCredentials | null
  networkMode: NetworkMode
  isConnected: boolean
  connect: (credentials: WalletCredentials) => void
  disconnect: () => void
  setNetworkMode: (mode: NetworkMode) => void
}

export const WalletContext = createContext<WalletContextType | undefined>(
  undefined,
)

export const WALLET_STORAGE_KEY = "hyperliquid-wallet"
export const NETWORK_STORAGE_KEY = "hyperliquid-network"

export interface StoredWallet {
  publicKey: string
  privateKey: string
}

export const getStoredWallet = (): WalletCredentials | null => {
  const stored = localStorage.getItem(WALLET_STORAGE_KEY)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as StoredWallet
    if (parsed.publicKey && parsed.privateKey) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export const getStoredNetworkMode = (): NetworkMode => {
  const stored = localStorage.getItem(NETWORK_STORAGE_KEY)
  if (stored === "mainnet" || stored === "testnet") {
    return stored
  }
  return "testnet"
}
