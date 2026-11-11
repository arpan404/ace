//! The three wire formats Spade speaks. Any endpoint that speaks one of them works.

use std::fmt;

use genai::adapter::AdapterKind;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Format {
    /// OpenAI Chat Completions (`/chat/completions`): OpenAI and every OpenAI-compatible server.
    #[serde(rename = "openai-chat")]
    OpenAiChat,
    /// OpenAI Responses (`/responses`).
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    /// Anthropic Messages (`/messages`).
    #[serde(rename = "anthropic")]
    Anthropic,
}

impl Format {
    pub(crate) fn adapter(self) -> AdapterKind {
        match self {
            Self::OpenAiChat => AdapterKind::OpenAI,
            Self::OpenAiResponses => AdapterKind::OpenAIResp,
            Self::Anthropic => AdapterKind::Anthropic,
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        [Self::OpenAiChat, Self::OpenAiResponses, Self::Anthropic]
            .into_iter()
            .find(|f| f.name() == name)
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai-chat",
            Self::OpenAiResponses => "openai-responses",
            Self::Anthropic => "anthropic",
        }
    }
}

impl fmt::Display for Format {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}
