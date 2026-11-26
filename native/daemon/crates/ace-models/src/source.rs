// SPDX-License-Identifier: Apache-2.0
//! The source a provider's models are served from.
//!
//! Ports `packages/models/src/model-source.ts` for the fields the catalog rows show:
//! the source kind, a service label, and the OpenCode/Ollama service markers.

use ace_protocol::generated::{ModelSource, ModelSourceKind, ModelSourceService};

use crate::row::text;

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

/// A provider id's source, classified without asking the provider anything.
pub fn provider_source(id: &str) -> ModelSource {
    let kind = match id {
        "ollama" | "lmstudio" | "llama.cpp" => ModelSourceKind::Local,
        "opencode-go" | "github-copilot" | "openai-codex" | "openai-chatgpt" => {
            ModelSourceKind::Subscription
        }
        "opencode" | "opencode-zen" => ModelSourceKind::ApiKey,
        _ => ModelSourceKind::Other,
    };
    let service = match id {
        "opencode-go" => Some(ModelSourceService::OpencodeGo),
        "opencode" | "opencode-zen" => Some(ModelSourceService::OpencodeZen),
        _ => None,
    };
    ModelSource {
        id: text(id),
        kind,
        label: text(service_label(id).unwrap_or(id)),
        requires_auth: None,
        service,
    }
}

/// A model's source: Ollama's cloud suffix is model-specific even through a local endpoint.
pub fn model_source(id: &str, model_id: &str) -> ModelSource {
    let source = provider_source(id);
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
