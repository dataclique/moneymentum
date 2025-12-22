import { useState, useCallback, useEffect, type ReactNode } from "react"
import {
  WalletContext,
  WALLET_STORAGE_KEY,
  NETWORK_STORAGE_KEY,
  getStoredWallet,
  getStoredNetworkMode,
  type NetworkMode,
  type WalletCredentials,
  type StoredWallet,
} from "./wallet-context"

export const WalletProvider = ({ children }: { children: ReactNode }) => {
  const [credentials, setCredentials] = useState<WalletCredentials | null>(() =>
    getStoredWallet(),
  )
  const [networkMode, setNetworkModeState] = useState<NetworkMode>(() =>
    getStoredNetworkMode(),
  )

  const isConnected = credentials !== null

  const connect = useCallback((newCredentials: WalletCredentials) => {
    setCredentials(newCredentials)
    localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(newCredentials))
  }, [])

  const disconnect = useCallback(() => {
    setCredentials(null)
    localStorage.removeItem(WALLET_STORAGE_KEY)
  }, [])

  const setNetworkMode = useCallback((mode: NetworkMode) => {
    setNetworkModeState(mode)
    localStorage.setItem(NETWORK_STORAGE_KEY, mode)
  }, [])

  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === WALLET_STORAGE_KEY) {
        if (event.newValue === null) {
          setCredentials(null)
        } else {
          try {
            const parsed = JSON.parse(event.newValue) as StoredWallet
            if (parsed.publicKey && parsed.privateKey) {
              setCredentials(parsed)
            }
          } catch {
            setCredentials(null)
          }
        }
      }
      if (event.key === NETWORK_STORAGE_KEY) {
        if (event.newValue === "mainnet" || event.newValue === "testnet") {
          setNetworkModeState(event.newValue)
        }
      }
    }

    window.addEventListener("storage", handleStorageChange)
    return () => {
      window.removeEventListener("storage", handleStorageChange)
    }
  }, [])

  return (
    <WalletContext.Provider
      value={{
        credentials,
        networkMode,
        isConnected,
        connect,
        disconnect,
        setNetworkMode,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}
