import { createSignal, onCleanup, onMount, Show } from "solid-js"

import { Switch } from "@/components/ui/switch"
import {
  getOrCreateSolanaAppKitDemo,
  readReownProjectId,
  readSolanaAddressFromAccountState,
  readSolanaWalletConnectedFromAccountState,
  reownNetworkForSolanaCluster,
  sendUsdcTransfer,
  solscanTransactionUrl,
  type SolanaCluster,
} from "@/reown/solanaUsdc"

const SOLANA_CLUSTER_STORAGE_KEY =
  "moneymentum.reown_appkit_test.solana_cluster"

const readStoredSolanaCluster = (): SolanaCluster => {
  try {
    const raw = localStorage.getItem(SOLANA_CLUSTER_STORAGE_KEY)
    if (raw === "mainnet" || raw === "devnet") {
      return raw
    }
  } catch {
    // ignore storage errors (private mode, etc.)
  }
  return "devnet"
}

const ReownAppKitTestPage = () => {
  const [publicAddress, setPublicAddress] = createSignal<string | null>(null)
  const [walletConnected, setWalletConnected] = createSignal(false)
  const [modalReady, setModalReady] = createSignal(false)
  const [solanaCluster, setSolanaCluster] = createSignal<SolanaCluster>(
    readStoredSolanaCluster(),
  )
  const [networkSwitchPending, setNetworkSwitchPending] = createSignal(false)
  const [recipientAddressInput, setRecipientAddressInput] = createSignal(
    import.meta.env.VITE_SOLANA_TRANSFER_RECIPIENT?.trim() ?? "",
  )
  const [usdcAmountInput, setUsdcAmountInput] = createSignal("1")
  const [transactionBusy, setTransactionBusy] = createSignal(false)
  const [lastSignature, setLastSignature] = createSignal<string | null>(null)
  const [statusMessage, setStatusMessage] = createSignal(
    readReownProjectId()
      ? "Connect a wallet, pick the cluster, then send USDC."
      : "Set VITE_REOWN_PROJECT_ID in .env for this demo.",
  )

  const openSolanaConnect = async () => {
    const modal = getOrCreateSolanaAppKitDemo()
    if (!modal) {
      setStatusMessage("Set VITE_REOWN_PROJECT_ID before opening AppKit.")
      return
    }

    await modal.open({ view: "Connect", namespace: "solana" })
  }

  const disconnectSolanaWallet = async () => {
    const modal = getOrCreateSolanaAppKitDemo()
    if (!modal) {
      return
    }

    await modal.disconnect("solana")
    setPublicAddress(null)
    setWalletConnected(false)
    setStatusMessage("Wallet disconnected.")
  }

  const applySolanaCluster = async (cluster: SolanaCluster): Promise<void> => {
    const modal = getOrCreateSolanaAppKitDemo()
    if (!modal) {
      return
    }

    setNetworkSwitchPending(true)
    try {
      await modal.ready()
      await modal.switchNetwork(reownNetworkForSolanaCluster(cluster))
      setSolanaCluster(cluster)
      try {
        localStorage.setItem(SOLANA_CLUSTER_STORAGE_KEY, cluster)
      } catch {
        // ignore
      }
      setStatusMessage(
        cluster === "devnet" ? "Network: Devnet." : "Network: Mainnet.",
      )
    } catch (error) {
      console.error("Solana network switch failed:", error)
      setStatusMessage(
        "Network switch failed. Confirm the wallet supports this cluster.",
      )
    } finally {
      setNetworkSwitchPending(false)
    }
  }

  onMount(() => {
    const modal = getOrCreateSolanaAppKitDemo()
    if (!modal) {
      setModalReady(false)
      return
    }

    setModalReady(true)
    setPublicAddress(modal.getAddress("solana") ?? null)
    setWalletConnected(modal.getIsConnectedState())

    const unsubscribeAccount = modal.subscribeAccount(
      (accountState: unknown) => {
        const nextAddress = readSolanaAddressFromAccountState(accountState)
        const isConnectedFromModal =
          readSolanaWalletConnectedFromAccountState(accountState)
        const connected = isConnectedFromModal || nextAddress !== null

        setPublicAddress(nextAddress)
        setWalletConnected(connected)
      },
      "solana",
    )

    void applySolanaCluster(solanaCluster())

    onCleanup(() => {
      unsubscribeAccount()
    })
  })

  const handleSendUsdc = async () => {
    const modal = getOrCreateSolanaAppKitDemo()
    const projectId = readReownProjectId()
    const sender = publicAddress()
    const recipient = recipientAddressInput()
    const amount = usdcAmountInput()

    if (!modal || !projectId) {
      setStatusMessage("Set VITE_REOWN_PROJECT_ID in .env.")
      return
    }

    if (!sender) {
      setStatusMessage("Connect a wallet.")
      return
    }

    if (transactionBusy()) {
      return
    }

    setTransactionBusy(true)
    setLastSignature(null)
    try {
      setStatusMessage("Processing: sign in the wallet, then confirming...")
      const signature = await sendUsdcTransfer({
        modal,
        projectId,
        cluster: solanaCluster(),
        senderAddress: sender,
        recipientAddress: recipient,
        usdcUiAmount: amount,
      })
      setLastSignature(signature)
      setStatusMessage("USDC transfer confirmed.")
    } catch (error) {
      console.error("USDC transfer failed:", error)
      setStatusMessage(
        error instanceof Error ? error.message : "USDC transfer failed.",
      )
    } finally {
      setTransactionBusy(false)
    }
  }

  const sendButtonDisabled = () => transactionBusy()

  return (
    <main class="flex h-full items-center justify-center bg-background p-6 text-foreground">
      <section class="flex w-full max-w-xl flex-col gap-5 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div class="flex flex-col gap-1">
          <p class="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Demo
          </p>
          <h1 class="text-xl font-semibold">Solana USDC (Reown AppKit)</h1>
          <p class="text-sm text-muted-foreground">
            Connect a wallet, choose mainnet or devnet, enter recipient and USDC
            amount. Reusable helpers live in{" "}
            <code class="rounded bg-muted px-1 py-0.5 text-xs">
              src/reown/solanaUsdc.ts
            </code>
            .
          </p>
        </div>

        <div class="rounded-md border border-border bg-background p-3">
          <div class="text-xs uppercase tracking-[0.16em] text-muted-foreground">
            Your address
          </div>
          <div class="mt-1 break-all font-mono text-sm">
            {publicAddress() ?? "Not connected"}
          </div>
        </div>

        <div class="flex flex-col gap-2 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
          <span class="text-sm text-muted-foreground">Cluster</span>
          <div class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground">Mainnet</span>
            <Switch
              checked={solanaCluster() === "devnet"}
              disabled={!modalReady() || networkSwitchPending()}
              onChange={checked => {
                void applySolanaCluster(checked ? "devnet" : "mainnet")
              }}
            />
            <span class="text-xs text-muted-foreground">Devnet</span>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!modalReady()}
            onClick={() => void openSolanaConnect()}
            class="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Connect
          </button>
          <Show when={walletConnected()}>
            <button
              type="button"
              onClick={() => void disconnectSolanaWallet()}
              class="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              Disconnect
            </button>
          </Show>
        </div>

        <Show when={walletConnected() && modalReady()}>
          <div class="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted-foreground">Recipient</span>
              <input
                type="text"
                value={recipientAddressInput()}
                onInput={event =>
                  setRecipientAddressInput(event.currentTarget.value)
                }
                placeholder="Solana address"
                class="rounded-md border border-border bg-card px-2 py-2 font-mono text-xs"
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted-foreground">Amount (USDC)</span>
              <input
                type="text"
                inputmode="decimal"
                value={usdcAmountInput()}
                onInput={event => setUsdcAmountInput(event.currentTarget.value)}
                class="w-36 rounded-md border border-border bg-card px-2 py-2 font-mono text-xs"
              />
            </label>
            <button
              type="button"
              disabled={sendButtonDisabled()}
              onClick={() => void handleSendUsdc()}
              class="w-fit rounded-md border border-primary bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Send USDC
            </button>
            <Show when={transactionBusy()}>
              <p class="text-sm text-muted-foreground">Processing...</p>
            </Show>
            <Show when={lastSignature()}>
              {signature => (
                <div class="text-xs">
                  <div class="font-mono break-all">{signature()}</div>
                  <a
                    class="mt-1 inline-block text-primary underline"
                    href={solscanTransactionUrl(solanaCluster(), signature())}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Solscan
                  </a>
                </div>
              )}
            </Show>
          </div>
        </Show>

        <p class="text-sm text-muted-foreground">{statusMessage()}</p>
      </section>
    </main>
  )
}

export default ReownAppKitTestPage
