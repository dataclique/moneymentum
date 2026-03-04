import { useState, useEffect } from "react"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWalletSettings, useSwitchNetwork } from "@/hooks/useTrading"
import { useNetwork } from "@/hooks/useNetwork"
import { useWallet } from "@/hooks/useWallet"
import { toast } from "sonner"

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

export const WalletHeader = ({ autoOpen = false }: WalletHeaderProps) => {
  const { data: walletSettings, isConnected } = useWalletSettings()
  const switchNetworkMutation = useSwitchNetwork()
  const { isNetworkSwitching, setIsNetworkSwitching } = useNetwork()
  const { connect, disconnect } = useWallet()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [accountAddress, setAccountAddress] = useState("")
  const [apiWalletAddress, setApiWalletAddress] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [vaultAddress, setVaultAddress] = useState("")

  useEffect(() => {
    if (autoOpen && !isConnected) {
      setDialogOpen(true)
    }
  }, [autoOpen, isConnected])

  const handleTestnetToggle = async (checked: boolean) => {
    if (!isConnected) {
      toast.error("Please connect wallet first")
      return
    }

    if (switchNetworkMutation.isPending || isNetworkSwitching) {
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
      !accountAddress.trim() ||
      !apiWalletAddress.trim() ||
      !privateKey.trim()
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
      accountAddress: accountAddress.trim(),
      apiWalletAddress: apiWalletAddress.trim(),
      privateKey: privateKey.trim(),
    }

    if (vaultAddress.trim()) {
      credentials.vaultAddress = vaultAddress.trim()
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
    setMenuOpen(false)
    toast.success("Wallet disconnected")
  }

  const currentAccountAddress = walletSettings?.accountAddress ?? ""
  const currentIsTestnet = walletSettings?.isTestnet ?? true
  const isDisabled =
    !isConnected || switchNetworkMutation.isPending || isNetworkSwitching
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="flex items-center gap-4">
      {isNetworkSwitching && (
        <span className="text-[11px] text-muted-foreground">Switching…</span>
      )}

      {isConnected ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button className="cursor-pointer rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground">
              {currentAccountAddress
                ? formatPublicKey(currentAccountAddress)
                : "No wallet configured"}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-[260px] p-3 text-[11px] leading-snug"
          >
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] text-muted-foreground">Account</p>
                  <p className="break-all font-mono text-[11px]">
                    {currentAccountAddress}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => {
                    void navigator.clipboard.writeText(currentAccountAddress)
                    toast.success("Address copied")
                  }}
                >
                  Copy
                </Button>
              </div>

              <div className="h-px bg-border" />

              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Testnet</span>
                <Switch
                  checked={currentIsTestnet}
                  onCheckedChange={handleTestnetToggle}
                  disabled={isDisabled}
                />
              </div>

              <div className="h-px bg-border" />

              <Button
                type="button"
                variant="outline"
                onClick={handleDisconnect}
              >
                Disconnect
              </Button>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <button className="cursor-pointer rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground">
              {currentAccountAddress
                ? formatPublicKey(currentAccountAddress)
                : "No wallet configured"}
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect Wallet</DialogTitle>
              <DialogDescription>
                Enter your Hyperliquid API wallet credentials to connect.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 text-[12px]">
              <div className="space-y-2">
                <label htmlFor="accountAddress" className="font-medium">
                  Hyperliquid main wallet address
                </label>
                <Input
                  id="accountAddress"
                  placeholder="0x..."
                  value={accountAddress}
                  onChange={event => {
                    setAccountAddress(event.target.value)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="apiWalletAddress" className="font-medium">
                  Hyperliquid public API wallet address
                </label>
                <Input
                  id="apiWalletAddress"
                  placeholder="0x..."
                  value={apiWalletAddress}
                  onChange={event => {
                    setApiWalletAddress(event.target.value)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="privateKey" className="font-medium">
                  Hyperliquid private API wallet key
                </label>
                <Input
                  id="privateKey"
                  type="password"
                  placeholder="0x..."
                  value={privateKey}
                  onChange={event => {
                    setPrivateKey(event.target.value)
                  }}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="vaultAddress" className="font-medium">
                  Vault Address (Optional)
                </label>
                <Input
                  id="vaultAddress"
                  placeholder="0x... (leave empty for personal trading)"
                  value={vaultAddress}
                  onChange={event => {
                    setVaultAddress(event.target.value)
                  }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleConnect}>Connect</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
