use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderModelCatalog {
    pub provider: String,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderModel {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default)]
    pub capabilities: ProviderModelCapabilities,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderModelCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
    pub supports_reasoning: bool,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub supports_parallel_tool_calls: bool,
    pub supports_subagents: bool,
    pub supports_attachments: bool,
}

#[must_use]
pub fn normalize_provider_model_catalog(
    provider: impl Into<String>,
    raw_payload: Value,
) -> ProviderModelCatalog {
    let provider = provider.into();
    let models = model_items(&raw_payload)
        .into_iter()
        .filter_map(|raw| normalize_model(&provider, raw))
        .collect();
    ProviderModelCatalog {
        provider,
        models,
        metadata: catalog_metadata(&raw_payload),
        raw_payload,
    }
}

fn normalize_model(default_provider: &str, raw: Value) -> Option<ProviderModel> {
    let id = first_string(
        &raw,
        &[
            "id", "model", "name", "slug", "modelId", "model_id", "value",
        ],
    )?;
    let display_name = first_string(
        &raw,
        &["displayName", "display_name", "label", "title", "name"],
    )
    .unwrap_or_else(|| id.clone());
    let provider = first_string(
        &raw,
        &[
            "provider",
            "providerId",
            "provider_id",
            "modelProvider",
            "model_provider",
        ],
    )
    .or_else(|| Some(default_provider.to_string()));
    let family = first_string(&raw, &["family", "modelFamily", "model_family", "series"]);
    let mut capabilities = ProviderModelCapabilities {
        context_window: first_u64(
            &raw,
            &[
                "contextWindow",
                "context_window",
                "contextLength",
                "context_length",
                "maxContextTokens",
                "max_context_tokens",
            ],
        ),
        max_output_tokens: first_u64(
            &raw,
            &[
                "maxOutputTokens",
                "max_output_tokens",
                "outputTokenLimit",
                "output_token_limit",
            ],
        ),
        default_reasoning_effort: first_string(
            &raw,
            &[
                "defaultReasoningEffort",
                "default_reasoning_effort",
                "reasoningEffort",
                "reasoning_effort",
            ],
        ),
        supports_reasoning: bool_or_capability(
            &raw,
            &["supportsReasoning", "reasoning", "reasoningSupported"],
            &["reasoning"],
        ),
        supports_vision: bool_or_capability(
            &raw,
            &["supportsVision", "vision", "visionSupported"],
            &["vision", "image", "images"],
        ),
        supports_tools: bool_or_capability(
            &raw,
            &["supportsTools", "tools", "toolUse", "tool_use"],
            &["tools", "tool_use", "function_calling"],
        ),
        supports_parallel_tool_calls: bool_or_capability(
            &raw,
            &[
                "supportsParallelToolCalls",
                "parallelToolCalls",
                "parallel_tool_calls",
            ],
            &["parallel_tool_calls"],
        ),
        supports_subagents: bool_or_capability(
            &raw,
            &["supportsSubagents", "subagents", "subAgents"],
            &["subagents", "sub_agents"],
        ),
        supports_attachments: bool_or_capability(
            &raw,
            &["supportsAttachments", "attachments", "files"],
            &["attachments", "files", "image", "images", "audio"],
        ),
    };
    if capabilities.supports_vision {
        capabilities.supports_attachments = true;
    }

    Some(ProviderModel {
        id,
        display_name,
        provider,
        family,
        capabilities,
        metadata: model_metadata(&raw),
        raw,
    })
}

fn model_items(raw: &Value) -> Vec<Value> {
    if let Some(items) = raw.as_array() {
        return items.clone();
    }
    [
        "models",
        "data",
        "items",
        "availableModels",
        "available_models",
    ]
    .iter()
    .find_map(|key| raw.get(*key).and_then(Value::as_array))
    .cloned()
    .unwrap_or_default()
}

fn catalog_metadata(raw: &Value) -> BTreeMap<String, Value> {
    let mut metadata = BTreeMap::new();
    if let Some(object) = raw.as_object() {
        for (key, value) in object {
            if !matches!(
                key.as_str(),
                "models" | "data" | "items" | "availableModels" | "available_models"
            ) {
                metadata.insert(key.clone(), value.clone());
            }
        }
    }
    metadata
}

fn model_metadata(raw: &Value) -> BTreeMap<String, Value> {
    let mut metadata = BTreeMap::new();
    if let Some(object) = raw.as_object() {
        for key in [
            "capabilities",
            "features",
            "supportedFeatures",
            "supported_features",
            "limits",
        ] {
            if let Some(value) = object.get(key) {
                metadata.insert(key.to_string(), value.clone());
            }
        }
    }
    metadata
}

