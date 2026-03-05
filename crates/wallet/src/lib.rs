#[cfg(feature = "mock")]
mod mock;
#[cfg(feature = "turnkey")]
mod turnkey;

#[cfg(feature = "mock")]
pub use mock::MockWallet;
#[cfg(feature = "turnkey")]
pub use turnkey::{TurnkeyEvmWallet, TurnkeyWalletError};

/// Domain capability for transaction signing and address retrieval.
///
/// Each implementation targets a single chain and address. A Turnkey
/// organization with EVM + Solana accounts produces two wallet instances.
///
/// Consumers constrain to their chain via associated types:
/// `W: Wallet<Address = alloy_primitives::Address>`.
#[async_trait::async_trait]
pub trait Wallet: Send + Sync {
    /// Chain-specific address type (e.g., `alloy_primitives::Address` for EVM,
    /// `solana_pubkey::Pubkey` for Solana).
    type Address: Clone + Send + Sync;

    /// Raw bytes to be signed. Implementations extract bytes via `AsRef<[u8]>`.
    /// Callers are responsible for chain-specific encoding (EIP-712, Solana
    /// serialized tx, etc.) before passing the payload.
    type Payload: AsRef<[u8]> + Send + Sync;

    /// Chain-specific signature type (e.g., `alloy_primitives::Signature`
    /// for EVM, `solana_signature::Signature` for Solana).
    type Signature: Send + Sync;

    /// Implementation-specific error (e.g., `TurnkeyWalletError`).
    type Error: std::error::Error + Send + Sync;

    /// Returns the on-chain address managed by this wallet instance.
    async fn address(&self) -> Result<Self::Address, Self::Error>;

    /// Signs the given payload and returns a chain-valid signature.
    async fn sign(&self, payload: &Self::Payload) -> Result<Self::Signature, Self::Error>;
}
