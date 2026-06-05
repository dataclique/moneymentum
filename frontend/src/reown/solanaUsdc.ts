/**
 * Demo helpers: Reown AppKit + Solana RPC + SPL USDC transfer.
 * Import these from other pages when wiring the same flow.
 */

import { createAppKit, type AppKit } from "@reown/appkit"
import { solana, solanaDevnet } from "@reown/appkit/networks"
import { SolanaAdapter } from "@reown/appkit-adapter-solana"
import type { Provider } from "@reown/appkit-utils/solana"
import { SolHelpersUtil } from "@reown/appkit-utils/solana"
import {
  createAssociatedTokenAccountIdempotentInstructionWithDerivation,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TokenAccountNotFoundError,
} from "@solana/spl-token"
import { Connection, PublicKey, Transaction } from "@solana/web3.js"
import Decimal from "decimal.js"

export type SolanaCluster = "mainnet" | "devnet"

/** Canonical native USDC mint on Solana mainnet (Circle). */
export const USDC_MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

/** Circle test USDC mint on Solana devnet. */
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

let appKitSingleton: AppKit | null = null

export const readReownProjectId = (): string | null => {
  const projectId = import.meta.env.VITE_REOWN_PROJECT_ID?.trim()
  return projectId && projectId.length > 0 ? projectId : null
}

export const reownNetworkForSolanaCluster = (cluster: SolanaCluster) =>
  cluster === "devnet" ? solanaDevnet : solana

/**
 * Single shared AppKit instance for the demo (and for copy-paste reuse).
 * Pass the returned modal into RPC / send helpers.
 */
export const getOrCreateSolanaAppKit = (): AppKit | null => {
  if (appKitSingleton) {
    return appKitSingleton
  }

  const projectId = readReownProjectId()
  if (!projectId) {
    return null
  }

  appKitSingleton = createAppKit({
    adapters: [new SolanaAdapter()],
    networks: [solana, solanaDevnet],
    projectId,
    metadata: {
      name: "Moneymentum",
      description: "Moneymentum Solana USDC demo",
      url: typeof window !== "undefined" ? window.location.origin : "",
      icons:
        typeof window !== "undefined"
          ? [`${window.location.origin}/favicon.ico`]
          : [],
    },
    features: {
      analytics: false,
    },
  })

  return appKitSingleton
}

export const usdcMintAddressForCluster = (cluster: SolanaCluster): string =>
  cluster === "devnet" ? USDC_DEVNET_MINT : USDC_MAINNET_MINT

/**
 * RPC Connection for the given cluster. Resolves RPC from the same Reown network
 * object as mint selection (`reownNetworkForSolanaCluster`), not from whatever
 * `getCaipNetwork` happens to return if UI and AppKit are out of sync.
 */
export const buildSolanaRpcConnection = (
  modal: AppKit,
  projectId: string,
  cluster: SolanaCluster,
): Connection | null => {
  const chain = reownNetworkForSolanaCluster(cluster)
  const active = modal.getCaipNetwork("solana")

  if (active && active.id !== chain.id) {
    throw new Error(
      "AppKit Solana network does not match the selected cluster. Switch cluster and try again.",
    )
  }

  const rawRpc = chain.rpcUrls.default.http[0]

  let rpcUrl: string
  try {
    const parsed = new URL(rawRpc)
    if (parsed.searchParams.has("projectId")) {
      rpcUrl = parsed.toString()
    } else {
      rpcUrl = SolHelpersUtil.detectRpcUrl(chain, projectId) ?? rawRpc
    }
  } catch {
    rpcUrl = SolHelpersUtil.detectRpcUrl(chain, projectId) ?? rawRpc
  }

  if (!rpcUrl || rpcUrl.length === 0) {
    return null
  }

  return new Connection(rpcUrl, "confirmed")
}

export const solscanTransactionUrl = (
  cluster: SolanaCluster,
  signature: string,
): string => {
  const base = `https://solscan.io/tx/${signature}`
  return cluster === "devnet" ? `${base}?cluster=devnet` : base
}

type AppKitAccountState = {
  address?: unknown
  allAccounts?: unknown
  isConnected?: unknown
}

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  candidate !== null && typeof candidate === "object"

