//! How hard a model thinks before answering (ADR 0213): one word per call, turned into each wire
//! format's own reasoning setting.

use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use genai::chat::ReasoningEffort;
use serde::{Deserialize, Serialize};

use crate::error::ModelError;
use crate::format::Format;

/// How much a model reasons before it answers. `Provider` sends nothing, so the endpoint's own
/// default holds; every other value is sent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effort {
    #[default]
    Provider,
    Off,
    Low,
    Medium,
    High,
    Max,
}

impl Effort {
    pub const ALL: [Self; 6] = [
        Self::Provider,
        Self::Off,
        Self::Low,
        Self::Medium,
        Self::High,
        Self::Max,
    ];

    pub const fn name(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::Off => "off",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Max => "max",
        }
    }

    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|e| e.name() == word.trim())
    }

    /// Tokens added to a call's answer limit so the thinking fits beside the answer. Above the
    /// largest thinking budget the Anthropic format sends for the effort, which must stay under
    /// the call's `max_tokens`.
    pub const fn room(self) -> u32 {
        match self {
            Self::Provider | Self::Off => 0,
            Self::Low => 2_048,
            Self::Medium => 9_216,
            Self::High | Self::Max => 25_600,
        }
    }

    /// The SDK's setting for `format`; `None` sends nothing. OpenAI's formats take `xhigh` as
    /// their top word, Anthropic's `max`.
    pub(crate) fn sdk(self, format: Format) -> Option<ReasoningEffort> {
        Some(match self {
            Self::Provider => return None,
            Self::Off => ReasoningEffort::Zero,
            Self::Low => ReasoningEffort::Low,
            Self::Medium => ReasoningEffort::Medium,
            Self::High => ReasoningEffort::High,
            Self::Max if format == Format::Anthropic => ReasoningEffort::Max,
            Self::Max => ReasoningEffort::XHigh,
        })
    }
}

/// The models whose endpoint refused a reasoning setting and then answered without one: sent
/// none from then on, until Spade restarts. Shared by every clone of [`crate::Models`].
#[derive(Debug, Clone, Default)]
pub(crate) struct Refusals(Arc<RwLock<HashSet<String>>>);

impl Refusals {
    pub(crate) fn refuses(&self, reference: &str) -> bool {
        self.0
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .contains(reference)
    }

    pub(crate) fn remember(&self, reference: &str) {
        self.0
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(reference.to_owned());
    }
}

/// Whether `error` is an endpoint refusing the request as written (`400`, `422`), which a
/// reasoning setting it doesn't take is answered with. Sent once more without the setting; a
/// request refused for another reason fails the same way again.
pub(crate) fn refused(error: &ModelError) -> bool {
    matches!(error.status(), Some(400 | 422))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_effort_reads_back_from_its_name() {
        for effort in Effort::ALL {
            assert_eq!(Effort::parse(effort.name()), Some(effort));
        }
        assert_eq!(Effort::parse("extreme"), None);
    }
}
