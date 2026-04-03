use chrono::{DateTime, TimeZone, Utc};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeSet;
use thiserror::Error;
use url::Url;

// ─── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum DeriveError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("invalid expiry timestamp: {timestamp}")]
    InvalidExpiry { timestamp: i64 },
    #[error("api error: {message}")]
    Api { message: String },
}

// ─── Raw API DTOs ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RpcResponse<T> {
    result: T,
}

#[derive(Debug, Deserialize)]
struct OptionDetailsDto {
    option_type: String,
    strike: String,
    expiry: u64,
}

#[derive(Debug, Deserialize)]
struct InstrumentDto {
    instrument_name: String,
    is_active: bool,
    option_details: Option<OptionDetailsDto>,
}

/// Response from /public/get_tickers.
/// result is a map: instrument_name -> ticker object with single-letter keys:
///   "b" = best bid, "a" = best ask, "I" = index price
#[derive(Debug, Deserialize)]
struct TickerDto {
    /// Best bid price in USD
    #[serde(rename = "b")]
    best_bid_price: String,
    /// Best ask price in USD
    #[serde(rename = "a")]
    best_ask_price: String,
    /// Spot index price (e.g. BTC-USD)
    #[serde(rename = "I")]
    index_price: String,
}

// ─── Domain types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionKind {
    Call,
    Put,
}

impl std::fmt::Display for OptionKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OptionKind::Call => write!(f, "C"),
            OptionKind::Put => write!(f, "P"),
        }
    }
}

/// How the option relates to the current spot price.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moneyness {
    InTheMoney,
    AtTheMoney,
    OutOfTheMoney,
}

impl std::fmt::Display for Moneyness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Moneyness::InTheMoney => write!(f, "ITM"),
            Moneyness::AtTheMoney => write!(f, "ATM"),
            Moneyness::OutOfTheMoney => write!(f, "OTM"),
        }
    }
}

/// A single option with its live market data attached.
#[derive(Debug, Clone)]
pub struct OptionQuote {
    pub instrument_name: String,
    pub kind: OptionKind,
    pub strike: f64,
    pub expiry: DateTime<Utc>,
    /// Best bid in USD. `None` means no bids in the order book.
    pub bid: Option<f64>,
    /// Best ask in USD. `None` means no offers in the order book.
    pub ask: Option<f64>,
    /// Current spot price of the underlying (BTC/USD, etc.).
    pub spot_price: f64,
    pub moneyness: Moneyness,
}

impl OptionQuote {
    /// Mid-price, only meaningful when both bid and ask are present.
    pub fn mid(&self) -> Option<f64> {
        match (self.bid, self.ask) {
            (Some(b), Some(a)) => Some((b + a) / 2.0),
            _ => None,
        }
    }
}

/// The full options chain for one expiry date.
#[derive(Debug)]
pub struct ExpiryChain {
    pub expiry: DateTime<Utc>,
    /// Sorted by strike price.
    pub quotes: Vec<OptionQuote>,
}

/// A structured options chain:  expiry → strike → (call, put).
///
/// This is the main return type of [`DeriveClient::btc_options_chain`].
#[derive(Debug)]
pub struct OptionsChain {
    pub asset: String,
    /// Current BTC/USD spot price.
    pub spot_price: f64,
    /// All available expiry dates, sorted ascending.
    pub expiry_dates: Vec<DateTime<Utc>>,
    /// All available strike prices across all expiries, sorted ascending.
    pub strikes: Vec<f64>,
    /// Full flat list of quotes, useful for iteration.
    pub quotes: Vec<OptionQuote>,
}

impl OptionsChain {
    /// Return all quotes for a specific expiry.
    pub fn by_expiry(&self, expiry: &DateTime<Utc>) -> Vec<&OptionQuote> {
        self.quotes.iter().filter(|q| &q.expiry == expiry).collect()
    }

    /// Return all quotes for a specific strike.
    pub fn by_strike(&self, strike: f64) -> Vec<&OptionQuote> {
        self.quotes
            .iter()
            .filter(|q| (q.strike - strike).abs() < 0.01)
            .collect()
    }

