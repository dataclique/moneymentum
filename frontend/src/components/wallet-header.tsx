import { createSignal, createEffect, Show } from "solid-js"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useWalletSettings, useSwitchNetwork } from "@/hooks/useTrading"
import { useNetwork } from "@/hooks/useNetwork"
import { useWallet } from "@/hooks/useWallet"
import { toast } from "solid-sonner"

const formatPublicKey = (key: string): string => {
  if (!key || key.length < 10) return key
  if (key.startsWith("0x")) {
    return `${key.slice(0, 6)}...${key.slice(-4)}`
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

interface WalletHeaderProps {
  autoOpen?: boolean
}

export const WalletHeader = (props: WalletHeaderProps) => {
  const { data: walletSettings, isConnected } = useWalletSettings()
  const switchNetworkMutation = useSwitchNetwork()
  const { isNetworkSwitching, setIsNetworkSwitching } = useNetwork()
  const { connect, disconnect } = useWallet()

  const [dialogOpen, setDialogOpen] = createSignal(false)
  const [accountAddress, setAccountAddress] = createSignal("")
  const [apiWalletAddress, setApiWalletAddress] = createSignal("")
  const [privateKey, setPrivateKey] = createSignal("")
  const [vaultAddress, setVaultAddress] = createSignal("")
  const [hasAutoOpened, setHasAutoOpened] = createSignal(false)

  // Auto-open the dialog once on mount when autoOpen is true and no wallet is
  // connected. The hasAutoOpened flag prevents re-triggering on later
  // disconnects.
  createEffect(() => {
    if (props.autoOpen && !isConnected() && !hasAutoOpened()) {
      setDialogOpen(true)
      setHasAutoOpened(true)
    }
  })

  const handleTestnetToggle = async (checked: boolean) => {
    if (!isConnected()) {
      toast.error("Please connect wallet first")
      return
    }

    if (switchNetworkMutation.isPending || isNetworkSwitching()) {
      return
    }

    setIsNetworkSwitching(true)

    try {
      await switchNetworkMutation.mutateAsync(checked ? "testnet" : "mainnet")
    } catch (error) {
      console.error("Failed to toggle testnet/mainnet:", error)
      toast.error("Failed to toggle network. Please try again.")
    } finally {
      setIsNetworkSwitching(false)
    }
  }

  const handleConnect = () => {
    if (
      !accountAddress().trim() ||
      !apiWalletAddress().trim() ||
      !privateKey().trim()
    ) {
      toast.error(
        "Please enter account address, API wallet address, and private key",
      )
      return
    }

    const credentials: {
      accountAddress: string
      apiWalletAddress: string
      privateKey: string
      vaultAddress?: string
    } = {
      accountAddress: accountAddress().trim(),
      apiWalletAddress: apiWalletAddress().trim(),
      privateKey: privateKey().trim(),
    }

    if (vaultAddress().trim()) {
      credentials.vaultAddress = vaultAddress().trim()
    }

    connect(credentials)
    setDialogOpen(false)
    setAccountAddress("")
    setApiWalletAddress("")
    setPrivateKey("")
    setVaultAddress("")
    toast.success("Wallet connected")
  }

  const handleDisconnect = () => {
    disconnect()
    setDialogOpen(false)
    toast.success("Wallet disconnected")
  }

  const currentAccountAddress = () => walletSettings()?.accountAddress ?? ""
  const currentIsTestnet = () => walletSettings()?.isTestnet ?? true
  const isDisabled = () =>
    !isConnected() || switchNetworkMutation.isPending || isNetworkSwitching()

  return (
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2">
        <span class="text-sm text-muted-foreground">
          {isNetworkSwitching() ? "Switching..." : "Testnet"}
        </span>
        <Switch
          checked={currentIsTestnet()}
          onChange={handleTestnetToggle}
          disabled={isDisabled()}
        />
      </div>

      <Dialog open={dialogOpen()} onOpenChange={setDialogOpen}>
        <DialogTrigger
          as="button"
          class="cursor-pointer rounded-md border border-border px-3 py-1.5 font-mono text-sm text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground"
        >
          {currentAccountAddress()
            ? formatPublicKey(currentAccountAddress())
            : "No wallet configured"}
        </DialogTrigger>
        <Show when={dialogOpen()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {isConnected() ? "Wallet Settings" : "Connect Wallet"}
              </DialogTitle>
              <DialogDescription>
                {isConnected()
                  ? "Your wallet is connected. You can disconnect it below."
                  : "Enter your Hyperliquid API wallet credentials to connect."}
              </DialogDescription>
            </DialogHeader>

            <Show
              when={isConnected()}
              fallback={
                <>
                  <div class="space-y-4">
                    <div class="space-y-2">
                      <label for="accountAddress" class="text-sm font-medium">
                        Account Address
                      </label>
                      <Input
                        id="accountAddress"
                        placeholder="0x... (your main Hyperliquid account)"
                        value={accountAddress()}
                        onInput={event => {
                          setAccountAddress(event.currentTarget.value)
                        }}
                      />
                    </div>
                    <div class="space-y-2">
                      <label for="apiWalletAddress" class="text-sm font-medium">
                        API Wallet Address
                      </label>
                      <Input
                        id="apiWalletAddress"
                        placeholder="0x... (authorized to trade on your behalf)"
                        value={apiWalletAddress()}
                        onInput={event => {
                          setApiWalletAddress(event.currentTarget.value)
                        }}
                      />
                    </div>
                    <div class="space-y-2">
                      <label for="privateKey" class="text-sm font-medium">
                        API Private Key
                      </label>
                      <Input
                        id="privateKey"
                        type="password"
                        placeholder="Private key of the API wallet"
                        value={privateKey()}
                        onInput={event => {
                          setPrivateKey(event.currentTarget.value)
                        }}
                      />
                    </div>
                    <div class="space-y-2">
                      <label for="vaultAddress" class="text-sm font-medium">
                        Vault Address (Optional)
                      </label>
                      <Input
                        id="vaultAddress"
                        placeholder="0x... (leave empty for personal trading)"
                        value={vaultAddress()}
                        onInput={event => {
                          setVaultAddress(event.currentTarget.value)
                        }}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={handleConnect}>Connect</Button>
                  </DialogFooter>
                </>
              }
            >
              <>
                <div class="space-y-2">
                  <p class="text-sm text-muted-foreground">Account Address:</p>
                  <p class="break-all font-mono text-sm">
                    {currentAccountAddress()}
                  </p>
                </div>
                <DialogFooter>
                  <Button variant="destructive" onClick={handleDisconnect}>
                    Disconnect Wallet
                  </Button>
                </DialogFooter>
              </>
            </Show>
          </DialogContent>
        </Show>
      </Dialog>
    </div>
  )
}
