#[cfg(feature = "mock")]
mod mock;
#[cfg(feature = "turnkey")]
mod turnkey_solana;

#[cfg(feature = "mock")]
pub use mock::MockWallet;
#[cfg(feature = "turnkey")]
pub use turnkey_solana::{
    OrganizationId, ProvisionedSolanaWallet, TurnkeySolanaWallet, TurnkeyWalletError,
    provision_solana_wallet,
};

/// Domain capability for transaction signing and address retrieval.
///
/// Each implementation targets a single chain and address. A Turnkey
/// organization with Solana + EVM accounts produces two wallet instances.
///
/// Consumers constrain to their chain via associated types:
/// `W: Wallet<Address = solana_pubkey::Pubkey>`.
#[async_trait::async_trait]
pub trait Wallet: Send + Sync {
    /// Chain-specific address type (e.g., `solana_pubkey::Pubkey` for Solana,
    /// `alloy_primitives::Address` for EVM).
    type Address: Clone + Send + Sync;

    /// Raw bytes to be signed. Implementations extract bytes via `AsRef<[u8]>`.
    /// Callers are responsible for chain-specific encoding (a serialized Solana
    /// message, EIP-712, etc.) before passing the payload.
    type Payload: AsRef<[u8]> + Send + Sync;

    /// Chain-specific signature type (e.g., `solana_signature::Signature`
    /// for Solana, `alloy_primitives::Signature` for EVM).
    type Signature: Send + Sync;

    /// Implementation-specific error (e.g., `TurnkeyWalletError`).
    type Error: std::error::Error + Send + Sync;

    /// Returns the on-chain address managed by this wallet instance.
    async fn address(&self) -> Result<Self::Address, Self::Error>;

    /// Signs the given payload and returns a chain-valid signature.
    async fn sign(&self, payload: &Self::Payload) -> Result<Self::Signature, Self::Error>;
}
