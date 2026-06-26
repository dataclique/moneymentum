use std::str::FromStr;

use solana_pubkey::Pubkey;
use solana_signature::Signature;
use tracing::debug;
use turnkey_api_key_stamper::Stamp;
use turnkey_client::generated::immutable::activity::v1::{
    CreateWalletIntent, SignRawPayloadIntentV2, WalletAccountParams,
};
use turnkey_client::generated::immutable::common::v1::{
    AddressFormat, Curve, HashFunction, PathFormat, PayloadEncoding,
};
use turnkey_client::{TurnkeyClient, TurnkeyClientError};

use crate::Wallet;
use crate::turnkey::{OrganizationId, WalletId};

/// Errors from Turnkey Solana wallet operations.
#[derive(Debug, thiserror::Error)]
pub enum TurnkeySolanaWalletError {
    #[error(transparent)]
    Turnkey(#[from] TurnkeyClientError),
    #[error(transparent)]
    Hex(#[from] hex::FromHexError),
    #[error("expected a 64-byte ed25519 signature, got {0} bytes")]
    SignatureLength(usize),
    #[error("expected ed25519 scalar {component} to be 32 bytes, got {len} bytes")]
    ScalarLength { component: &'static str, len: usize },
    #[error("turnkey returned no address for the provisioned wallet")]
    NoAddress,
    #[error(transparent)]
    PubkeyParse(#[from] solana_pubkey::ParsePubkeyError),
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
    type Error = TurnkeySolanaWalletError;

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
                    sign_with: self.account.to_string(),
                    payload: format!("0x{}", hex::encode(payload)),
                    encoding: PayloadEncoding::Hexadecimal,
                    hash_function: HashFunction::NotApplicable,
                },
            )
            .await?;

        let signature = parse_signature(&result.result.r, &result.result.s)?;
        debug!(account = %self.account, "solana payload signed via turnkey");
        Ok(signature)
    }
}

/// A Solana wallet provisioned in a Turnkey organization.
pub struct ProvisionedSolanaWallet {
    /// Turnkey's identifier for the created wallet.
    pub wallet_id: WalletId,
    /// The wallet's on-chain Solana address.
    pub address: Pubkey,
}

/// Provisions a fresh Solana wallet in the given Turnkey organization.
///
/// The wallet holds a single ed25519 account derived at the standard Solana
/// BIP44 path. Returns Turnkey's wallet id and the on-chain address, which can
/// then back a [`TurnkeySolanaWallet`] for signing.
pub async fn provision_solana_wallet<S: Stamp + Send + Sync>(
    client: &TurnkeyClient<S>,
    organization_id: &OrganizationId,
    wallet_name: impl Into<String> + Send,
) -> Result<ProvisionedSolanaWallet, TurnkeySolanaWalletError> {
    let result = client
        .create_wallet(
            organization_id.to_string(),
            client.current_timestamp(),
            CreateWalletIntent {
                wallet_name: wallet_name.into(),
                accounts: vec![WalletAccountParams {
                    curve: Curve::Ed25519,
                    path_format: PathFormat::Bip32,
                    path: "m/44'/501'/0'/0'".to_owned(),
                    address_format: AddressFormat::Solana,
                }],
                mnemonic_length: None,
            },
        )
        .await?;

    let wallet = ProvisionedSolanaWallet {
        wallet_id: WalletId::new(result.result.wallet_id),
        address: first_solana_address(result.result.addresses)?,
    };
    debug!(
        wallet_id = %wallet.wallet_id,
        address = %wallet.address,
        "provisioned solana wallet via turnkey"
    );
    Ok(wallet)
}

/// Joins Turnkey's hex-encoded `r` and `s` scalars into a 64-byte ed25519
/// Solana signature.
fn parse_signature(r_hex: &str, s_hex: &str) -> Result<Signature, TurnkeySolanaWalletError> {
    let mut bytes = decode_scalar("r", r_hex)?;
    bytes.extend_from_slice(&decode_scalar("s", s_hex)?);

    let signature: [u8; 64] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| TurnkeySolanaWalletError::SignatureLength(bytes.len()))?;

    Ok(Signature::from(signature))
}

/// Decodes a single hex-encoded ed25519 scalar and enforces that it is exactly
/// 32 bytes, so a malformed split (e.g. 31 + 33) cannot pass the combined
/// 64-byte check and produce a misaligned signature.
fn decode_scalar(
    component: &'static str,
    scalar_hex: &str,
) -> Result<Vec<u8>, TurnkeySolanaWalletError> {
    let scalar = hex::decode(scalar_hex.strip_prefix("0x").unwrap_or(scalar_hex))?;

    if scalar.len() != 32 {
        return Err(TurnkeySolanaWalletError::ScalarLength {
            component,
            len: scalar.len(),
        });
    }

    Ok(scalar)
}

