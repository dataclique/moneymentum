use std::num::ParseIntError;

use alloy_primitives::hex::FromHex;
use alloy_primitives::{Address, B256, Signature, hex, normalize_v};
use tracing::debug;
use turnkey_api_key_stamper::Stamp;
use turnkey_client::generated::immutable::activity::v1::SignRawPayloadIntentV2;
use turnkey_client::generated::immutable::common::v1::{HashFunction, PayloadEncoding};
use turnkey_client::{TurnkeyClient, TurnkeyClientError};

use crate::Wallet;
use crate::turnkey::OrganizationId;

/// Errors from Turnkey EVM wallet operations.
#[derive(Debug, thiserror::Error)]
pub enum TurnkeyEvmWalletError {
    #[error(transparent)]
    Turnkey(#[from] TurnkeyClientError),
    #[error(transparent)]
    Hex(#[from] hex::FromHexError),
    #[error(transparent)]
    ParseInt(#[from] ParseIntError),
    #[error("invalid recovery id: {0}")]
    RecoveryId(u64),
}

/// EVM wallet backed by Turnkey's TEE-secured signing.
///
/// One instance = one EVM address. Construct via [`TurnkeyEvmWallet::new`]. The
/// payload is a pre-hashed 32-byte digest (callers apply keccak256 first), so
/// Turnkey signs it with no further hashing.
pub struct TurnkeyEvmWallet<S: Stamp> {
    client: TurnkeyClient<S>,
    organization_id: OrganizationId,
    account: Address,
}

impl<S: Stamp> TurnkeyEvmWallet<S> {
    /// Creates a wallet bound to a specific Turnkey organization and EVM account
    /// address.
    pub fn new(
        client: TurnkeyClient<S>,
        organization_id: OrganizationId,
        account: Address,
    ) -> Self {
        Self {
            client,
            organization_id,
            account,
        }
    }
}

#[async_trait::async_trait]
impl<S: Stamp + Send + Sync> Wallet for TurnkeyEvmWallet<S> {
    type Address = Address;
    /// Pre-hashed 32-byte digest. Callers hash with keccak256 before passing.
    type Payload = B256;
    type Signature = Signature;
    type Error = TurnkeyEvmWalletError;

    async fn address(&self) -> Result<Self::Address, Self::Error> {
        Ok(self.account)
    }

    async fn sign(&self, payload: &Self::Payload) -> Result<Self::Signature, Self::Error> {
        let result = self
            .client
            .sign_raw_payload(
                self.organization_id.0.clone(),
                self.client.current_timestamp(),
                SignRawPayloadIntentV2 {
                    sign_with: self.account.to_checksum(None),
                    payload: hex::encode_prefixed(payload),
                    encoding: PayloadEncoding::Hexadecimal,
                    hash_function: HashFunction::NoOp,
                },
            )
            .await?;

        let signature = parse_signature(&result.result.r, &result.result.s, &result.result.v)?;
        debug!(account = %self.account, "evm payload signed via turnkey");
        Ok(signature)
    }
}

/// Reassembles an EVM signature from Turnkey's hex-encoded `r`, `s`, and `v`
/// components, normalizing the recovery id to a parity bit.
fn parse_signature(
    r_hex: &str,
    s_hex: &str,
    v_hex: &str,
) -> Result<Signature, TurnkeyEvmWalletError> {
    let r = B256::from_hex(r_hex)?;
    let s = B256::from_hex(s_hex)?;

    let v_raw = u64::from_str_radix(v_hex.strip_prefix("0x").unwrap_or(v_hex), 16)?;
    let parity = normalize_v(v_raw).ok_or(TurnkeyEvmWalletError::RecoveryId(v_raw))?;

    Ok(Signature::from_scalars_and_parity(r, s, parity))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_signature_valid_with_raw_parity() {
        let r = "0x".to_owned() + &"ab".repeat(32);
        let s = "0x".to_owned() + &"cd".repeat(32);

        let even = parse_signature(&r, &s, "00");
        assert!(even.is_ok_and(|sig| !sig.v()));

        let odd = parse_signature(&r, &s, "01");
        assert!(odd.is_ok_and(|sig| sig.v()));
    }

    #[test]
    fn parse_signature_valid_with_legacy_parity() {
        let r = "0x".to_owned() + &"ab".repeat(32);
        let s = "0x".to_owned() + &"cd".repeat(32);

        let even = parse_signature(&r, &s, "1b");
        assert!(even.is_ok_and(|sig| !sig.v()));

        let odd = parse_signature(&r, &s, "1c");
        assert!(odd.is_ok_and(|sig| sig.v()));
    }

    #[test]
    fn parse_signature_invalid_hex() {
        let valid = "0x".to_owned() + &"aa".repeat(32);
        assert!(matches!(
            parse_signature("0xZZZZ", &valid, "00"),
            Err(TurnkeyEvmWalletError::Hex(_))
        ));
    }

    #[test]
    fn parse_signature_invalid_v() {
        let r = "0x".to_owned() + &"aa".repeat(32);
        let s = "0x".to_owned() + &"bb".repeat(32);

        assert!(matches!(
            parse_signature(&r, &s, "02"),
            Err(TurnkeyEvmWalletError::RecoveryId(2))
        ));
        assert!(matches!(
            parse_signature(&r, &s, "zz"),
            Err(TurnkeyEvmWalletError::ParseInt(_))
        ));
    }
}
