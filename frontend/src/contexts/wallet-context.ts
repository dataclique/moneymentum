import { createContext, type Accessor } from "solid-js"
import type * as Effect from "effect/Effect"
import type { HyperliquidClient } from "@/services/hyperliquid-client"
import type { WalletConnectError, WalletUnlockFailure } from "@/services/wallet"

export type NetworkMode = "testnet" | "mainnet"

export interface WalletCredentials {
  accountAddress: string // Main wallet where positions/funds are
  apiWalletAddress: string // API wallet authorized to trade
  privateKey: string // Private key of the API wallet
}

export interface WalletContextType {
  credentials: Accessor<WalletCredentials | null>
  networkMode: Accessor<NetworkMode>
  isConnected: Accessor<boolean>
  isLocked: Accessor<boolean>
  hasStoredSession: Accessor<boolean>
  client: Accessor<HyperliquidClient | null>
  connect: (
    credentials: WalletCredentials,
    pin: string,
  ) => Effect.Effect<void, WalletConnectError>
  unlock: (pin: string) => Effect.Effect<void, WalletUnlockFailure>
  disconnect: () => void
  setNetworkMode: (mode: NetworkMode) => void
}

export const WalletContext = createContext<WalletContextType | undefined>(
  undefined,
)

export const WALLET_STORAGE_KEY = "hyperliquid-wallet"
export const NETWORK_STORAGE_KEY = "hyperliquid-network"

export interface EncryptedWalletSession {
  accountAddress: string
  apiWalletAddress: string
  encryptedPrivateKey: string
  salt: string
  iv: string
}

const isEncryptedSession = (
  value: unknown,
): value is EncryptedWalletSession => {
  if (!value || typeof value !== "object") {
    return false
  }

  const sessionCandidate = value as Record<string, unknown>

  return (
    typeof sessionCandidate.accountAddress === "string" &&
    sessionCandidate.accountAddress !== "" &&
    typeof sessionCandidate.apiWalletAddress === "string" &&
    sessionCandidate.apiWalletAddress !== "" &&
    typeof sessionCandidate.encryptedPrivateKey === "string" &&
    sessionCandidate.encryptedPrivateKey !== "" &&
    typeof sessionCandidate.salt === "string" &&
    sessionCandidate.salt !== "" &&
    typeof sessionCandidate.iv === "string" &&
    sessionCandidate.iv !== ""
  )
}

export const getStoredEncryptedSession = (): EncryptedWalletSession | null => {
  try {
    const stored = localStorage.getItem(WALLET_STORAGE_KEY)
    if (!stored) return null

    const parsed: unknown = JSON.parse(stored)
    return isEncryptedSession(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const getStoredWalletAddresses = (): Pick<
  EncryptedWalletSession,
  "accountAddress" | "apiWalletAddress"
> | null => {
  const session = getStoredEncryptedSession()
  if (!session) return null

  return {
    accountAddress: session.accountAddress,
    apiWalletAddress: session.apiWalletAddress,
  }
}

export const getStoredNetworkMode = (): NetworkMode => {
  const stored = localStorage.getItem(NETWORK_STORAGE_KEY)
  if (stored === "mainnet" || stored === "testnet") {
    return stored
  }
  return "testnet"
}
