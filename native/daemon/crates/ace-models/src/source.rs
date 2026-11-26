// SPDX-License-Identifier: Apache-2.0
//! The source a provider's models are served from.
//!
//! Ports `packages/models/src/model-source.ts` for the fields the catalog rows show:
//! the source kind, a service label, and the OpenCode/Ollama service markers.

use ace_protocol::generated::{ModelSource, ModelSourceKind, ModelSourceService};

use crate::row::text;

/// What discovery knows about a provider before asking it anything (`model-source.ts`'s
/// `info` parameter).
#[derive(Debug, Clone, Default)]
pub struct SourceInfo<'a> {
    pub name: Option<&'a str>,
    pub local: Option<bool>,
    pub base_url: Option<&'a str>,
    pub types: Vec<&'a str>,
    pub auth_type: Option<&'a str>,
}

/// Service names shared by discovery, settings and native sign-in choices.
pub fn service_label(id: &str) -> Option<&'static str> {
    Some(match id.to_lowercase().as_str() {
        "opencode-go" => "OpenCode Go",
        "opencode" | "opencode-zen" => "OpenCode Zen",
        "github-copilot" | "copilot" => "GitHub Copilot",
        "openai-codex" | "openai-chatgpt" => "ChatGPT / Codex",
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        "google" => "Google",
        "google-gemini-cli" => "Gemini CLI",
        "google-antigravity" => "Antigravity",
        "openrouter" => "OpenRouter",
        "ollama" => "Ollama",
        "ollama-cloud" => "Ollama Cloud",
        "lmstudio" => "LM Studio",
        "llama.cpp" => "llama.cpp",
        "other" => "Other provider",
        _ => return None,
    })
}

fn localhost(base_url: Option<&str>) -> bool {
    fn is_loopback(host: &str) -> bool {
        static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
        let pattern = PATTERN.get_or_init(|| {
            regex::Regex::new(r"^(?:localhost|127(?:\.[0-9]+){3}|::1|\[::1\]|0\.0\.0\.0)$").ok()
        });
        pattern
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(host))
    }
    base_url
        .and_then(|base| url::Url::parse(base).ok())
        .is_some_and(|url| url.host_str().is_some_and(is_loopback))
}

/// A provider id's source, classified without asking the provider anything.
pub fn provider_source(id: &str) -> ModelSource {
    provider_source_with(id, &SourceInfo::default())
}

/// A provider id's source from what discovery knows: a local flag or endpoint, the
/// provider's types, or the sign-in type settle the kind; a known service name or the
/// reported name is the label.
pub fn provider_source_with(id: &str, info: &SourceInfo<'_>) -> ModelSource {
    let types = &info.types;
    let known_local = id == "ollama" || id == "lmstudio" || id == "llama.cpp";
    let kind = if info.local == Some(true)
        || localhost(info.base_url)
        || types.contains(&"local")
        || (info.base_url.is_none_or(str::is_empty) && known_local)
    {
        ModelSourceKind::Local
    } else if [
        "opencode-go",
        "github-copilot",
        "openai-codex",
        "openai-chatgpt",
    ]
    .contains(&id)
    {
        ModelSourceKind::Subscription
    } else if ["opencode", "opencode-zen"].contains(&id) {
        ModelSourceKind::ApiKey
    } else if info.auth_type == Some("oauth") || types.contains(&"oauth") {
        ModelSourceKind::Subscription
    } else if info.auth_type == Some("api_key")
        || types.contains(&"env")
        || types.contains(&"api_key")
    {
        ModelSourceKind::ApiKey
    } else {
        ModelSourceKind::Other
    };
    let service = match id {
        "opencode-go" => Some(ModelSourceService::OpencodeGo),
        "opencode" | "opencode-zen" => Some(ModelSourceService::OpencodeZen),
        _ => None,
    };
    let label = service_label(id).unwrap_or_else(|| info.name.unwrap_or(id));
    ModelSource {
        id: text(id),
        kind,
        label: text(label),
        requires_auth: None,
        service,
    }
}

/// A model's source: Ollama's cloud suffix is model-specific even through a local endpoint.
pub fn model_source(id: &str, model_id: &str) -> ModelSource {
    model_source_with(id, model_id, provider_source(id))
}

