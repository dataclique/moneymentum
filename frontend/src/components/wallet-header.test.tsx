import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import { WalletHeader } from "./wallet-header"
import { WalletProvider } from "@/contexts/WalletProvider"
import { NetworkProvider } from "@/contexts/NetworkContext"

const mockSwitchNetworkMutate = vi.fn()
const mockSwitchNetworkMutateAsync = vi.fn()
const mockUseWalletSettings = vi.fn()

vi.mock("@/hooks/useTrading", () => ({
  useWalletSettings: () => mockUseWalletSettings(),
  useSwitchNetwork: vi.fn(() => ({
    mutate: mockSwitchNetworkMutate,
    mutateAsync: mockSwitchNetworkMutateAsync,
    isPending: false,
  })),
}))

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock("@/services/hyperliquid-client", () => ({
  HyperliquidClient: class MockHyperliquidClient {
    getBalance = vi.fn()
    getCurrentPositions = vi.fn()
    listPerpTickers = vi.fn()
    getLeverageLimits = vi.fn()
    rebalancePositions = vi.fn()
    getNetworkMode = vi.fn()
    getWalletAddress = vi.fn()
  },
}))

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <NetworkProvider>{children}</NetworkProvider>
      </WalletProvider>
    </QueryClientProvider>
  )
}

