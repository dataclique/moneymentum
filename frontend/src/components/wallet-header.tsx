import { Switch } from "@/components/ui/switch"
import { useWalletSettings, useSwitchNetwork } from "@/hooks/useTrading"
import { useNetwork } from "@/hooks/useNetwork"
import { toast } from "sonner"

const formatPublicKey = (key: string): string => {
  if (!key || key.length < 10) return key
  if (key.startsWith("0x")) {
    return `${key.slice(0, 6)}...${key.slice(-4)}`
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

export const WalletHeader = () => {
  const { data: walletSettings, isConnected } = useWalletSettings()
  const switchNetworkMutation = useSwitchNetwork()
  const { isNetworkSwitching, setIsNetworkSwitching } = useNetwork()

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

  const currentPublicKey = walletSettings?.publicKey ?? ""
  const currentIsTestnet = walletSettings?.isTestnet ?? true
  const isDisabled =
    !isConnected || switchNetworkMutation.isPending || isNetworkSwitching

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

      <div className="rounded-md border border-border px-3 py-1.5 font-mono text-sm text-muted-foreground">
        {currentPublicKey
          ? formatPublicKey(currentPublicKey)
          : "No wallet configured"}
      </div>
    </div>
  )
}
