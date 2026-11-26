// SPDX-License-Identifier: Apache-2.0
//! Claude's `models` reply as catalog rows.
//!
//! Ports `normalizeClaude` in `packages/models/src/normalize.ts`. Effort defaults to
//! high when the model lists it (the platform's effort parameter default), the
//! `default` sentinel is a default-selector model, and fast mode is a service tier
//! carrying `fastMode` and `serviceTier` parameters.

use ace_protocol::generated::{CatalogModel, ModelTier};
use serde_json::{Map, Value};

use crate::instance::ModelInstance;
use crate::metadata::chat_metadata;
use crate::native::{NativeError, flag_or, labels, positive_int, required_label};
use crate::row::{base, decoded_text, nonzero, texts, validate_row};

const ROWS_LIMIT: usize = 512;
const EFFORTS_LIMIT: usize = 32;

struct NativeModel {
    raw: Value,
    value: String,
    display_name: String,
    resolved_model: Option<String>,
    effort_levels: Vec<String>,
    supports_fast_mode: Option<bool>,
    is_default: Option<bool>,
    context_window: Option<u64>,
    input_modalities: Vec<String>,
    deprecated: bool,
}

fn parse_model(raw: &Value) -> Result<NativeModel, NativeError> {
    let entry = raw
        .as_object()
        .ok_or(NativeError("Malformed Claude model"))?;
    let value = required_label(entry, "value").ok_or(NativeError("Malformed Claude model"))?;
    let display_name =
        required_label(entry, "displayName").ok_or(NativeError("Malformed Claude model"))?;
    let resolved_model = match entry.get("resolvedModel") {
        None | Some(Value::Null) => None,
        value => Some(crate::native::label(value).ok_or(NativeError("Malformed Claude model"))?),
    };
    let effort_levels = match entry.get("supportedEffortLevels") {
        None | Some(Value::Null) => Vec::new(),
        value => labels(value, EFFORTS_LIMIT).ok_or(NativeError("Malformed Claude model"))?,
    };
    let supports_fast_mode = match entry.get("supportsFastMode") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_bool()
                .ok_or(NativeError("Malformed Claude model"))?,
        ),
    };
    let is_default = match entry.get("isDefault") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_bool()
                .ok_or(NativeError("Malformed Claude model"))?,
        ),
    };
    let context_window = match entry.get("contextWindow") {
        None | Some(Value::Null) => None,
        value => Some(positive_int(value).ok_or(NativeError("Malformed Claude model"))?),
    };
    let input_modalities = match entry.get("inputModalities") {
        None | Some(Value::Null) => Vec::new(),
        value => labels(value, EFFORTS_LIMIT).ok_or(NativeError("Malformed Claude model"))?,
    };
    Ok(NativeModel {
        raw: raw.clone(),
        value,
        display_name,
        resolved_model,
        effort_levels,
        supports_fast_mode,
        is_default,
        context_window,
        input_modalities,
        deprecated: flag_or(entry, "deprecated", false),
    })
}

fn fast_tier() -> ModelTier {
    let mut parameters = Map::new();
    parameters.insert("fastMode".into(), Value::Bool(true));
    parameters.insert("serviceTier".into(), Value::String("fast".into()));
    ModelTier {
        id: "fast".to_owned().into(),
        name: "Fast".to_owned().into(),
        parameters,
        speed: Some("fast".into()),
    }
}