describe("WalletHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockUseWalletSettings.mockReturnValue({
      data: null,
      isConnected: false,
    })
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe("display state", () => {
    it("shows 'No wallet configured' when not connected", async () => {
      render(<WalletHeader />, { wrapper: createWrapper() })

      expect(screen.getByText("No wallet configured")).toBeInTheDocument()
    })

    it("shows formatted account address when connected", async () => {
      mockUseWalletSettings.mockReturnValue({
        data: {
          accountAddress: "0x1234567890abcdef1234567890abcdef12345678",
          isTestnet: true,
        },
        isConnected: true,
      })

      render(<WalletHeader />, { wrapper: createWrapper() })

      expect(screen.getByText("0x1234...5678")).toBeInTheDocument()
    })

    it("shows testnet toggle label", () => {
      render(<WalletHeader />, { wrapper: createWrapper() })

      expect(screen.getByText("Testnet")).toBeInTheDocument()
    })
  })

  describe("testnet switch", () => {
    it("is disabled when wallet is not connected", () => {
      render(<WalletHeader />, { wrapper: createWrapper() })

      const toggle = screen.getByRole("switch")
      expect(toggle).toBeDisabled()
    })

    it("is enabled when wallet is connected", async () => {
      mockUseWalletSettings.mockReturnValue({
        data: {
          accountAddress: "0xTestAccountAddress",
          isTestnet: true,
        },
        isConnected: true,
      })

      render(<WalletHeader />, { wrapper: createWrapper() })

      const toggle = screen.getByRole("switch")
      expect(toggle).not.toBeDisabled()
    })
  })

  describe("wallet configuration dialog", () => {
    it("opens dialog when clicking 'No wallet configured'", async () => {
      const user = userEvent.setup()
      render(<WalletHeader />, { wrapper: createWrapper() })

      const walletButton = screen.getByText("No wallet configured")
      await user.click(walletButton)

      expect(screen.getByText("Connect Wallet")).toBeInTheDocument()
      expect(
        screen.getByText(
          "Enter your Hyperliquid API wallet credentials to connect.",
        ),
      ).toBeInTheDocument()
    })

    it("shows all credential input fields when not connected", async () => {
      const user = userEvent.setup()
      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("No wallet configured"))

      expect(screen.getByLabelText("Account Address")).toBeInTheDocument()
      expect(screen.getByLabelText("API Wallet Address")).toBeInTheDocument()
      expect(screen.getByLabelText("API Private Key")).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument()
    })

    it("shows optional vault address field", async () => {
      const user = userEvent.setup()
      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("No wallet configured"))

      expect(
        screen.getByLabelText("Vault Address (Optional)"),
      ).toBeInTheDocument()
    })

    it("shows error toast when trying to connect with empty required fields", async () => {
      const user = userEvent.setup()
      const { toast } = await import("sonner")
      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("No wallet configured"))
      await user.click(screen.getByRole("button", { name: "Connect" }))

      expect(toast.error).toHaveBeenCalledWith(
        "Please enter account address, API wallet address, and private key",
      )
    })

    it("connects wallet when valid credentials are provided", async () => {
      const user = userEvent.setup()
      const { toast } = await import("sonner")
      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("No wallet configured"))

      const accountAddressInput = screen.getByLabelText("Account Address")
      const apiWalletAddressInput = screen.getByLabelText("API Wallet Address")
      const privateKeyInput = screen.getByLabelText("API Private Key")

      await user.type(accountAddressInput, "0xMyAccountAddress")
      await user.type(apiWalletAddressInput, "0xMyApiWalletAddress")
      await user.type(privateKeyInput, "0xMyPrivateKey")
      await user.click(screen.getByRole("button", { name: "Connect" }))

      expect(toast.success).toHaveBeenCalledWith("Wallet connected")

      const stored = localStorage.getItem("hyperliquid-wallet")
      expect(stored).not.toBeNull()
      expect(JSON.parse(stored ?? "{}")).toEqual({
        accountAddress: "0xMyAccountAddress",
        apiWalletAddress: "0xMyApiWalletAddress",
        privateKey: "0xMyPrivateKey",
      })
    }, 15000)

    it("stores vault address when provided", async () => {
      const user = userEvent.setup()
      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("No wallet configured"))

      const accountAddressInput = screen.getByLabelText("Account Address")
      const apiWalletAddressInput = screen.getByLabelText("API Wallet Address")
      const privateKeyInput = screen.getByLabelText("API Private Key")
      const vaultAddressInput = screen.getByLabelText(
        "Vault Address (Optional)",
      )

      await user.type(accountAddressInput, "0xMyAccountAddress")
      await user.type(apiWalletAddressInput, "0xMyApiWalletAddress")
      await user.type(privateKeyInput, "0xMyPrivateKey")
      await user.type(vaultAddressInput, "0xMyVaultAddress")
      await user.click(screen.getByRole("button", { name: "Connect" }))

      const stored = localStorage.getItem("hyperliquid-wallet")
      expect(stored).not.toBeNull()
      expect(JSON.parse(stored ?? "{}")).toEqual({
        accountAddress: "0xMyAccountAddress",
        apiWalletAddress: "0xMyApiWalletAddress",
        privateKey: "0xMyPrivateKey",
        vaultAddress: "0xMyVaultAddress",
      })
    }, 15000)

    it("connects without vault address when not provided", async () => {
      const user = userEvent.setup()
      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("No wallet configured"))

      const accountAddressInput = screen.getByLabelText("Account Address")
      const apiWalletAddressInput = screen.getByLabelText("API Wallet Address")
      const privateKeyInput = screen.getByLabelText("API Private Key")

      await user.type(accountAddressInput, "0xMyAccountAddress")
      await user.type(apiWalletAddressInput, "0xMyApiWalletAddress")
      await user.type(privateKeyInput, "0xMyPrivateKey")
      await user.click(screen.getByRole("button", { name: "Connect" }))

      const stored = localStorage.getItem("hyperliquid-wallet")
      expect(stored).not.toBeNull()
      const parsed = JSON.parse(stored ?? "{}")
      expect(parsed.vaultAddress).toBeUndefined()
    })

    it("closes dialog after successful connection", async () => {
      const user = userEvent.setup()
      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("No wallet configured"))

      const accountAddressInput = screen.getByLabelText("Account Address")
      const apiWalletAddressInput = screen.getByLabelText("API Wallet Address")
      const privateKeyInput = screen.getByLabelText("API Private Key")

      await user.type(accountAddressInput, "0xMyAccountAddress")
      await user.type(apiWalletAddressInput, "0xMyApiWalletAddress")
      await user.type(privateKeyInput, "0xMyPrivateKey")
      await user.click(screen.getByRole("button", { name: "Connect" }))

      await waitFor(() => {
        expect(screen.queryByText("Connect Wallet")).not.toBeInTheDocument()
      })
    })

    it("clears input fields after successful connection", async () => {
      const user = userEvent.setup()
      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("No wallet configured"))

      const accountAddressInput = screen.getByLabelText("Account Address")
      const apiWalletAddressInput = screen.getByLabelText("API Wallet Address")
      const privateKeyInput = screen.getByLabelText("API Private Key")

      await user.type(accountAddressInput, "0xMyAccountAddress")
      await user.type(apiWalletAddressInput, "0xMyApiWalletAddress")
      await user.type(privateKeyInput, "0xMyPrivateKey")
      await user.click(screen.getByRole("button", { name: "Connect" }))

      // Re-open dialog - the inputs should be empty
      await user.click(screen.getByText("No wallet configured"))

      const newAccountAddressInput = screen.getByLabelText("Account Address")
      const newApiWalletAddressInput =
        screen.getByLabelText("API Wallet Address")
      const newPrivateKeyInput = screen.getByLabelText("API Private Key")

      expect(newAccountAddressInput).toHaveValue("")
      expect(newApiWalletAddressInput).toHaveValue("")
      expect(newPrivateKeyInput).toHaveValue("")
    })

    it("auto-opens dialog when autoOpen prop is true and not connected", async () => {
      render(<WalletHeader autoOpen />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText("Connect Wallet")).toBeInTheDocument()
      })
    })

    it("does not auto-open dialog when connected even with autoOpen prop", async () => {
      mockUseWalletSettings.mockReturnValue({
        data: {
          accountAddress: "0xConnectedAccountAddress",
          isTestnet: true,
        },
        isConnected: true,
      })

      render(<WalletHeader autoOpen />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.queryByText("Connect Wallet")).not.toBeInTheDocument()
      })
    })
  })

  describe("wallet disconnect", () => {
    it("shows 'Wallet Settings' title when connected", async () => {
      const user = userEvent.setup()
      mockUseWalletSettings.mockReturnValue({
        data: {
          accountAddress: "0xConnectedAccountAddress",
          isTestnet: true,
        },
        isConnected: true,
      })

      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("0xConn...ress"))

      expect(screen.getByText("Wallet Settings")).toBeInTheDocument()
      expect(
        screen.getByText(
          "Your wallet is connected. You can disconnect it below.",
        ),
      ).toBeInTheDocument()
    })

    it("shows full account address in dialog when connected", async () => {
      const user = userEvent.setup()
      mockUseWalletSettings.mockReturnValue({
        data: {
          accountAddress: "0xConnectedAccountAddress",
          isTestnet: true,
        },
        isConnected: true,
      })

      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("0xConn...ress"))

      expect(screen.getByText("0xConnectedAccountAddress")).toBeInTheDocument()
    })

    it("shows disconnect button when connected", async () => {
      const user = userEvent.setup()
      mockUseWalletSettings.mockReturnValue({
        data: {
          accountAddress: "0xConnectedAccountAddress",
          isTestnet: true,
        },
        isConnected: true,
      })

      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("0xConn...ress"))

      expect(
        screen.getByRole("button", { name: "Disconnect Wallet" }),
      ).toBeInTheDocument()
    })

    it("disconnects wallet when disconnect button is clicked", async () => {
      const user = userEvent.setup()
      const { toast } = await import("sonner")

      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xConnectedAccountAddress",
          apiWalletAddress: "0xConnectedApiWallet",
          privateKey: "0xConnectedSecret",
        }),
      )

      mockUseWalletSettings.mockReturnValue({
        data: {
          accountAddress: "0xConnectedAccountAddress",
          isTestnet: true,
        },
        isConnected: true,
      })

      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("0xConn...ress"))
      await user.click(
        screen.getByRole("button", { name: "Disconnect Wallet" }),
      )

      expect(toast.success).toHaveBeenCalledWith("Wallet disconnected")
      expect(localStorage.getItem("hyperliquid-wallet")).toBeNull()
    })

    it("closes dialog after disconnect", async () => {
      const user = userEvent.setup()
      localStorage.setItem(
        "hyperliquid-wallet",
        JSON.stringify({
          accountAddress: "0xConnectedAccountAddress",
          apiWalletAddress: "0xConnectedApiWallet",
          privateKey: "0xConnectedSecret",
        }),
      )

      mockUseWalletSettings.mockReturnValue({
        data: {
          accountAddress: "0xConnectedAccountAddress",
          isTestnet: true,
        },
        isConnected: true,
      })

      render(<WalletHeader />, { wrapper: createWrapper() })

      await user.click(screen.getByText("0xConn...ress"))
      await user.click(
        screen.getByRole("button", { name: "Disconnect Wallet" }),
      )

      await waitFor(() => {
        expect(screen.queryByText("Wallet Settings")).not.toBeInTheDocument()
      })
    })
  })

  describe("wallet button styling", () => {
    it("has hover styling to indicate clickability", () => {
      render(<WalletHeader />, { wrapper: createWrapper() })

      const walletButton = screen.getByText("No wallet configured")
      expect(walletButton).toHaveClass("cursor-pointer")
    })
  })
})