/// Parses the first address Turnkey returned for a provisioned wallet as a
/// Solana pubkey.
fn first_solana_address(addresses: Vec<String>) -> Result<Pubkey, TurnkeySolanaWalletError> {
    let address = addresses
        .into_iter()
        .next()
        .ok_or(TurnkeySolanaWalletError::NoAddress)?;

    Ok(Pubkey::from_str(&address)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    use tracing_test::traced_test;
    use turnkey_client::TurnkeyP256ApiKey;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

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
            Err(TurnkeySolanaWalletError::ScalarLength {
                component: "r",
                len: 16
            })
        ));
    }

    #[test]
    fn parse_signature_rejects_a_misaligned_scalar_split() {
        // 31-byte r + 33-byte s sums to 64, so a combined-length check passes,
        // but the bytes are not a valid (32, 32) ed25519 signature.
        let r = "ab".repeat(31);
        let s = "cd".repeat(33);

        assert!(matches!(
            parse_signature(&r, &s),
            Err(TurnkeySolanaWalletError::ScalarLength {
                component: "r",
                len: 31
            })
        ));
    }

    #[test]
    fn parse_signature_rejects_invalid_hex() {
        let valid = "aa".repeat(32);

        assert!(matches!(
            parse_signature("zz", &valid),
            Err(TurnkeySolanaWalletError::Hex(_))
        ));
    }

    #[test]
    fn first_solana_address_parses_the_leading_address() {
        let address = Pubkey::default().to_string();

        assert_eq!(
            first_solana_address(vec![address]).ok(),
            Some(Pubkey::default())
        );
    }

    #[test]
    fn first_solana_address_rejects_an_empty_list() {
        assert!(matches!(
            first_solana_address(vec![]),
            Err(TurnkeySolanaWalletError::NoAddress)
        ));
    }

    #[test]
    fn first_solana_address_rejects_an_invalid_address() {
        assert!(matches!(
            first_solana_address(vec!["abc".to_owned()]),
            Err(TurnkeySolanaWalletError::PubkeyParse(_))
        ));
    }

    fn organization_id() -> OrganizationId {
        OrganizationId::new("550e8400-e29b-41d4-a716-446655440000").expect("valid uuid")
    }

    async fn turnkey_returning(
        route: &str,
        expected_request: serde_json::Value,
        body: serde_json::Value,
    ) -> (TurnkeyClient<TurnkeyP256ApiKey>, MockServer) {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(route))
            .and(body_partial_json(expected_request))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let client = TurnkeyClient::<TurnkeyP256ApiKey>::builder()
            .api_key(TurnkeyP256ApiKey::generate())
            .base_url(server.uri())
            .build()
            .expect("client builds");
        (client, server)
    }

    #[traced_test]
    #[tokio::test]
    async fn sign_returns_the_turnkey_signature_and_logs_completion() {
        let r = "ab".repeat(32);
        let s = "cd".repeat(32);
        let account = Pubkey::new_from_array([7u8; 32]);
        let message = b"a serialized solana message".to_vec();

        let (client, _server) = turnkey_returning(
            "/public/v1/submit/sign_raw_payload",
            serde_json::json!({
                "parameters": {
                    "signWith": account.to_string(),
                    "payload": format!("0x{}", hex::encode(&message)),
                    "encoding": "PAYLOAD_ENCODING_HEXADECIMAL",
                    "hashFunction": "HASH_FUNCTION_NOT_APPLICABLE"
                }
            }),
            serde_json::json!({
                "activity": {
                    "type": "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
                    "status": "ACTIVITY_STATUS_COMPLETED",
                    "id": "01890000-0000-7000-8000-000000000000",
                    "organizationId": "550e8400-e29b-41d4-a716-446655440000",
                    "fingerprint": "fp",
                    "result": { "signRawPayloadResult": { "r": r, "s": s, "v": "00" } }
                }
            }),
        )
        .await;

        let wallet = TurnkeySolanaWallet::new(client, organization_id(), account);

        let expected: [u8; 64] = std::array::from_fn(|index| if index < 32 { 0xab } else { 0xcd });
        let signature = wallet.sign(&message).await;

        assert_eq!(signature.ok(), Some(Signature::from(expected)));
        assert!(logs_contain("solana payload signed via turnkey"));
    }

    #[traced_test]
    #[tokio::test]
    async fn provision_returns_the_wallet_and_logs_completion() {
        let address = Pubkey::default().to_string();
        let (client, _server) = turnkey_returning(
            "/public/v1/submit/create_wallet",
            serde_json::json!({
                "parameters": {
                    "walletName": "test wallet",
                    "accounts": [{
                        "curve": "CURVE_ED25519",
                        "pathFormat": "PATH_FORMAT_BIP32",
                        "path": "m/44'/501'/0'/0'",
                        "addressFormat": "ADDRESS_FORMAT_SOLANA"
                    }]
                }
            }),
            serde_json::json!({
                "activity": {
                    "type": "ACTIVITY_TYPE_CREATE_WALLET",
                    "status": "ACTIVITY_STATUS_COMPLETED",
                    "id": "01890000-0000-7000-8000-000000000001",
                    "organizationId": "550e8400-e29b-41d4-a716-446655440000",
                    "fingerprint": "fp",
                    "result": {
                        "createWalletResult": {
                            "walletId": "ac651e99-579f-5c7c-8e06-16430bc25dc1",
                            "addresses": [address]
                        }
                    }
                }
            }),
        )
        .await;

        let provisioned = provision_solana_wallet(&client, &organization_id(), "test wallet")
            .await
            .expect("provisioning succeeds");

        assert_eq!(
            provisioned.wallet_id.to_string(),
            "ac651e99-579f-5c7c-8e06-16430bc25dc1"
        );
        assert_eq!(provisioned.address, Pubkey::default());
        assert!(logs_contain("provisioned solana wallet via turnkey"));
    }
}
