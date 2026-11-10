//! Where model calls go: the gateway, its address for each wire protocol, and which model id
//! it expects. Pure: no I/O.

use std::fmt;

use serde::Deserialize;

use crate::catalog::Catalog;
use crate::error::ModelError;

/// A service Spade sends model calls to, with Spade's own key for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Deserialize)]
pub enum Gateway {
    /// Production.
    #[serde(rename = "openrouter")]
    OpenRouter,
    /// Development and internal testing only. The key is never deployed.
    #[serde(rename = "opencode-go")]
    OpenCodeGo,
    /// Anthropic's own API, for Claude models directly.
    #[serde(rename = "anthropic")]
    Anthropic,
}

/// The request format a route speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Protocol {
    /// OpenAI Chat Completions.
    #[serde(rename = "openai")]
    OpenAi,
    /// Anthropic Messages.
    #[serde(rename = "anthropic")]
    Anthropic,
    /// Google Gemini `generateContent`.
    #[serde(rename = "gemini")]
    Gemini,
    /// OpenRouter's OpenAI-style API, with its extensions for reasoning and caching.
    #[serde(rename = "openrouter")]
    OpenRouter,
}

impl Gateway {
    pub const ALL: [Self; 3] = [Self::OpenRouter, Self::OpenCodeGo, Self::Anthropic];

    /// The name used in `SPADE_MODEL_GATEWAY` and the catalogue file.
    pub const fn name(self) -> &'static str {
        match self {
            Self::OpenRouter => "openrouter",
            Self::OpenCodeGo => "opencode-go",
            Self::Anthropic => "anthropic",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|gateway| gateway.name() == name)
    }

    /// The environment variable holding this gateway's key.
    pub const fn key_variable(self) -> &'static str {
        match self {
            Self::OpenRouter => "OPENROUTER_API_KEY",
            Self::OpenCodeGo => "OPENCODE_API_KEY",
            Self::Anthropic => "ANTHROPIC_API_KEY",
        }
    }

    /// The gateway's root address. Each protocol adds its own path ([`Self::protocol_path`]).
    pub const fn root(self) -> &'static str {
        match self {
            Self::OpenRouter => "https://openrouter.ai/api/v1/",
            Self::OpenCodeGo => "https://opencode.ai/inference/go/",
            Self::Anthropic => "https://api.anthropic.com/v1/",
        }
    }

    /// The protocol a route uses when the catalogue does not name one.
    pub const fn default_protocol(self) -> Protocol {
        match self {
            Self::OpenRouter => Protocol::OpenRouter,
            Self::OpenCodeGo => Protocol::OpenAi,
            Self::Anthropic => Protocol::Anthropic,
        }
    }

    /// Whether this gateway serves `protocol`.
    pub const fn serves(self, protocol: Protocol) -> bool {
        matches!(
            (self, protocol),
            (Self::OpenRouter, Protocol::OpenRouter)
                | (Self::Anthropic, Protocol::Anthropic)
                | (
                    Self::OpenCodeGo,
                    Protocol::OpenAi | Protocol::Anthropic | Protocol::Gemini
                )
        )
    }

    /// The path under [`Self::root`] for `protocol`. OpenCode Go serves each format under its
    /// own prefix; the others serve one format at the root.
    pub const fn protocol_path(self, protocol: Protocol) -> &'static str {
        match (self, protocol) {
            (Self::OpenCodeGo, Protocol::OpenAi) => "openai/v1/",
            (Self::OpenCodeGo, Protocol::Anthropic) => "anthropic/v1/",
            (Self::OpenCodeGo, Protocol::Gemini) => "google/v1beta/",
            _ => "",
        }
    }
}

impl fmt::Display for Gateway {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::OpenRouter => "openrouter",
        })
    }
}

/// A resolved call target: the base address the protocol's paths hang off, the protocol, and
/// the model id the gateway expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Spade's id for the model.
    pub id: String,
    pub base_url: String,
    pub protocol: Protocol,
    pub model: String,
}