/// A model's source from an already-classified provider source.
pub fn model_source_with(id: &str, model_id: &str, source: ModelSource) -> ModelSource {
    let label = service_label(&source.id.0);
    let keep_label = label.is_some_and(|label| label != source.id.0);
    let named = if source.kind != ModelSourceKind::Account && keep_label {
        let kind = if matches!(id, "openai-codex" | "openai-chatgpt") {
            ModelSourceKind::Subscription
        } else {
            source.kind
        };
        ModelSource {
            label: text(label.unwrap_or(id)),
            kind,
            ..source
        }
    } else {
        source
    };
    if id == "ollama"
        && (model_id.to_lowercase().ends_with(":cloud")
            || model_id.to_lowercase().ends_with("-cloud"))
    {
        return ModelSource {
            id: text("ollama-cloud"),
            kind: ModelSourceKind::ApiKey,
            requires_auth: Some(true),
            label: text(service_label("ollama-cloud").unwrap_or("ollama-cloud")),
            ..named
        };
    }
    named
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/model-source.ts`: the classification order
    //! (local flag/endpoint/types, subscription ids, Zen API keys, OAuth and env/auth
    //! types), the service labels, the codex subscription override and Ollama's cloud
    //! suffix.

    use super::*;

    fn kind(source: &ModelSource) -> ModelSourceKind {
        source.kind
    }

    #[test]
    fn a_local_flag_endpoint_or_type_classifies_a_provider_as_local() {
        for info in [
            SourceInfo {
                local: Some(true),
                ..SourceInfo::default()
            },
            SourceInfo {
                base_url: Some("http://127.0.0.1:8080/v1"),
                ..SourceInfo::default()
            },
            SourceInfo {
                base_url: Some("http://localhost:11434"),
                ..SourceInfo::default()
            },
            SourceInfo {
                base_url: Some("http://[::1]:11434"),
                ..SourceInfo::default()
            },
            SourceInfo {
                types: vec!["local"],
                ..SourceInfo::default()
            },
        ] {
            assert_eq!(
                kind(&provider_source_with("anthropic", &info)),
                ModelSourceKind::Local
            );
        }
        // Without an endpoint, only the known local CLIs are local.
        assert_eq!(
            kind(&provider_source_with("ollama", &SourceInfo::default())),
            ModelSourceKind::Local
        );
        assert_eq!(
            kind(&provider_source_with("lmstudio", &SourceInfo::default())),
            ModelSourceKind::Local
        );
    }

    #[test]
    fn subscription_ids_zen_keys_and_auth_types_follow_the_typescript_order() {
        assert_eq!(
            kind(&provider_source("opencode-go")),
            ModelSourceKind::Subscription
        );
        assert_eq!(kind(&provider_source("opencode")), ModelSourceKind::ApiKey);
        assert_eq!(
            kind(&provider_source_with(
                "custom",
                &SourceInfo {
                    auth_type: Some("oauth"),
                    ..SourceInfo::default()
                }
            )),
            ModelSourceKind::Subscription
        );
        assert_eq!(
            kind(&provider_source_with(
                "custom",
                &SourceInfo {
                    types: vec!["env"],
                    ..SourceInfo::default()
                }
            )),
            ModelSourceKind::ApiKey
        );
        assert_eq!(
            kind(&provider_source_with("custom", &SourceInfo::default())),
            ModelSourceKind::Other
        );
    }

    #[test]
    fn the_label_prefers_a_known_service_name_then_the_reported_name() {
        let known = provider_source("openrouter");
        assert_eq!(known.label.0, "OpenRouter");
        let named = provider_source_with(
            "custom",
            &SourceInfo {
                name: Some("My Router"),
                ..SourceInfo::default()
            },
        );
        assert_eq!(named.label.0, "My Router");
        let bare = provider_source("custom");
        assert_eq!(bare.label.0, "custom");
        assert_eq!(
            provider_source("opencode-go").service,
            Some(ModelSourceService::OpencodeGo)
        );
    }

    #[test]
    fn a_codex_route_is_a_subscription_and_ollamas_cloud_suffix_is_api_key() {
        let codex = model_source("openai-codex", "gpt-6.1-sol");
        assert_eq!(codex.kind, ModelSourceKind::Subscription);
        assert_eq!(codex.label.0, "ChatGPT / Codex");
        let cloud = model_source("ollama", "gpt-oss:cloud");
        assert_eq!(cloud.id.0, "ollama-cloud");
        assert_eq!(cloud.kind, ModelSourceKind::ApiKey);
        assert_eq!(cloud.requires_auth, Some(true));
        assert_eq!(cloud.label.0, "Ollama Cloud");
    }
}