    /// Pretty-print the chain (useful for debugging / CLI).
    pub fn print_summary(&self) {
        println!(
            "\n═══ BTC Options Chain  │  Spot: ${:.2} ═══\n",
            self.spot_price
        );
        println!("Available expiries ({}):", self.expiry_dates.len());
        for exp in &self.expiry_dates {
            println!("  • {}", exp.format("%d %b %Y %H:%M UTC"));
        }
        println!("\nAvailable strikes ({}):", self.strikes.len());
        let strike_strs: Vec<String> = self.strikes.iter().map(|s| format!("${s:.0}")).collect();
        println!("  {}", strike_strs.join("  "));

        println!("\n{:-<80}", "");
        println!(
            "{:<40} {:>8} {:>8} {:>8} {:>6}",
            "Instrument", "Bid", "Ask", "Mid", "Money"
        );
        println!("{:-<80}", "");

        for exp in &self.expiry_dates {
            println!("\n  ▶ Expiry: {}", exp.format("%d %b %Y"));
            let mut chain_quotes: Vec<&OptionQuote> = self.by_expiry(exp);
            // Sort: ascending strike, then Calls before Puts
            chain_quotes.sort_by(|a, b| {
                a.strike
                    .partial_cmp(&b.strike)
                    .unwrap()
                    .then_with(|| a.kind.to_string().cmp(&b.kind.to_string()))
            });
            for q in chain_quotes {
                let bid = q
                    .bid
                    .map(|v| format!("{v:.2}"))
                    .unwrap_or_else(|| "-".to_string());
                let ask = q
                    .ask
                    .map(|v| format!("{v:.2}"))
                    .unwrap_or_else(|| "-".to_string());
                let mid = q
                    .mid()
                    .map(|v| format!("{v:.2}"))
                    .unwrap_or_else(|| "-".to_string());
                println!(
                    "  {:<40} {:>8} {:>8} {:>8} {:>6}",
                    q.instrument_name, bid, ask, mid, q.moneyness
                );
            }
        }
        println!("{:-<80}", "");
    }
}

// ─── Moneyness helper ─────────────────────────────────────────────────────────

/// Tolerance (in %) used to classify ATM. If strike is within 0.5% of spot → ATM.
const ATM_TOLERANCE: f64 = 0.005;

fn compute_moneyness(kind: OptionKind, strike: f64, spot: f64) -> Moneyness {
    let ratio = (strike - spot).abs() / spot;
    if ratio < ATM_TOLERANCE {
        return Moneyness::AtTheMoney;
    }
    match kind {
        // Call ITM  → spot > strike  (you can buy cheaper than market)
        OptionKind::Call => {
            if spot > strike {
                Moneyness::InTheMoney
            } else {
                Moneyness::OutOfTheMoney
            }
        }
        // Put ITM   → spot < strike  (you can sell higher than market)
        OptionKind::Put => {
            if spot < strike {
                Moneyness::InTheMoney
            } else {
                Moneyness::OutOfTheMoney
            }
        }
    }
}

// ─── Parse helpers ────────────────────────────────────────────────────────────

fn parse_price(s: &str) -> Option<f64> {
    let v: f64 = s.parse().ok()?;
    // Derive returns "0" when there is no quote in the book.
    if v == 0.0 { None } else { Some(v) }
}

// ─── Client ──────────────────────────────────────────────────────────────────

pub struct DeriveClient {
    http: Client,
    base_url: Url,
}

