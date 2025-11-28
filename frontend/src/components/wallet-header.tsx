import { useState, useEffect } from "react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useQueryClient } from "@tanstack/react-query"
import {
  refreshAllData,
  useWalletSettings,
  useSaveWalletSettings,
} from "@/hooks/useApi"
import { useNetwork } from "@/contexts/NetworkContext"

function formatPublicKey(key: string): string {
  if (!key || key.length < 10) return key
  // Format: 0xE375...FeB0 (first 4 chars after 0x, then last 4 chars)
  if (key.startsWith("0x")) {
    return `${key.slice(0, 6)}...${key.slice(-4)}`
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

export function WalletHeader() {
  const { data: walletSettings, isLoading } = useWalletSettings()
  const saveMutation = useSaveWalletSettings()
  const { isNetworkSwitching, setIsNetworkSwitching } = useNetwork()
  const queryClient = useQueryClient()
  const [isOpen, setIsOpen] = useState(false)
  const [publicKey, setPublicKey] = useState("")
  const [secretKey, setSecretKey] = useState("")

  // Initialize form when wallet settings are loaded
  useEffect(() => {
    if (walletSettings) {
      setPublicKey(walletSettings.public_key || "")
    }
  }, [walletSettings])

  const handleSave = async () => {
    if (!publicKey) {
      alert("Please fill in public key")
      return
    }
    if (!secretKey && !walletSettings?.public_key) {
      alert("Please fill in secret key")
      return
    }
    if (!secretKey) {
      alert("Please enter secret key to save settings")
      return
    }

    setIsNetworkSwitching(true)

    try {
      await saveMutation.mutateAsync({
        public_key: publicKey,
        secret_key: secretKey,
        is_testnet: walletSettings?.is_testnet ?? true,
      })
      await refreshAllData(queryClient)
      setIsOpen(false)
      setSecretKey("")
    } catch (error) {
      console.error("Failed to save wallet settings:", error)
      alert("Failed to save wallet settings. Please try again.")
    } finally {
      setIsNetworkSwitching(false)
    }
  }

  const handleTestnetToggle = async (checked: boolean) => {
    if (!walletSettings?.public_key) {
      alert("Please configure wallet settings first")
      return
    }

    if (saveMutation.isPending || isNetworkSwitching) {
      return // Prevent multiple toggles
    }

    // checked = true means switch is ON = testnet
    // checked = false means switch is OFF = mainnet
    const newIsTestnet = checked

    console.log("Network switch started:", {
      checked,
      newIsTestnet,
      currentIsTestnet: walletSettings.is_testnet,
    })
    setIsNetworkSwitching(true)

    try {
      await saveMutation.mutateAsync({
        public_key: walletSettings.public_key,
        secret_key: "", // Empty means use existing from .env
        is_testnet: newIsTestnet,
      })
      await refreshAllData(queryClient)
      console.log("Network switch mutation completed")
    } catch (error) {
      console.error("Failed to toggle testnet/mainnet:", error)
      alert("Failed to toggle network. Please try again.")
    } finally {
      setIsNetworkSwitching(false)
    }
  }

  const currentPublicKey = walletSettings?.public_key || ""
  const currentIsTestnet = walletSettings?.is_testnet ?? true
  const isDisabled =
    isLoading || !walletSettings || saveMutation.isPending || isNetworkSwitching

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {isNetworkSwitching ? "Switching..." : "Testnet"}
        </span>
        <Switch
          checked={currentIsTestnet}
          onCheckedChange={handleTestnetToggle}
          disabled={isDisabled}
        />
      </div>

      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="cursor-pointer font-mono text-sm"
            disabled={isDisabled}
          >
            {isLoading
              ? "Loading..."
              : currentPublicKey
                ? formatPublicKey(currentPublicKey)
                : "No wallet"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-96" align="end">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="public-key">Public Key</Label>
              <Input
                id="public-key"
                type="text"
                placeholder="0x..."
                value={publicKey || currentPublicKey}
                onChange={e => setPublicKey(e.target.value)}
                disabled={isDisabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="secret-key">Secret Key</Label>
              <Input
                id="secret-key"
                type="password"
                placeholder="Enter secret key"
                value={secretKey}
                onChange={e => setSecretKey(e.target.value)}
                disabled={isDisabled}
              />
            </div>
            <Button
              onClick={handleSave}
              disabled={isDisabled || !publicKey}
              className="w-full"
            >
              {saveMutation.isPending ? "Saving..." : "Save"}
            </Button>
            {!secretKey && walletSettings?.public_key && (
              <p className="text-xs text-muted-foreground">
                Enter secret key to update settings
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