fn first_string(raw: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value_at_deep(raw, key).and_then(value_to_string))
}

fn first_u64(raw: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value_at_deep(raw, key).and_then(value_to_u64))
}

fn bool_or_capability(raw: &Value, bool_keys: &[&str], capability_names: &[&str]) -> bool {
    bool_keys
        .iter()
        .find_map(|key| value_at_deep(raw, key).and_then(value_to_bool))
        .unwrap_or(false)
        || capability_names
            .iter()
            .any(|capability| has_capability(raw, capability))
}

fn has_capability(raw: &Value, capability: &str) -> bool {
    [
        "capabilities",
        "features",
        "supportedFeatures",
        "supported_features",
    ]
    .iter()
    .filter_map(|key| raw.get(*key))
    .any(|value| capability_value_contains(value, capability))
}

fn capability_value_contains(value: &Value, capability: &str) -> bool {
    match value {
        Value::Array(items) => items.iter().any(|item| {
            value_to_string(item)
                .map(|text| normalized_equals(&text, capability))
                .unwrap_or_else(|| capability_value_contains(item, capability))
        }),
        Value::Object(map) => map.iter().any(|(key, value)| {
            normalized_equals(key, capability) && value_to_bool(value).unwrap_or(true)
                || capability_value_contains(value, capability)
        }),
        _ => value_to_string(value)
            .map(|text| normalized_equals(&text, capability))
            .unwrap_or(false),
    }
}

fn value_at_deep<'a>(raw: &'a Value, key: &str) -> Option<&'a Value> {
    raw.get(key).or_else(|| {
        ["limits", "capabilities", "metadata"]
            .iter()
            .filter_map(|nested| raw.get(*nested))
            .find_map(|nested| value_at_deep(nested, key))
    })
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn value_to_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn value_to_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        },
        Value::Array(items) => Some(!items.is_empty()),
        Value::Object(map) => Some(!map.is_empty()),
        _ => None,
    }
}

fn normalized_equals(left: &str, right: &str) -> bool {
    normalize_token(left) == normalize_token(right)
}

fn normalize_token(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_model_catalog_from_common_shapes() {
        let raw = json!({
            "defaultProvider": "openai",
            "models": [
                {
                    "id": "gpt-5",
                    "displayName": "GPT-5",
                    "provider": "openai",
                    "family": "gpt",
                    "contextWindow": 256000,
                    "maxOutputTokens": "32000",
                    "capabilities": ["reasoning", "tools", "vision"],
                    "defaultReasoningEffort": "medium"
                }
            ]
        });

        let catalog = normalize_provider_model_catalog("codex", raw.clone());

        assert_eq!(catalog.provider, "codex");
        assert_eq!(catalog.raw_payload, raw);
        assert_eq!(catalog.metadata["defaultProvider"], "openai");
        assert_eq!(catalog.models.len(), 1);
        let model = &catalog.models[0];
        assert_eq!(model.id, "gpt-5");
        assert_eq!(model.display_name, "GPT-5");
        assert_eq!(model.provider.as_deref(), Some("openai"));
        assert_eq!(model.family.as_deref(), Some("gpt"));
        assert_eq!(model.capabilities.context_window, Some(256000));
        assert_eq!(model.capabilities.max_output_tokens, Some(32000));
        assert_eq!(
            model.capabilities.default_reasoning_effort.as_deref(),
            Some("medium")
        );
        assert!(model.capabilities.supports_reasoning);
        assert!(model.capabilities.supports_tools);
        assert!(model.capabilities.supports_vision);
        assert!(model.capabilities.supports_attachments);
        assert_eq!(model.raw["id"], "gpt-5");
    }

    #[test]
    fn normalizes_root_array_and_nested_capability_objects() {
        let catalog = normalize_provider_model_catalog(
            "future",
            json!([
                {
                    "model": "local-large",
                    "label": "Local Large",
                    "limits": { "context_length": "8192" },
                    "capabilities": {
                        "parallel_tool_calls": true,
                        "subagents": true,
                        "attachments": false
                    }
                }
            ]),
        );

        let model = &catalog.models[0];
        assert_eq!(model.id, "local-large");
        assert_eq!(model.display_name, "Local Large");
        assert_eq!(model.provider.as_deref(), Some("future"));
        assert_eq!(model.capabilities.context_window, Some(8192));
        assert!(model.capabilities.supports_parallel_tool_calls);
        assert!(model.capabilities.supports_subagents);
        assert!(!model.capabilities.supports_attachments);
    }
}
