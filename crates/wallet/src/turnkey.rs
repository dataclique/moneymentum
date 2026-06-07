use uuid::Uuid;

/// Turnkey organization identifier.
///
/// Wraps the UUID string that Turnkey uses to scope all API operations to a
/// single organization. Constructed only through [`OrganizationId::new`], so an
/// instance is always a syntactically valid UUID. Shared by every chain-specific
/// Turnkey wallet.
#[derive(Debug, Clone)]
pub struct OrganizationId(pub(crate) String);

impl OrganizationId {
    /// Parses a Turnkey organization id, rejecting anything that is not a UUID
    /// so an invalid id cannot reach an API call and fail late.
    pub fn new(id: impl Into<String>) -> Result<Self, OrganizationIdError> {
        let id = id.into();
        Uuid::parse_str(&id).map_err(|_| OrganizationIdError::NotAUuid)?;
        Ok(Self(id))
    }
}

/// Error from constructing an [`OrganizationId`].
#[derive(Debug, thiserror::Error)]
pub enum OrganizationIdError {
    #[error("organization id is not a valid UUID")]
    NotAUuid,
}

/// Turnkey wallet identifier.
///
/// Wraps the id Turnkey assigns to a wallet at creation. Unlike
/// [`OrganizationId`], a `WalletId` is produced by Turnkey rather than supplied
/// by a caller, so it is trusted output and carries no construction-time
/// validation; the newtype exists to keep wallet ids from being confused with
/// other strings as they flow through provisioning and persistence.
#[derive(Debug, Clone)]
pub struct WalletId(pub String);

impl std::fmt::Display for WalletId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn organization_id_accepts_a_valid_uuid() {
        assert!(OrganizationId::new("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn organization_id_rejects_a_non_uuid() {
        assert!(matches!(
            OrganizationId::new("not-a-uuid"),
            Err(OrganizationIdError::NotAUuid)
        ));
    }
}
