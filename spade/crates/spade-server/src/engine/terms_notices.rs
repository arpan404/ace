//! Subscriptions' terms changes between builds (ADR 0205 §4). The market's signer signs a list
//! of notices, `{provider, status, note, at}`; the daemon reads it with the daily update check
//! and hands it here as signed. Spade believes it only when a market key its build trusts signed
//! it, keeps only a list newer than the one it has, and lets each notice only make a provider's
//! status stricter than the shipped record. Nothing here changes any bot's model: a bot whose
//! provider turns `refused` waits for the person, as `terms` holds it.

use serde::Deserialize;
use serde_json::Value;
use spade_models::{CliTerms, TermsNotice, TermsStatus};

use super::Engine;
use crate::packages::envelope::{MarketKey, verify_signed};

/// What the notices are signed behind, so a signature on another kind never verifies.
const LABEL: &str = "ace-market-notices-v1";
/// The newest notices Spade believed, as signed.
const STORED: &str = "terms_notices";
/// The most notices a list may carry.
const MOST: usize = 64;

/// A verified list of notices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notices {
    pub issued: i64,
    pub notices: Vec<TermsNotice>,
}

#[derive(Deserialize)]
struct Body {
    format: String,
    issued: i64,
    notices: Vec<Value>,
}

#[derive(Deserialize)]
struct Line {
    provider: String,
    status: String,
    #[serde(default)]
    note: String,
    at: i64,
}

/// The notices `signed` carries, when a key of `keys` signed them; else why not. A notice this
/// build can't read (a status it doesn't know) is passed over, never fatal.
pub fn verify_notices(signed: &Value, keys: &[MarketKey]) -> Result<Notices, String> {
    let body = verify_signed(signed, keys, LABEL)?;
    let body: Body =
        serde_json::from_value(body).map_err(|_| "the notices are malformed".to_owned())?;
    if body.format != "ace-market-notices" || body.notices.len() > MOST {
        return Err("these aren't the market's terms notices".to_owned());
    }
    let notices = body
        .notices
        .into_iter()
        .filter_map(|line| serde_json::from_value::<Line>(line).ok())
        .filter_map(|line| {
            Some(TermsNotice {
                status: TermsStatus::parse(&line.status)?,
                provider: line.provider,
                note: line.note.chars().take(500).collect(),
                at_ms: line.at,
            })
        })
        .collect();
    Ok(Notices {
        issued: body.issued,
        notices,
    })
}

/// What handing Spade a list did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// It was newer than the list Spade had, and is now in force.
    Newer,
    /// Spade already had this list or a newer one.
    Known,
}

impl Engine {
    /// The newest notices Spade believed, verified again with the keys it trusts now.
    fn stored_notices(&self) -> Option<Notices> {
        let raw = self.store.setting(STORED).ok()??;
        let signed: Value = serde_json::from_str(&raw).ok()?;
        verify_notices(&signed, &self.market_keys()).ok()
    }

    /// Puts the shipped record, tightened by the stored notices, in force. Run at open and
    /// whenever the trusted keys change.
    pub(crate) fn reload_terms_notices(&self) {
        let shipped = CliTerms::shipped();
        let terms = match self.stored_notices() {
            Some(stored) => shipped.tightened(&stored.notices),
            None => shipped,
        };
        self.set_cli_terms(terms);
    }

    /// Takes the market's signed notices (`PUT /v1/subscriptions/notices`): believed only when
    /// signed by a trusted market key, kept only when newer than the list Spade has. A bad
    /// signature changes nothing.
    pub fn take_terms_notices(&self, signed: &Value) -> Result<Applied, String> {
        let next = verify_notices(signed, &self.market_keys())?;
        if self
            .stored_notices()
            .is_some_and(|held| held.issued >= next.issued)
        {
            return Ok(Applied::Known);
        }
        self.store
            .set_setting(STORED, Some(&signed.to_string()))
            .map_err(|e| e.to_string())?;
        self.reload_terms_notices();
        Ok(Applied::Newer)
    }
}
