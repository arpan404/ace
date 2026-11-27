// SPDX-License-Identifier: Apache-2.0
//! Pi's `get_available_models` and `get_state` replies as catalog rows.
//!
//! Ports `piModels` in `packages/models/src/list-discovery.ts`. The CLI process and its
//! JSON-RPC envelope are ports; this module reads the two replies and shapes the rows:
//! the qualified `provider/id` selector, the configured model as default, Pi's
//! reasoning efforts at the session's thinking level, and the model's source.

use ace_protocol::generated::CatalogModel;
use serde_json::Value;

use crate::effort::pi_efforts;
use crate::instance::ModelInstance;
use crate::metadata::chat_metadata;
use crate::native::{NativeError, flag_or, labels, positive_int, required_label};
use crate::row::{base, decoded_text, nonzero, text, texts, validate_row};
use crate::source::model_source;

const ROWS_LIMIT: usize = 512;
const INPUT_LIMIT: usize = 32;

struct NativeModel {
    raw: Value,
    id: String,
    provider: String,
    name: String,
    context_window: Option<u64>,
    input: Vec<String>,
    reasoning: bool,
}

/// The two replies one Pi discovery reads.
pub struct PiReplies {
    models: Vec<NativeModel>,
    default: Option<(String, String)>,
    thinking_level: Option<String>,
}

/// Whether a decoded line is the reply to `command` with `id` (the RPC envelope).
pub fn is_pi_reply(value: &Value, id: &str, command: &str) -> bool {
    value.get("type").and_then(Value::as_str) == Some("response")
        && value.get("id").and_then(Value::as_str) == Some(id)
        && value.get("command").and_then(Value::as_str) == Some(command)
}

fn parse_models(reply: &Value) -> Result<Vec<NativeModel>, NativeError> {
    let data = reply
        .get("data")
        .and_then(Value::as_object)
        .ok_or(NativeError("Malformed Pi model reply"))?;
    let models = data
        .get("models")
        .and_then(Value::as_array)
        .ok_or(NativeError("Malformed Pi model reply"))?;
    if models.len() > ROWS_LIMIT {
        return Err(NativeError("Malformed Pi model reply"));
    }
    let mut parsed = Vec::new();
    for raw in models {
        let entry = raw
            .as_object()
            .ok_or(NativeError("Malformed Pi model reply"))?;
        let id = required_label(entry, "id").ok_or(NativeError("Malformed Pi model reply"))?;
        let provider =
            required_label(entry, "provider").ok_or(NativeError("Malformed Pi model reply"))?;
        let name = required_label(entry, "name").ok_or(NativeError("Malformed Pi model reply"))?;
        let context_window = match entry.get("contextWindow") {
            None | Some(Value::Null) => None,
            value => Some(positive_int(value).ok_or(NativeError("Malformed Pi model reply"))?),
        };
        let input = match entry.get("input") {
            None | Some(Value::Null) => Vec::new(),
            value => labels(value, INPUT_LIMIT).ok_or(NativeError("Malformed Pi model reply"))?,
        };
        parsed.push(NativeModel {
            raw: raw.clone(),
            id,
            provider,
            name,
            context_window,
            input,
            reasoning: flag_or(entry, "reasoning", false),
        });
    }
    Ok(parsed)
}

type PiState = (Option<(String, String)>, Option<String>);

fn parse_state(reply: &Value) -> Result<PiState, NativeError> {
    let data = reply
        .get("data")
        .and_then(Value::as_object)
        .ok_or(NativeError("Malformed Pi state reply"))?;
    let default = match data.get("model") {
        None | Some(Value::Null) => None,
        Some(model) => {
            let model = model
                .as_object()
                .ok_or(NativeError("Malformed Pi state reply"))?;
            Some((
                model
                    .get("provider")
                    .and_then(Value::as_str)
                    .ok_or(NativeError("Malformed Pi state reply"))?
                    .to_owned(),
                model
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(NativeError("Malformed Pi state reply"))?
                    .to_owned(),
            ))
        }
    };
    let thinking = match data.get("thinkingLevel") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or(NativeError("Malformed Pi state reply"))?
                .to_owned(),
        ),
    };
    Ok((default, thinking))
}

