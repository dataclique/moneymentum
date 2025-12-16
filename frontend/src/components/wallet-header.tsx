import { Switch } from "@/components/ui/switch"
import { useQueryClient } from "@tanstack/react-query"
import {
  refreshAllData,
  useWalletSettings,
  useSwitchNetwork,
} from "@/hooks/useApi"
import { useNetwork } from "@/hooks/useNetwork"

const formatPublicKey = (key: string): string => {
  if (!key || key.length < 10) return key
  if (key.startsWith("0x")) {
    return `${key.slice(0, 6)}...${key.slice(-4)}`
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

export const WalletHeader = () => {
  const { data: walletSettings, isLoading } = useWalletSettings()
  const switchNetworkMutation = useSwitchNetwork()
  const { isNetworkSwitching, setIsNetworkSwitching } = useNetwork()
  const queryClient = useQueryClient()

  const handleTestnetToggle = async (checked: boolean) => {
    if (!walletSettings?.public_key) {
      alert("Please configure wallet in .env file first")
      return
    }

    if (switchNetworkMutation.isPending || isNetworkSwitching) {
      return
    }

    setIsNetworkSwitching(true)

    try {
      await switchNetworkMutation.mutateAsync({ is_testnet: checked })
      await refreshAllData(queryClient)
    } catch (error) {
      console.error("Failed to toggle testnet/mainnet:", error)
      alert("Failed to toggle network. Please try again.")
    } finally {
      setIsNetworkSwitching(false)
    }
  }

  const currentPublicKey = walletSettings?.public_key ?? ""
  const currentIsTestnet = walletSettings?.is_testnet ?? true
  const isDisabled =
    isLoading ||
    !walletSettings ||
    switchNetworkMutation.isPending ||
    isNetworkSwitching

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
        {isLoading
          ? "Loading..."
          : currentPublicKey
            ? formatPublicKey(currentPublicKey)
            : "No wallet configured"}
      </div>
    </div>
  )
}
