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
  getStoredEncryptedSession,
  getStoredNetworkMode,
  type EncryptedWalletSession,
  type NetworkMode,
  type WalletCredentials,
} from "./wallet-context"
import { HyperliquidClient } from "@/services/hyperliquid-client"
import {
  decryptWalletPrivateKey,
  encryptWalletPrivateKey,
} from "@/services/walletCredentialCrypto"

const credentialsFromSession = (
  session: EncryptedWalletSession,
  privateKey: string,
): WalletCredentials => ({
  accountAddress: session.accountAddress,
  apiWalletAddress: session.apiWalletAddress,
  privateKey,
})

const persistEncryptedSession = (
  credentials: WalletCredentials,
  encrypted: Pick<
    EncryptedWalletSession,
    "encryptedPrivateKey" | "salt" | "iv"
  >,
) => {
  const session: EncryptedWalletSession = {
    accountAddress: credentials.accountAddress,
    apiWalletAddress: credentials.apiWalletAddress,
    encryptedPrivateKey: encrypted.encryptedPrivateKey,
    salt: encrypted.salt,
    iv: encrypted.iv,
  }
  localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(session))
}

export const WalletProvider = (props: ParentProps) => {
  const [credentials, setCredentials] = createSignal<WalletCredentials | null>(
    null,
  )
  const [networkMode, setNetworkModeState] = createSignal<NetworkMode>(
    getStoredNetworkMode(),
  )
  const [hasStoredSession, setHasStoredSession] = createSignal(
    getStoredEncryptedSession() !== null,
  )

  const syncStoredSessionState = () => {
    setHasStoredSession(getStoredEncryptedSession() !== null)
  }

  const isConnected = createMemo(() => credentials() !== null)
  const isLocked = createMemo(
    () => hasStoredSession() && credentials() === null,
  )

  const client = createMemo(() => {
    const creds = credentials()
    if (!creds) return null
    return new HyperliquidClient(creds, networkMode())
  })

  const connect = async (
    newCredentials: WalletCredentials,
    pin: string,
  ): Promise<void> => {
    const encrypted = await encryptWalletPrivateKey(
      newCredentials.privateKey,
      pin,
    )
    persistEncryptedSession(newCredentials, encrypted)
    setCredentials(newCredentials)
    syncStoredSessionState()
  }

  const unlock = async (pin: string): Promise<void> => {
    const session = getStoredEncryptedSession()
    if (!session) {
      throw new Error("no encrypted wallet session in storage")
    }

    const privateKey = await decryptWalletPrivateKey(
      session.encryptedPrivateKey,
      pin,
      session.salt,
      session.iv,
    )
    setCredentials(credentialsFromSession(session, privateKey))
  }

  const disconnect = () => {
    setCredentials(null)
    localStorage.removeItem(WALLET_STORAGE_KEY)
    syncStoredSessionState()
  }

  const setNetworkMode = (mode: NetworkMode) => {
    setNetworkModeState(mode)
    localStorage.setItem(NETWORK_STORAGE_KEY, mode)
  }

  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === WALLET_STORAGE_KEY) {
      setCredentials(null)
      syncStoredSessionState()
    }
    if (event.key === NETWORK_STORAGE_KEY) {
      setNetworkModeState(getStoredNetworkMode())
    }
  }

  onMount(() => {
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
        isLocked,
        hasStoredSession,
        client,
        connect,
        unlock,
        disconnect,
        setNetworkMode,
      }}
    >
      {props.children}
    </WalletContext.Provider>
  )
}