impl DeriveClient {
    pub fn new(base_url: Url) -> Self {
        Self {
            http: Client::new(),
            base_url,
        }
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.as_str().trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    // ── Low-level: list instruments ──────────────────────────────────────────

    async fn list_active_option_instruments(
        &self,
        asset: &str,
    ) -> Result<Vec<InstrumentDto>, DeriveError> {
        let payload = json!({
            "currency": asset,
            "instrument_type": "option",
            "expired": false
        });

        let body: serde_json::Value = self
            .http
            .post(self.url("/public/get_instruments"))
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        // The API wraps results in { "result": [...] }
        let instruments: Vec<InstrumentDto> = serde_json::from_value(body["result"].clone())
            .map_err(|e| DeriveError::Api {
                message: format!("failed to parse instruments: {e}"),
            })?;

        Ok(instruments.into_iter().filter(|i| i.is_active).collect())
    }

    // ── Low-level: get tickers for a batch of instruments ────────────────────
    //
    // /public/get_tickers requires `currency` and `expiry_date` (YYYYMMDD) for options.
    // We group by expiry and do one request per expiry date to stay within API limits.

    async fn get_tickers_for_expiry(
        &self,
        asset: &str,
        expiry_date: &str, // "YYYYMMDD"
    ) -> Result<Vec<(String, TickerDto)>, DeriveError> {
        let payload = json!({
            "currency": asset,
            "instrument_type": "option",
            "expiry_date": expiry_date
        });

        let body: serde_json::Value = self
            .http
            .post(self.url("/public/get_tickers"))
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        // result shape: { "tickers": { "BTC-...-C": { "b": ..., "a": ..., "I": ... }, ... } }
        let result_map = body["result"]["tickers"]
            .as_object()
            .ok_or_else(|| DeriveError::Api {
                message: "get_tickers: result.tickers is not an object".to_string(),
            })?;

        let mut tickers: Vec<(String, TickerDto)> = Vec::new();
        for (name, val) in result_map {
            match serde_json::from_value::<TickerDto>(val.clone()) {
                Ok(dto) => tickers.push((name.clone(), dto)),
                Err(e) => eprintln!("warning: skip ticker {name}: {e}"),
            }
        }

        Ok(tickers)
    }

    // ── Low-level: get spot / index price ────────────────────────────────────
    //
    // We use /public/get_ticker on the perpetual (e.g. "BTC-PERP") to read `index_price`,
    // which is the pure spot feed. This avoids needing a separate endpoint.

    /// Extract spot price from the first ticker in a map.
    /// Every option ticker already carries "I" = index price, so no extra request needed.
    fn spot_from_ticker_map(
        ticker_map: &std::collections::HashMap<String, TickerDto>,
    ) -> Option<f64> {
        ticker_map
            .values()
            .find_map(|t| t.index_price.parse::<f64>().ok().filter(|&v| v > 0.0))
    }

    // ── High-level: full BTC options chain ───────────────────────────────────

    /// Fetch the complete BTC options chain with live bid/ask data and moneyness.
    ///
    /// Strategy:
    ///   1. Fetch all active BTC option instruments → extract unique expiry dates.
    ///   2. For each expiry, fetch tickers (bid/ask) in a single request.
    ///   3. Extract spot price from the "I" field present in every option ticker.
    ///   4. Join instruments with their ticker data, compute moneyness.
    pub async fn btc_options_chain(&self) -> Result<OptionsChain, DeriveError> {
        let asset = "BTC";

        // 1. Instruments
        let raw_instruments = self.list_active_option_instruments(asset).await?;

        // Parse and collect into a map: instrument_name → parsed fields
        let mut parsed: Vec<(String, OptionKind, f64, DateTime<Utc>)> = Vec::new();
        let mut expiry_dates_set: BTreeSet<(i64, String)> = BTreeSet::new(); // (ts, YYYYMMDD)
        // BTreeSet<u64> via f64::to_bits() gives us sorted, deduplicated strikes
        // without needing the ordered_float crate.
        let mut strikes_set: BTreeSet<u64> = BTreeSet::new();

        for dto in raw_instruments {
            // Skip instruments without option_details (shouldn't happen, but be safe)
            let details = match dto.option_details {
                Some(d) => d,
                None => continue,
            };

            let ts = i64::try_from(details.expiry).unwrap_or(i64::MAX);
            let expiry = Utc
                .timestamp_opt(ts, 0)
                .single()
                .ok_or(DeriveError::InvalidExpiry { timestamp: ts })?;

            let strike: f64 = details
                .strike
                .parse()
                .map_err(|_| DeriveError::InvalidExpiry { timestamp: ts })?;

            let kind = match details.option_type.as_str() {
                "P" => OptionKind::Put,
                _ => OptionKind::Call,
            };

            let expiry_str = expiry.format("%Y%m%d").to_string();
            expiry_dates_set.insert((ts, expiry_str));

            strikes_set.insert(strike.to_bits());

            parsed.push((dto.instrument_name, kind, strike, expiry));
        }

        // 2. Tickers — one request per expiry date
        // Build a map: instrument_name → TickerDto
        let mut ticker_map: std::collections::HashMap<String, TickerDto> =
            std::collections::HashMap::new();

        for (_ts, expiry_str) in &expiry_dates_set {
            match self.get_tickers_for_expiry(asset, expiry_str).await {
                Ok(tickers) => {
                    for (name, dto) in tickers {
                        ticker_map.insert(name, dto);
                    }
                }
                Err(e) => {
                    // A single expiry failing shouldn't crash the whole chain
                    eprintln!("warning: failed to fetch tickers for {expiry_str}: {e}");
                }
            }
        }

        // 3b. Extract spot price from any option ticker ("I" field = BTC-USD index)
        let spot_price =
            Self::spot_from_ticker_map(&ticker_map).ok_or_else(|| DeriveError::Api {
                message: "could not determine spot price: no tickers returned".to_string(),
            })?;

        // 4. Build OptionQuote list
        let mut quotes: Vec<OptionQuote> = parsed
            .into_iter()
            .map(|(name, kind, strike, expiry)| {
                let (bid, ask, index) = ticker_map
                    .get(&name)
                    .map(|t| {
                        (
                            parse_price(&t.best_bid_price),
                            parse_price(&t.best_ask_price),
                            t.index_price.parse::<f64>().unwrap_or(spot_price),
                        )
                    })
                    .unwrap_or((None, None, spot_price));

                // Use per-ticker index_price if available (more accurate), else global spot
                let effective_spot = if index != 0.0 { index } else { spot_price };

                let moneyness = compute_moneyness(kind, strike, effective_spot);

                OptionQuote {
                    instrument_name: name,
                    kind,
                    strike,
                    expiry,
                    bid,
                    ask,
                    spot_price: effective_spot,
                    moneyness,
                }
            })
            .collect();

        // Sort: expiry asc, then strike asc, then Call before Put
        quotes.sort_by(|a, b| {
            a.expiry
                .cmp(&b.expiry)
                .then(a.strike.partial_cmp(&b.strike).unwrap())
                .then(a.kind.to_string().cmp(&b.kind.to_string()))
        });

        let expiry_dates: Vec<DateTime<Utc>> = expiry_dates_set
            .iter()
            .filter_map(|(ts, _)| Utc.timestamp_opt(*ts, 0).single())
            .collect();

        let strikes: Vec<f64> = strikes_set
            .iter()
            .map(|&bits| f64::from_bits(bits))
            .collect();

        Ok(OptionsChain {
            asset: asset.to_string(),
            spot_price,
            expiry_dates,
            strikes,
            quotes,
        })
    }
}
