//! What each coding CLI's maker allows (ADR 0205 §4): one record per provider a bot can think
//! through, shipped as `config/cli-terms.json`. `allowed` and `refused` are written from a
//! vendor's own terms, so a record with either status must name the terms read (`source`) and
//! when (`checked`); anything not yet read is `unclear`. A provider without a record reads
//! `unclear`.

use serde::{Deserialize, Serialize};

/// The record this build ships.
pub const SHIPPED: &str = include_str!("../../../config/cli-terms.json");

/// Whether a provider's terms permit a person's own standing bots on their own subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TermsStatus {
    Allowed,
    Unclear,
    /// Not offered for new bots; a bot already on it waits for the person to pick another model.
    Refused,
}

impl TermsStatus {
    /// How strict it is: `allowed`, then `unclear`, then `refused`.
    fn strictness(self) -> u8 {
        match self {
            Self::Allowed => 0,
            Self::Unclear => 1,
            Self::Refused => 2,
        }
    }

    pub fn parse(word: &str) -> Option<Self> {
        [Self::Allowed, Self::Unclear, Self::Refused]
            .into_iter()
            .find(|s| s.name() == word)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Unclear => "unclear",
            Self::Refused => "refused",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TermsRecord {
    pub provider: String,
    /// The provider as people know it ("Codex").
    #[serde(default)]
    pub name: String,
    pub status: TermsStatus,
    /// The date the terms were read, `YYYY-MM-DD`.
    #[serde(default)]
    pub checked: Option<String>,
    /// The address of the terms read.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub note: String,
    /// When a signed notice made this record stricter than the build ships it (ADR 0205 §4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noticed_ms: Option<i64>,
}

/// A change to one provider's terms between builds, from the market's signed notices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermsNotice {
    pub provider: String,
    pub status: TermsStatus,
    pub note: String,
    pub at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliTerms {
    /// Raised whenever a record changes, so an acknowledgement of an older record is asked again.
    pub version: u32,
    pub providers: Vec<TermsRecord>,
}

impl CliTerms {
    /// The record this build ships. It is checked by this crate's tests, so it always reads.
    pub fn shipped() -> Self {
        Self::from_json(SHIPPED).unwrap_or(Self {
            version: 0,
            providers: Vec::new(),
        })
    }

    /// Reads a record, refusing one that claims `allowed` or `refused` without naming the terms
    /// it was written from, or that lists a provider twice.
    pub fn from_json(raw: &str) -> Result<Self, String> {
        let terms: Self = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let mut seen = std::collections::BTreeSet::new();
        for record in &terms.providers {
            if !seen.insert(record.provider.as_str()) {
                return Err(format!("{} is listed twice", record.provider));
            }
            let read = |field: &Option<String>| field.as_deref().is_some_and(|v| !v.is_empty());
            if record.status != TermsStatus::Unclear
                && (!read(&record.source) || !read(&record.checked))
            {
                return Err(format!(
                    "{} is {} without the terms it was read from (source and checked)",
                    record.provider,
                    record.status.name()
                ));
            }
        }
        Ok(terms)
    }

    /// The record for `provider`; `unclear` when there is none.
    pub fn record(&self, provider: &str) -> TermsRecord {
        self.providers
            .iter()
            .find(|r| r.provider == provider)
            .cloned()
            .unwrap_or_else(|| TermsRecord {
                provider: provider.to_owned(),
                name: String::new(),
                status: TermsStatus::Unclear,
                checked: None,
                source: None,
                note: String::new(),
                noticed_ms: None,
            })
    }

    /// This record with `notices` applied, each only where it is stricter than this record
    /// (ADR 0205 §4): a notice can turn a provider `unclear` or `refused`, never back. Loosening
    /// needs a build.
    pub fn tightened(&self, notices: &[TermsNotice]) -> Self {
        let mut next = self.clone();
        for notice in notices {
            let shipped = self.record(&notice.provider);
            if notice.status.strictness() <= shipped.status.strictness() {
                continue;
            }
            let record = TermsRecord {
                status: notice.status,
                note: notice.note.clone(),
                noticed_ms: Some(notice.at_ms),
                ..shipped
            };
            match next
                .providers
                .iter_mut()
                .find(|r| r.provider == notice.provider)
            {
                Some(held) if held.status.strictness() < notice.status.strictness() => {
                    *held = record;
                }
                Some(_) => {}
                None => next.providers.push(record),
            }
        }
        next
    }

    pub fn status(&self, provider: &str) -> TermsStatus {
        self.record(provider).status
    }
}

impl TermsRecord {
    /// The provider's name, else its id.
    pub fn shown_name(&self) -> &str {
        if self.name.is_empty() {
            &self.provider
        } else {
            &self.name
        }
    }

    /// What the person reads before choosing this subscription for a bot (ADR 0205 §1, §4).
    pub fn acknowledgement(&self) -> String {
        let name = self.shown_name();
        let mut text = format!(
            "This bot will run in your {name} CLI on your subscription. Its maker's terms apply \
             to how you use it. If they change, Spade may stop offering it."
        );
        if self.status == TermsStatus::Unclear {
            text.push_str(" Its terms don't say whether this is allowed.");
        }
        text
    }

    /// What a bot already on a refused provider shows, once.
    pub fn refusal(&self) -> String {
        format!(
            "{}'s terms no longer allow this. Pick another model for this bot.",
            self.shown_name()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_provider_is_unclear_until_its_terms_are_written() -> Result<(), String> {
        let shipped = CliTerms::from_json(SHIPPED)?;
        assert!(shipped.version >= 1);
        for provider in [
            "claude",
            "codex",
            "opencode",
            "cursor",
            "antigravity",
            "acp",
            "pi",
        ] {
            let record = shipped.record(provider);
            assert_eq!(record.status, TermsStatus::Unclear, "{provider}");
            assert!(!record.name.is_empty(), "{provider}");
        }
        Ok(())
    }

    #[test]
    fn a_status_other_than_unclear_needs_the_terms_it_was_read_from() -> Result<(), String> {
        let record = |status: &str, source: &str| {
            format!(
                r#"{{"version":2,"providers":[{{"provider":"codex","status":"{status}",
                "checked":"2026-11-20","source":{source}}}]}}"#
            )
        };
        assert!(CliTerms::from_json(&record("allowed", "null")).is_err());
        assert!(CliTerms::from_json(&record("refused", "\"\"")).is_err());
        let refused = CliTerms::from_json(&record("refused", "\"https://example.com/terms\""))?;
        assert_eq!(refused.status("codex"), TermsStatus::Refused);
        assert_eq!(refused.status("claude"), TermsStatus::Unclear);
        Ok(())
    }

    fn notice(provider: &str, status: TermsStatus) -> TermsNotice {
        TermsNotice {
            provider: provider.to_owned(),
            status,
            note: "Read again".to_owned(),
            at_ms: 7,
        }
    }

    #[test]
    fn a_notice_only_ever_makes_a_status_stricter() -> Result<(), String> {
        let shipped = CliTerms::from_json(
            r#"{"version":3,"providers":[
                {"provider":"codex","name":"Codex","status":"allowed","checked":"2026-11-20",
                 "source":"https://example.com/codex"},
                {"provider":"claude","name":"Claude","status":"refused","checked":"2026-11-20",
                 "source":"https://example.com/claude"}]}"#,
        )?;
        let after = shipped.tightened(&[
            notice("codex", TermsStatus::Refused),
            notice("claude", TermsStatus::Allowed),
            notice("pi", TermsStatus::Allowed),
            notice("opencode", TermsStatus::Refused),
        ]);
        let codex = after.record("codex");
        assert_eq!(codex.status, TermsStatus::Refused);
        assert_eq!(
            (codex.noticed_ms, codex.note.as_str()),
            (Some(7), "Read again")
        );
        assert_eq!(codex.shown_name(), "Codex");
        // Loosening is ignored, whatever the build ships.
        assert_eq!(after.record("claude").status, TermsStatus::Refused);
        assert_eq!(after.record("pi").status, TermsStatus::Unclear);
        assert_eq!(after.record("opencode").status, TermsStatus::Refused);
        // A milder notice doesn't undo a stricter one in the same list.
        let both = shipped.tightened(&[
            notice("codex", TermsStatus::Refused),
            notice("codex", TermsStatus::Unclear),
        ]);
        assert_eq!(both.record("codex").status, TermsStatus::Refused);
        Ok(())
    }

    #[test]
    fn the_acknowledgement_says_when_the_terms_are_silent() {
        let terms = CliTerms::shipped();
        let unclear = terms.record("codex").acknowledgement();
        assert!(unclear.starts_with("This bot will run in your Codex CLI on your subscription."));
        assert!(unclear.ends_with("Its terms don't say whether this is allowed."));
        let mut allowed = terms.record("codex");
        allowed.status = TermsStatus::Allowed;
        assert!(!allowed.acknowledgement().contains("don't say"));
        assert_eq!(
            terms.record("codex").refusal(),
            "Codex's terms no longer allow this. Pick another model for this bot."
        );
    }
}
