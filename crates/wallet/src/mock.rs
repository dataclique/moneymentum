use std::convert::Infallible;

use tracing::debug;

use crate::Wallet;

/// Deterministic wallet for testing.
///
/// Uses a fixed 32-byte "address" derived from the seed, and signs by
/// concatenating `b"sig:"`, the wallet's address, `b":"`, and the payload, so
/// different mock wallets produce distinguishable signatures for the same
/// payload.
///
/// The "signature" is a non-cryptographic, trivially forgeable byte
/// concatenation -- it exists only to give tests a deterministic, per-wallet
/// value. Never treat a `MockWallet` signature as authentic.
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

#[async_trait::async_trait]
impl Wallet for MockWallet {
    type Address = [u8; 32];
    type Signature = Vec<u8>;
    /// The mock never fails, so its error type is uninhabitable.
    type Error = Infallible;

    async fn address(&self) -> Result<Self::Address, Self::Error> {
        debug!("mock wallet address resolved");
        Ok(self.address)
    }

    async fn sign(&self, payload: &[u8]) -> Result<Self::Signature, Self::Error> {
        let mut signature = b"sig:".to_vec();
        signature.extend_from_slice(&self.address);
        signature.push(b':');
        signature.extend_from_slice(payload);
        debug!(payload_bytes = payload.len(), "mock wallet signed payload");
        Ok(signature)
    }
}

#[cfg(test)]
mod tests {
    use tracing::Level;
    use tracing_test::traced_test;

    use super::*;
    use crate::logs_contain_at;

    fn expected_signature(seed: u8, payload: &[u8]) -> Vec<u8> {
        let mut signature = b"sig:".to_vec();
        signature.extend_from_slice(&[seed; 32]);
        signature.push(b':');
        signature.extend_from_slice(payload);
        signature
    }

    #[traced_test]
    #[tokio::test]
    async fn address_returns_seed_filled_bytes() {
        let wallet = MockWallet::new(0xAB);
        let address = wallet.address().await.ok();

        assert_eq!(address, Some([0xAB; 32]));
        assert!(logs_contain_at(
            Level::DEBUG,
            &["mock wallet address resolved"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn sign_binds_signature_to_payload_and_address() {
        let wallet = MockWallet::new(1);
        let signature = wallet.sign(b"hello").await.ok();

        assert_eq!(signature, Some(expected_signature(1, b"hello")));
        assert!(logs_contain_at(
            Level::DEBUG,
            &["mock wallet signed payload", "payload_bytes"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn sign_empty_payload() {
        let wallet = MockWallet::new(0);
        let signature = wallet.sign(b"").await.ok();

        assert_eq!(signature, Some(expected_signature(0, b"")));
        assert!(logs_contain_at(
            Level::DEBUG,
            &["mock wallet signed payload", "payload_bytes"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn different_seeds_produce_different_addresses() {
        let wallet_a = MockWallet::new(1);
        let wallet_b = MockWallet::new(2);

        let addr_a = wallet_a.address().await.ok();
        let addr_b = wallet_b.address().await.ok();

        assert_ne!(addr_a, addr_b);
        assert!(logs_contain_at(
            Level::DEBUG,
            &["mock wallet address resolved"]
        ));
    }

    #[traced_test]
    #[tokio::test]
    async fn different_seeds_produce_different_signatures() {
        let wallet_a = MockWallet::new(1);
        let wallet_b = MockWallet::new(2);

        let sig_a = wallet_a.sign(b"hello").await.ok();
        let sig_b = wallet_b.sign(b"hello").await.ok();

        assert_ne!(sig_a, sig_b);
        assert!(logs_contain_at(
            Level::DEBUG,
            &["mock wallet signed payload"]
        ));
    }
}