/// Resolves Spade's model `id` on `gateway`. `root` replaces the gateway's own root when set
/// (a local proxy or a test server); the protocol path is kept.
pub fn resolve(
    catalog: &Catalog,
    id: &str,
    gateway: Gateway,
    root: Option<&str>,
) -> Result<Target, ModelError> {
    let model = catalog
        .find(id)
        .ok_or_else(|| ModelError::UnknownModel(id.to_owned()))?;
    let route = model.route(gateway).ok_or_else(|| ModelError::NoRoute {
        model: model.id.clone(),
        gateway,
    })?;
    let root = root.unwrap_or(gateway.root());
    let separator = if root.ends_with('/') { "" } else { "/" };
    Ok(Target {
        id: model.id.clone(),
        base_url: format!("{root}{separator}{}", gateway.protocol_path(route.protocol)),
        protocol: route.protocol,
        model: route.model.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOG: &str = r#"{
        "defaults": {
            "openrouter": { "main": "sonnet", "fast": "haiku", "deep": "sonnet" },
            "opencode-go": { "main": "kimi", "fast": "haiku", "deep": "gemini" }
        },
        "models": [
            { "id": "sonnet", "name": "Sonnet", "routes": {
                "openrouter": { "model": "anthropic/claude-sonnet-5.5" } } },
            { "id": "haiku", "name": "Haiku", "routes": {
                "openrouter": { "model": "anthropic/claude-haiku-5.5" },
                "opencode-go": { "model": "claude-haiku-5-5", "protocol": "anthropic" } } },
            { "id": "gemini", "name": "Gemini", "routes": {
                "opencode-go": { "model": "gemini-4-argon", "protocol": "gemini" } } },
            { "id": "kimi", "name": "Kimi", "routes": {
                "opencode-go": { "model": "kimi-k3.1-pro" } } }
        ]
    }"#;

    fn catalog() -> Result<Catalog, String> {
        Catalog::from_json(CATALOG).map_err(|error| error.to_string())
    }

    #[test]
    fn opencode_go_sends_each_model_to_its_protocol_prefix() -> Result<(), String> {
        let catalog = catalog()?;
        let cases = [
            (
                "kimi",
                "https://opencode.ai/inference/go/openai/v1/",
                Protocol::OpenAi,
            ),
            (
                "haiku",
                "https://opencode.ai/inference/go/anthropic/v1/",
                Protocol::Anthropic,
            ),
            (
                "gemini",
                "https://opencode.ai/inference/go/google/v1beta/",
                Protocol::Gemini,
            ),
        ];
        for (id, base_url, protocol) in cases {
            let target = resolve(&catalog, id, Gateway::OpenCodeGo, None);
            assert_eq!(
                target.map(|t| (t.base_url, t.protocol)),
                Ok((base_url.to_owned(), protocol)),
                "{id}"
            );
        }
        Ok(())
    }

    #[test]
    fn openrouter_uses_its_own_model_ids() -> Result<(), String> {
        let target = resolve(&catalog()?, "sonnet", Gateway::OpenRouter, None);
        assert_eq!(
            target,
            Ok(Target {
                id: "sonnet".to_owned(),
                base_url: "https://openrouter.ai/api/v1/".to_owned(),
                protocol: Protocol::OpenRouter,
                model: "anthropic/claude-sonnet-5.5".to_owned(),
            })
        );
        Ok(())
    }

    #[test]
    fn a_root_override_keeps_the_protocol_path() -> Result<(), String> {
        let target = resolve(
            &catalog()?,
            "kimi",
            Gateway::OpenCodeGo,
            Some("http://127.0.0.1:9000"),
        );
        assert_eq!(
            target.map(|t| t.base_url),
            Ok("http://127.0.0.1:9000/openai/v1/".to_owned())
        );
        Ok(())
    }

    #[test]
    fn an_unlisted_model_is_refused() -> Result<(), String> {
        let target = resolve(&catalog()?, "gpt-5.4", Gateway::OpenRouter, None);
        assert_eq!(target, Err(ModelError::UnknownModel("gpt-5.4".to_owned())));
        Ok(())
    }

    #[test]
    fn a_model_the_gateway_cannot_run_is_refused() -> Result<(), String> {
        let target = resolve(&catalog()?, "gemini", Gateway::OpenRouter, None);
        assert_eq!(
            target,
            Err(ModelError::NoRoute {
                model: "gemini".to_owned(),
                gateway: Gateway::OpenRouter,
            })
        );
        Ok(())
    }

    #[test]
    fn gateway_names_round_trip() {
        for gateway in Gateway::ALL {
            assert_eq!(Gateway::from_name(gateway.name()), Some(gateway));
        }
        assert_eq!(Gateway::from_name("together"), None);
    }
}
