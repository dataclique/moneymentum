import {
  createSignal,
  createMemo,
  onMount,
  onCleanup,
  type ParentProps,
} from "solid-js"
import {
  WalletContext,
  WALLET_STORAGE_KEY,
  NETWORK_STORAGE_KEY,
  getStoredNetworkMode,
  type NetworkMode,
  type WalletCredentials,
} from "./wallet-context"
import { HyperliquidClient } from "@/services/hyperliquid-client"

export const WalletProvider = (props: ParentProps) => {
  const [credentials, setCredentials] = createSignal<WalletCredentials | null>(
    null,
  )
  const [networkMode, setNetworkModeState] = createSignal<NetworkMode>(
    getStoredNetworkMode(),
  )

  const isConnected = createMemo(() => credentials() !== null)

  const client = createMemo(() => {
    const creds = credentials()
    if (!creds) return null
    return new HyperliquidClient(creds, networkMode())
  })

  const connect = (newCredentials: WalletCredentials) => {
    setCredentials(newCredentials)
    const { accountAddress, apiWalletAddress, vaultAddress } = newCredentials
    // SECURITY: never persist the private key. Only public address metadata is
    // stored, so the reconnect dialog can pre-fill it; the user re-enters the
    // private key on reload. Credentials never leave the browser to disk.
    localStorage.setItem(
      WALLET_STORAGE_KEY,
      JSON.stringify({ accountAddress, apiWalletAddress, vaultAddress }),
    )
  }

  const disconnect = () => {
    setCredentials(null)
    localStorage.removeItem(WALLET_STORAGE_KEY)
  }

  const setNetworkMode = (mode: NetworkMode) => {
    setNetworkModeState(mode)
    localStorage.setItem(NETWORK_STORAGE_KEY, mode)
  }

  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === WALLET_STORAGE_KEY) {
      setCredentials(null)
    }
    if (event.key === NETWORK_STORAGE_KEY) {
      setNetworkModeState(getStoredNetworkMode())
    }
  }

  onMount(() => {
    // The private key is never persisted, so a full session cannot be restored
    // on mount; the reconnect dialog pre-fills the stored public metadata and
    // the user re-enters the key. Only wire the cross-tab storage listener.
    window.addEventListener("storage", handleStorageChange)
  })
  onCleanup(() => {
    window.removeEventListener("storage", handleStorageChange)
  })

  return (
    <WalletContext.Provider
      value={{
        credentials,
        networkMode,
        isConnected,
        client,
        connect,
        disconnect,
        setNetworkMode,
      }}
    >
      {props.children}
    </WalletContext.Provider>
  )
}
