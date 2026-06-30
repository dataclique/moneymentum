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
                self.organization_id.to_string(),
                self.client.current_timestamp(),
                SignRawPayloadIntentV2 {
                    sign_with: self.account.to_checksum(None),
                    payload: crate::hex_prefixed(payload),
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

    use tracing_test::traced_test;
    use turnkey_client::TurnkeyP256ApiKey;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

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

    #[traced_test]
    #[tokio::test]
    async fn sign_returns_the_turnkey_signature_and_logs_completion() {
        let r = "ab".repeat(32);
        let s = "cd".repeat(32);
        let expected = parse_signature(&r, &s, "1b").expect("valid signature");

        let account = Address::from([0x42u8; 20]);
        let payload = B256::from([0x11u8; 32]);

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/public/v1/submit/sign_raw_payload"))
            .and(body_partial_json(serde_json::json!({
                "parameters": {
                    "signWith": account.to_checksum(None),
                    "payload": hex::encode_prefixed(payload),
                    "encoding": "PAYLOAD_ENCODING_HEXADECIMAL",
                    "hashFunction": "HASH_FUNCTION_NO_OP"
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "activity": {
                    "type": "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
                    "status": "ACTIVITY_STATUS_COMPLETED",
                    "id": "01890000-0000-7000-8000-000000000002",
                    "organizationId": "550e8400-e29b-41d4-a716-446655440000",
                    "fingerprint": "fp",
                    "result": { "signRawPayloadResult": { "r": r, "s": s, "v": "1b" } }
                }
            })))
            .mount(&server)
            .await;
        let client = TurnkeyClient::<TurnkeyP256ApiKey>::builder()
            .api_key(TurnkeyP256ApiKey::generate())
            .base_url(server.uri())
            .build()
            .expect("client builds");

        let organization_id =
            OrganizationId::new("550e8400-e29b-41d4-a716-446655440000").expect("valid uuid");
        let wallet = TurnkeyEvmWallet::new(client, organization_id, account);

        let signature = wallet.sign(&payload).await;

        assert_eq!(signature.ok(), Some(expected));
        assert!(logs_contain("evm payload signed via turnkey"));
    }
}
