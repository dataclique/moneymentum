use crate::Wallet;

/// Deterministic wallet for testing. Uses a fixed 32-byte "address" derived
/// from the seed, and produces signatures by prepending `b"sig:"` to the
/// payload bytes.
pub struct MockWallet {
    address: [u8; 32],
}

impl MockWallet {
    /// Creates a mock wallet whose address is `[seed; 32]`.
    pub fn new(seed: u8) -> Self {
        Self {
            address: [seed; 32],
        }
    }
}

/// Mock never fails — errors are uninhabitable.
#[derive(Debug, thiserror::Error)]
pub enum MockWalletError {}

#[async_trait::async_trait]
impl Wallet for MockWallet {
    type Address = [u8; 32];
    type Payload = Vec<u8>;
    type Signature = Vec<u8>;
    type Error = MockWalletError;

    async fn address(&self) -> Result<Self::Address, Self::Error> {
        Ok(self.address)
    }

    async fn sign(&self, payload: &Self::Payload) -> Result<Self::Signature, Self::Error> {
        let mut signature = b"sig:".to_vec();
        signature.extend_from_slice(payload.as_ref());
        Ok(signature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn address_returns_seed_filled_bytes() {
        let wallet = MockWallet::new(0xAB);
        let address = wallet.address().await.ok();

        assert_eq!(address, Some([0xAB; 32]));
    }

    #[tokio::test]
    async fn sign_prepends_sig_prefix() {
        let wallet = MockWallet::new(1);
        let payload = b"hello".to_vec();
        let signature = wallet.sign(&payload).await.ok();

        assert_eq!(signature, Some(b"sig:hello".to_vec()));
    }

    #[tokio::test]
    async fn sign_empty_payload() {
        let wallet = MockWallet::new(0);
        let signature = wallet.sign(&vec![]).await.ok();

        assert_eq!(signature, Some(b"sig:".to_vec()));
    }

    #[tokio::test]
    async fn different_seeds_produce_different_addresses() {
        let wallet_a = MockWallet::new(1);
        let wallet_b = MockWallet::new(2);

        let addr_a = wallet_a.address().await.ok();
        let addr_b = wallet_b.address().await.ok();

        assert_ne!(addr_a, addr_b);
    }
}