/**
 * Reads the Solana address from AppKit `subscribeAccount` payloads.
 */
export const readSolanaAddressFromAccountState = (
  accountState: unknown,
): string | null => {
  if (!isRecord(accountState)) {
    return null
  }

  const { address, allAccounts } = accountState as AppKitAccountState
  if (typeof address === "string" && address.length > 0) {
    return address
  }

  if (!Array.isArray(allAccounts)) {
    return null
  }

  for (const entry of allAccounts) {
    if (!isRecord(entry)) {
      continue
    }

    if (entry["namespace"] !== "solana") {
      continue
    }

    const candidateAddress = entry["address"]
    if (typeof candidateAddress === "string" && candidateAddress.length > 0) {
      return candidateAddress
    }
  }

  return null
}

export const readSolanaWalletConnectedFromAccountState = (
  accountState: unknown,
): boolean => {
  if (!isRecord(accountState)) {
    return false
  }

  return (
    typeof accountState["isConnected"] === "boolean" &&
    accountState["isConnected"]
  )
}

/**
 * Builds SPL transfer (USDC) from the connected wallet to `recipientAddress`.
 * Creates recipient ATA idempotently when missing. Uses on-chain mint decimals.
 */
export const sendUsdcTransfer = async (params: {
  modal: AppKit
  projectId: string
  cluster: SolanaCluster
  senderAddress: string
  recipientAddress: string
  usdcUiAmount: string
}): Promise<string> => {
  const { modal, projectId, senderAddress, recipientAddress, usdcUiAmount } =
    params

  const trimmedRecipient = recipientAddress.trim()
  if (trimmedRecipient.length === 0) {
    throw new Error("Recipient address is required.")
  }

  const mintAddress = usdcMintAddressForCluster(params.cluster)

  const connection = buildSolanaRpcConnection(modal, projectId, params.cluster)
  if (!connection) {
    throw new Error("Solana RPC URL unavailable for this network.")
  }

  const provider = modal.getProvider<Provider>("solana")
  if (!provider?.sendTransaction) {
    throw new Error(
      "Solana wallet provider not available. Connect a wallet first.",
    )
  }

  const ownerPubkey = new PublicKey(senderAddress)
  const mintPubkey = new PublicKey(mintAddress)
  const recipientOwnerPubkey = new PublicKey(trimmedRecipient)

  const mintInfo = await getMint(connection, mintPubkey)
  const rawAmount = BigInt(
    new Decimal(usdcUiAmount.trim())
      .mul(new Decimal(10).pow(mintInfo.decimals))
      .trunc()
      .toFixed(0),
  )

  if (rawAmount <= 0n) {
    throw new Error("USDC amount must be greater than zero.")
  }

  const sourceAta = getAssociatedTokenAddressSync(mintPubkey, ownerPubkey)
  const destinationAta = getAssociatedTokenAddressSync(
    mintPubkey,
    recipientOwnerPubkey,
  )

  try {
    const sourceAccount = await getAccount(connection, sourceAta)
    if (sourceAccount.amount < rawAmount) {
      throw new Error("USDC balance is too low for this transfer.")
    }
  } catch (error) {
    if (error instanceof TokenAccountNotFoundError) {
      throw new Error(
        "No USDC token account for this mint on the connected wallet. Fund the ATA first.",
      )
    }

    throw error
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("finalized")

  const transaction = new Transaction()
  transaction.feePayer = ownerPubkey
  transaction.recentBlockhash = blockhash

  const destinationInfo = await connection.getAccountInfo(destinationAta)
  if (!destinationInfo) {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstructionWithDerivation(
        ownerPubkey,
        recipientOwnerPubkey,
        mintPubkey,
      ),
    )
  }

  transaction.add(
    createTransferInstruction(
      sourceAta,
      destinationAta,
      ownerPubkey,
      rawAmount,
    ),
  )

  const signature = await provider.sendTransaction(transaction, connection)
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    "confirmed",
  )

  if (confirmation.value.err) {
    throw new Error(
      `Transaction finalized with error: ${JSON.stringify(confirmation.value.err)}`,
    )
  }

  return signature
}
