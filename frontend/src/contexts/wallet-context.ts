import { createContext } from "react"
import type { HyperliquidClient } from "@/services/hyperliquid-client"

export type NetworkMode = "testnet" | "mainnet"

export interface WalletCredentials {
  accountAddress: string // Main wallet where positions/funds are
  apiWalletAddress: string // API wallet authorized to trade
  privateKey: string // Private key of the API wallet
  vaultAddress?: string // Optional vault to trade on behalf of
}

export interface WalletContextType {
  credentials: WalletCredentials | null
  networkMode: NetworkMode
  isConnected: boolean
  client: HyperliquidClient | null
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
  accountAddress: string
  apiWalletAddress: string
  privateKey: string
  vaultAddress?: string
}

export const getStoredWallet = (): WalletCredentials | null => {
  const stored = localStorage.getItem(WALLET_STORAGE_KEY)
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as StoredWallet
    if (parsed.accountAddress && parsed.apiWalletAddress && parsed.privateKey) {
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