/// A Claude `models` reply's rows.
pub fn normalize_claude(
    payload: &Value,
    instance: &ModelInstance,
) -> Result<Vec<CatalogModel>, NativeError> {
    let reply = payload
        .as_object()
        .ok_or(NativeError("Malformed Claude model list"))?;
    let models = reply
        .get("models")
        .and_then(Value::as_array)
        .ok_or(NativeError("Malformed Claude model list"))?;
    if models.len() > ROWS_LIMIT {
        return Err(NativeError("Malformed Claude model list"));
    }
    let mut rows = Vec::new();
    for raw in models {
        if !chat_metadata(raw) {
            continue;
        }
        let native = parse_model(raw)?;
        let mut model = base(instance, &native.value, &native.display_name, &native.raw);
        model.resolved_model_id = decoded_text(native.resolved_model.as_deref());
        model.context_window = native.context_window.and_then(nonzero);
        model.efforts = crate::effort::model_efforts(
            native
                .effort_levels
                .iter()
                .map(|id| crate::effort::EffortValue::id(id)),
        )
        .into();
        // Claude's effort parameter defaults to high (platform.claude.com, effort).
        if native.effort_levels.iter().any(|level| level == "high") {
            model.default_effort = decoded_text(Some("high"));
        }
        model.input_modalities = texts(native.input_modalities);
        model.is_default = native
            .is_default
            .unwrap_or(native.value == "default")
            .into();
        model.deprecated = native.deprecated.into();
        model.service_tiers = if native.supports_fast_mode == Some(true) {
            vec![fast_tier()].into()
        } else {
            Vec::new().into()
        };
        validate_row(&model).map_err(|_| NativeError("Model row exceeds catalog limits"))?;
        rows.push(model);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    //! Ports the Claude rows of `packages/models/src/catalog-policy.test.ts`:
    //! "numeric flagship defaults advance without a hard-coded model id and migrate the
    //! default sentinel" (the `default` selector and explicit `isDefault`), and the
    //! fast/effort fields from the Claude payload the same file builds.

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn instance() -> ModelInstance {
        ModelInstance::cli("claude", ProviderKind::Claude, "claude", "/repo")
    }

    fn row(model: &CatalogModel) -> Value {
        serde_json::to_value(model).unwrap_or(Value::Null)
    }

    #[test]
    fn the_default_sentinel_and_the_explicit_flag_choose_the_default_row() {
        let payload = json!({
            "models": [
                { "value": "default", "displayName": "Default", "isDefault": true },
                { "value": "claude-opus-5-5", "displayName": "claude-opus-5-5" },
                { "value": "claude-sonnet-7", "displayName": "claude-sonnet-7", "isDefault": false }
            ]
        });
        let rows = normalize_claude(&payload, &instance()).unwrap_or_default();
        let rows: Vec<Value> = rows.iter().map(row).collect();
        assert_eq!(rows[0]["isDefault"], true);
        assert_eq!(rows[0]["displayName"], "Default");
        // Without a flag, only the sentinel is a default.
        assert_eq!(rows[1]["isDefault"], false);
        assert_eq!(rows[1]["displayName"], "Opus 5.5");
        assert_eq!(rows[2]["isDefault"], false);
    }

    #[test]
    fn effort_levels_map_to_the_scale_and_high_is_the_default_when_listed() {
        let payload = json!({
            "models": [
                {
                    "value": "claude-opus-5-5",
                    "displayName": "Claude Opus 5.5",
                    "supportedEffortLevels": ["low", "high", "extra-high"],
                    "inputModalities": ["text", "image"],
                    "contextWindow": 200_000
                },
                {
                    "value": "claude-haiku-4-5",
                    "displayName": "Claude Haiku 4.5",
                    "supportedEffortLevels": ["low", "medium"]
                }
            ]
        });
        let rows = normalize_claude(&payload, &instance()).unwrap_or_default();
        let opus = row(&rows[0]);
        assert_eq!(
            opus["efforts"],
            json!([
                { "id": "low", "level": "low", "label": "Low" },
                { "id": "high", "level": "high", "label": "High" },
                { "id": "extra-high", "level": "xhigh", "label": "XHigh" }
            ])
        );
        assert_eq!(opus["defaultEffort"], "high");
        assert_eq!(opus["contextWindow"], 200_000);
        assert_eq!(opus["inputModalities"], json!(["text", "image"]));
        assert_eq!(row(&rows[1])["defaultEffort"], Value::Null);
    }

    #[test]
    fn fast_mode_is_a_fast_service_tier_and_resolved_models_keep_their_id() {
        let payload = json!({
            "models": [{
                "value": "claude-opus-5-5",
                "displayName": "Claude Opus 5.5",
                "resolvedModel": "claude-opus-5-5-20260101",
                "supportsFastMode": true
            }]
        });
        let rows = normalize_claude(&payload, &instance()).unwrap_or_default();
        let row = row(&rows[0]);
        assert_eq!(row["resolvedModelId"], "claude-opus-5-5-20260101");
        assert_eq!(
            row["serviceTiers"],
            json!([{
                "id": "fast",
                "name": "Fast",
                "speed": "fast",
                "parameters": { "fastMode": true, "serviceTier": "fast" }
            }])
        );
    }

    #[test]
    fn an_oversized_claude_list_is_refused_and_a_257_emoji_name_is_a_row_error() {
        let models: Vec<Value> = (0..513)
            .map(|n| json!({ "value": format!("m{n}"), "displayName": "M" }))
            .collect();
        assert_eq!(
            normalize_claude(&json!({ "models": models }), &instance()).err(),
            Some(NativeError("Malformed Claude model list"))
        );
        let payload = json!({
            "models": [{
                "value": "m",
                "displayName": "🚀".repeat(257)
            }]
        });
        assert_eq!(
            normalize_claude(&payload, &instance()).err(),
            Some(NativeError("Malformed Claude model"))
        );
        let payload = json!({
            "models": [{
                "value": "m",
                "displayName": "🚀".repeat(256)
            }]
        });
        assert!(normalize_claude(&payload, &instance()).is_ok());
    }
}