/// Reads Pi's two replies: a successful `get_available_models` and `get_state`.
pub fn read_pi_replies(
    models_reply: &Value,
    state_reply: &Value,
) -> Result<PiReplies, NativeError> {
    if models_reply.get("success").and_then(Value::as_bool) != Some(true)
        || state_reply.get("success").and_then(Value::as_bool) != Some(true)
    {
        return Err(NativeError("Malformed Pi reply"));
    }
    let models = parse_models(models_reply)?;
    let (default, thinking_level) = parse_state(state_reply)?;
    Ok(PiReplies {
        models,
        default,
        thinking_level,
    })
}

/// The rows from Pi's replies.
pub fn normalize_pi(
    replies: &PiReplies,
    instance: &ModelInstance,
) -> Result<Vec<CatalogModel>, NativeError> {
    let mut rows = Vec::new();
    for native in &replies.models {
        if !chat_metadata(&native.raw) {
            continue;
        }
        let id = format!("{}/{}", native.provider, native.id);
        let mut model = base(instance, &id, &native.name, &native.raw);
        model.native_provider_id = decoded_text(Some(&native.provider));
        model.native_model_id = text(&native.id);
        model.is_default = replies
            .default
            .as_ref()
            .is_some_and(|(provider, model_id)| {
                provider == &native.provider && model_id == &native.id
            })
            .into();
        model.source = Some(model_source(&native.provider, &native.id).into());
        model.context_window = native.context_window.and_then(nonzero);
        model.input_modalities = texts(native.input.clone());
        let efforts = pi_efforts(native.reasoning, replies.thinking_level.as_deref());
        model.default_effort = decoded_text(efforts.default_effort.as_deref());
        model.efforts = efforts.efforts.into();
        validate_row(&model).map_err(|_| NativeError("Model row exceeds catalog limits"))?;
        rows.push(model);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    //! Ports the Pi model-list cases of `packages/models/src/discover.process.test.ts`
    //! (the fake CLI's `get_available_models`/`get_state` path): the qualified
    //! selector, the configured default, reasoning efforts at the thinking level,
    //! input modalities/context, and the source classification. `catalog-input`'s
    //! only case is a session-input test, not a catalog one.

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn instance() -> ModelInstance {
        ModelInstance::cli("pi", ProviderKind::Pi, "pi", "/repo")
    }

    fn models_reply() -> Value {
        json!({
            "type": "response",
            "id": "ace-models",
            "command": "get_available_models",
            "success": true,
            "data": {
                "models": [
                    {
                        "id": "claude-opus-5-5",
                        "provider": "anthropic",
                        "name": "Claude Opus 5.5",
                        "contextWindow": 200_000,
                        "input": ["text", "image"],
                        "reasoning": true
                    },
                    {
                        "id": "gpt-6.1-sol",
                        "provider": "openai-codex",
                        "name": "GPT-6.1 Sol"
                    },
                    {
                        "id": "embedding-model",
                        "provider": "openai",
                        "name": "Embedding",
                        "type": "embedding"
                    }
                ]
            }
        })
    }

    fn state_reply() -> Value {
        json!({
            "type": "response",
            "id": "ace-models-state",
            "command": "get_state",
            "success": true,
            "data": {
                "model": { "provider": "anthropic", "id": "claude-opus-5-5" },
                "thinkingLevel": "high"
            }
        })
    }

    fn row(model: &CatalogModel) -> Value {
        serde_json::to_value(model).unwrap_or(Value::Null)
    }

    #[test]
    fn a_pi_row_uses_the_qualified_selector_and_the_configured_model_as_default() {
        let replies = read_pi_replies(&models_reply(), &state_reply()).ok();
        let replies = replies
            .as_ref()
            .map(|replies| normalize_pi(replies, &instance()));
        let rows = replies.and_then(Result::ok).unwrap_or_default();
        let ids: Vec<&str> = rows.iter().map(|row| row.id.0.as_str()).collect();
        assert_eq!(
            ids,
            ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"]
        );
        let first = row(&rows[0]);
        assert_eq!(first["nativeModelId"], "claude-opus-5-5");
        assert_eq!(first["nativeProviderId"], "anthropic");
        assert_eq!(first["isDefault"], true);
        assert_eq!(first["contextWindow"], 200_000);
        assert_eq!(first["inputModalities"], json!(["text", "image"]));
        assert_eq!(row(&rows[1])["isDefault"], false);
        assert_eq!(row(&rows[1])["source"]["label"], "ChatGPT / Codex");
        assert_eq!(row(&rows[1])["source"]["kind"], "subscription");
    }

    #[test]
    fn reasoning_models_offer_pis_thinking_levels_and_others_offer_none() {
        let replies = read_pi_replies(&models_reply(), &state_reply())
            .ok()
            .map(|replies| normalize_pi(&replies, &instance()))
            .and_then(Result::ok)
            .unwrap_or_default();
        let first = row(&replies[0]);
        let ids: Vec<&str> = first["efforts"]
            .as_array()
            .map(|efforts| efforts.iter().filter_map(|e| e["id"].as_str()).collect())
            .unwrap_or_default();
        assert_eq!(
            ids,
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(first["defaultEffort"], "high");
        assert_eq!(row(&replies[1])["efforts"], json!([]));
        assert_eq!(row(&replies[1])["defaultEffort"], Value::Null);
    }

    #[test]
    fn pi_sources_classify_local_and_cloud_providers() {
        let reply = json!({
            "type": "response",
            "id": "ace-models",
            "command": "get_available_models",
            "success": true,
            "data": { "models": [
                { "id": "llama-4", "provider": "ollama", "name": "Llama 4" },
                { "id": "gpt-oss:cloud", "provider": "ollama", "name": "GPT OSS Cloud" },
                { "id": "qwen3", "provider": "lmstudio", "name": "Qwen3" }
            ] }
        });
        let state = json!({
            "type": "response", "id": "ace-models-state", "command": "get_state",
            "success": true, "data": { "model": null, "thinkingLevel": null }
        });
        let rows = read_pi_replies(&reply, &state)
            .ok()
            .map(|replies| normalize_pi(&replies, &instance()))
            .and_then(Result::ok)
            .unwrap_or_default();
        assert_eq!(
            row(&rows[0])["source"],
            json!({ "id": "ollama", "kind": "local", "label": "Ollama" })
        );
        assert_eq!(
            row(&rows[1])["source"],
            json!({
                "id": "ollama-cloud",
                "kind": "api_key",
                "label": "Ollama Cloud",
                "requiresAuth": true
            })
        );
        assert_eq!(row(&rows[2])["source"]["label"], "LM Studio");
    }

    #[test]
    fn malformed_pi_replies_and_oversized_lists_are_refused() {
        assert!(read_pi_replies(&json!({ "success": false }), &state_reply()).is_err());
        assert!(!is_pi_reply(
            &models_reply(),
            "other",
            "get_available_models"
        ));
        assert!(is_pi_reply(
            &models_reply(),
            "ace-models",
            "get_available_models"
        ));
        let many: Vec<Value> = (0..513)
            .map(|n| json!({ "id": format!("m{n}"), "provider": "openai", "name": "M" }))
            .collect();
        let reply = json!({
            "type": "response", "id": "ace-models", "command": "get_available_models",
            "success": true, "data": { "models": many }
        });
        assert!(read_pi_replies(&reply, &state_reply()).is_err());
    }
}
