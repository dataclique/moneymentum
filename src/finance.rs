#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Symbol(String);

impl Symbol {
    pub(crate) fn from_raw(raw: &str) -> Self {
        let base = raw.split('/').next().unwrap_or(raw);
        Self(base.to_uppercase())
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn symbol_normalization_is_idempotent(base in "[A-Z]{2,5}") {
            let raw = format!("{base}/USDC:USDC");
            let first = Symbol::from_raw(&raw);
            let second = Symbol::from_raw(first.as_str());
            prop_assert_eq!(first.as_str(), second.as_str());
        }

        #[test]
        fn symbol_handles_any_base_currency(base in "[A-Za-z]{1,10}") {
            let raw = format!("{base}/USDC:USDC");
            let symbol = Symbol::from_raw(&raw);
            prop_assert_eq!(symbol.as_str(), base.to_uppercase());
        }

        #[test]
        fn symbol_output_is_always_uppercase(input in "[a-zA-Z]{1,10}") {
            let symbol = Symbol::from_raw(&input);
            prop_assert!(symbol.as_str().chars().all(char::is_uppercase));
        }
    }

    #[test]
    fn normalizes_real_ccxt_formats() {
        assert_eq!(Symbol::from_raw("FRIEND/USDC:USDC").as_str(), "FRIEND");
        assert_eq!(Symbol::from_raw("BTC/USDC:USDC").as_str(), "BTC");
        assert_eq!(Symbol::from_raw("RNDR/USDC:USDC").as_str(), "RNDR");
        assert_eq!(Symbol::from_raw("SHIA/USDC:USDC").as_str(), "SHIA");
        assert_eq!(Symbol::from_raw("kDOGS/USDC:USDC").as_str(), "KDOGS");
        assert_eq!(Symbol::from_raw("CATI/USDC:USDC").as_str(), "CATI");
    }

    #[test]
    fn handles_simple_symbol() {
        assert_eq!(Symbol::from_raw("ETH").as_str(), "ETH");
        assert_eq!(Symbol::from_raw("BTC").as_str(), "BTC");
        assert_eq!(Symbol::from_raw("KPEPE").as_str(), "KPEPE");
    }

    #[test]
    fn uppercases() {
        assert_eq!(Symbol::from_raw("btc/usdc:usdc").as_str(), "BTC");
        assert_eq!(Symbol::from_raw("kdogs").as_str(), "KDOGS");
    }
}
