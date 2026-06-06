use solana_pubkey::Pubkey;
use solana_signature::Signature;
use turnkey_api_key_stamper::Stamp;
use turnkey_client::generated::immutable::activity::v1::SignRawPayloadIntentV2;
use turnkey_client::generated::immutable::common::v1::{HashFunction, PayloadEncoding};
use turnkey_client::{TurnkeyClient, TurnkeyClientError};

use crate::Wallet;

/// Turnkey organization identifier. Wraps the UUID string that Turnkey uses to
/// scope all API operations to a single organization.
#[derive(Debug, Clone)]
pub struct OrganizationId(String);

impl OrganizationId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

/// Errors from Turnkey Solana wallet operations.
#[derive(Debug, thiserror::Error)]
pub enum TurnkeyWalletError {
    #[error(transparent)]
    Turnkey(#[from] TurnkeyClientError),
    #[error(transparent)]
    Hex(#[from] hex::FromHexError),
    #[error("expected a 64-byte ed25519 signature, got {0} bytes")]
    SignatureLength(usize),
}

/// Solana wallet backed by Turnkey's TEE-secured signing.
///
/// One instance = one Solana address. Construct via [`TurnkeySolanaWallet::new`].
/// Solana uses ed25519, which hashes internally, so payloads are signed as-is:
/// callers pass the serialized transaction message bytes with no client-side
/// digest.
pub struct TurnkeySolanaWallet<S: Stamp> {
    client: TurnkeyClient<S>,
    organization_id: OrganizationId,
    account: Pubkey,
}

impl<S: Stamp> TurnkeySolanaWallet<S> {
    /// Creates a wallet bound to a specific Turnkey organization and Solana
    /// account address.
    pub fn new(client: TurnkeyClient<S>, organization_id: OrganizationId, account: Pubkey) -> Self {
        Self {
            client,
            organization_id,
            account,
        }
    }
}

#[async_trait::async_trait]
impl<S: Stamp + Send + Sync> Wallet for TurnkeySolanaWallet<S> {
    type Address = Pubkey;
    /// Serialized Solana message bytes. ed25519 hashes internally, so the
    /// payload is signed without any client-side digest.
    type Payload = Vec<u8>;
    type Signature = Signature;
    type Error = TurnkeyWalletError;

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
                    sign_with: self.account.to_string(),
                    payload: format!("0x{}", hex::encode(payload)),
                    encoding: PayloadEncoding::Hexadecimal,
                    hash_function: HashFunction::NotApplicable,
                },
            )
            .await?;

        parse_signature(&result.result.r, &result.result.s)
    }
}

/// Joins Turnkey's hex-encoded `r` and `s` scalars into a 64-byte ed25519
/// Solana signature.
fn parse_signature(r_hex: &str, s_hex: &str) -> Result<Signature, TurnkeyWalletError> {
    let mut bytes = decode_scalar(r_hex)?;
    bytes.extend_from_slice(&decode_scalar(s_hex)?);

    let signature: [u8; 64] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| TurnkeyWalletError::SignatureLength(bytes.len()))?;

    Ok(Signature::from(signature))
}

fn decode_scalar(scalar_hex: &str) -> Result<Vec<u8>, hex::FromHexError> {
    hex::decode(scalar_hex.strip_prefix("0x").unwrap_or(scalar_hex))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_signature_joins_r_and_s() {
        let r = "ab".repeat(32);
        let s = "cd".repeat(32);

        let expected: [u8; 64] = std::array::from_fn(|index| if index < 32 { 0xab } else { 0xcd });

        assert_eq!(
            parse_signature(&r, &s).ok(),
            Some(Signature::from(expected))
        );
    }

    #[test]
    fn parse_signature_tolerates_0x_prefix() {
        let r = "0x".to_owned() + &"ab".repeat(32);
        let s = "0x".to_owned() + &"cd".repeat(32);

        let expected: [u8; 64] = std::array::from_fn(|index| if index < 32 { 0xab } else { 0xcd });

        assert_eq!(
            parse_signature(&r, &s).ok(),
            Some(Signature::from(expected))
        );
    }

    #[test]
    fn parse_signature_rejects_short_scalars() {
        let short = "ab".repeat(16);

        assert!(matches!(
            parse_signature(&short, &short),
            Err(TurnkeyWalletError::SignatureLength(32))
        ));
    }

    #[test]
    fn parse_signature_rejects_invalid_hex() {
        let valid = "aa".repeat(32);

        assert!(matches!(
            parse_signature("zz", &valid),
            Err(TurnkeyWalletError::Hex(_))
        ));
    }
}
