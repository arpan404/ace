// SPDX-License-Identifier: Apache-2.0
//! Cursor's SDK catalog as rows.
//!
//! Ports `packages/models/src/cursor.ts` (lenient SDK metadata), `cursor-variants.ts`
//! (only variants a local SDK run can select: standard context) and
//! `normalizeCursorSdk` in `packages/models/src/normalize.ts`.
//!
//! Only identity is required. Unused, nullable and future fields stay in the native
//! raw copy, and one broken entry never hides the healthy ones — unless every entry is
//! broken, which preserves the last good catalog instead of replacing it with none.

use ace_protocol::generated::{CatalogModel, ModelTier};
use serde_json::{Map, Value};
use std::sync::OnceLock;

use crate::effort::{EffortValue, is_thinking_toggle, listed_effort, model_efforts};
use crate::instance::ModelInstance;
use crate::metadata::chat_metadata;
use crate::native::label;
use crate::row::{base, decoded_text, validate_row};

const ENTRIES_LIMIT: usize = 512;
const PARAMETERS_LIMIT: usize = 32;
const VALUES_LIMIT: usize = 32;
const VARIANTS_LIMIT: usize = 128;
const VARIANT_PARAMS_LIMIT: usize = 16;
const VALUE_LIMIT: usize = 256;

/// Why a Cursor catalog cannot be normalized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorError {
    /// The payload is not an array of at most 512 entries.
    InvalidList,
    /// Every entry was broken.
    NoReadableModels,
    /// A reply field is malformed in a way the SDK schema refuses.
    Malformed(&'static str),
}

impl std::fmt::Display for CursorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidList => f.write_str("Cursor SDK returned an unreadable catalog"),
            Self::NoReadableModels => f.write_str("Cursor SDK returned no readable model entries"),
            Self::Malformed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for CursorError {}

/// A skipped SDK entry: its array index and a fixed reason, never vendor text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorModelRejection {
    pub index: usize,
    pub reason: &'static str,
}

const IDENTITY_REASON: &str =
    "Model identity must be a non-empty string of at most 256 characters.";
const OVER_LIMITS_REASON: &str = "Normalized model exceeds catalog field or row limits.";

/// A declared SDK parameter and the values it accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorParameter {
    pub id: String,
    pub values: Vec<String>,
}

/// An SDK variant and the parameters it sets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorVariant {
    pub display_name: String,
    pub is_default: Option<bool>,
    pub params: Vec<(String, String)>,
}

/// The optional metadata ace reads from an SDK entry; each field is caught alone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CursorMetadata {
    pub display_name: Option<String>,
    pub parameters: Option<Vec<CursorParameter>>,
    pub variants: Option<Vec<CursorVariant>>,
}

/// One readable SDK entry.
#[derive(Debug, Clone)]
pub struct CursorModel {
    pub index: usize,
    pub native: Value,
    pub metadata: CursorMetadata,
}

fn param_value(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (text.chars().count() <= VALUE_LIMIT).then(|| text.to_owned())
}

fn metadata(entry: &Value) -> CursorMetadata {
    let Some(entry) = entry.as_object() else {
        return CursorMetadata::default();
    };
    let display_name = label(entry.get("displayName"));
    let parameters = entry
        .get("parameters")
        .and_then(Value::as_array)
        .filter(|parameters| parameters.len() <= PARAMETERS_LIMIT)
        .and_then(|parameters| {
            parameters
                .iter()
                .map(|parameter| {
                    let parameter = parameter.as_object()?;
                    let id = label(parameter.get("id"))?;
                    let values = parameter.get("values")?.as_array()?;
                    if values.len() > VALUES_LIMIT {
                        return None;
                    }
                    Some(CursorParameter {
                        id,
                        values: values
                            .iter()
                            .map(|value| {
                                let value = value.as_object()?;
                                param_value(value.get("value"))
                            })
                            .collect::<Option<Vec<String>>>()?,
                    })
                })
                .collect::<Option<Vec<CursorParameter>>>()
        });
    let variants = entry
        .get("variants")
        .and_then(Value::as_array)
        .filter(|variants| variants.len() <= VARIANTS_LIMIT)
        .and_then(|variants| {
            variants
                .iter()
                .map(|variant| {
                    let variant = variant.as_object()?;
                    let display_name = label(variant.get("displayName"))?;
                    let is_default = variant.get("isDefault").and_then(Value::as_bool);
                    let params = variant.get("params")?.as_array()?;
                    if params.len() > VARIANT_PARAMS_LIMIT {
                        return None;
                    }
                    Some(CursorVariant {
                        display_name,
                        is_default,
                        params: params
                            .iter()
                            .map(|param| {
                                let param = param.as_object()?;
                                Some((label(param.get("id"))?, param_value(param.get("value"))?))
                            })
                            .collect::<Option<Vec<(String, String)>>>()?,
                    })
                })
                .collect::<Option<Vec<CursorVariant>>>()
        });
    CursorMetadata {
        display_name,
        parameters,
        variants,
    }
}

/// Every SDK entry with a usable identity; broken entries go to `rejected`.
pub fn decode_cursor_sdk_models(
    payload: &Value,
    rejected: &mut dyn FnMut(CursorModelRejection),
) -> Result<Vec<CursorModel>, CursorError> {
    let entries = payload.as_array().ok_or(CursorError::InvalidList)?;
    if entries.len() > ENTRIES_LIMIT {
        return Err(CursorError::InvalidList);
    }
    let mut models = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let id = entry.as_object().and_then(|entry| label(entry.get("id")));
        if id.is_none() {
            rejected(CursorModelRejection {
                index,
                reason: IDENTITY_REASON,
            });
            continue;
        }
        models.push(CursorModel {
            index,
            native: entry.clone(),
            metadata: metadata(entry),
        });
    }
    if !entries.is_empty() && models.is_empty() {
        return Err(CursorError::NoReadableModels);
    }
    Ok(models)
}

fn context_tokens(value: &str) -> Option<f64> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let pattern =
        PATTERN.get_or_init(|| regex::Regex::new(r"(?i)^(\d+(?:\.\d+)?)\s*([km]?)$").ok());
    let captures = pattern.as_ref()?.captures(value.trim())?;
    let number: f64 = captures.get(1)?.as_str().parse().ok()?;
    let unit = captures.get(2).map(|unit| unit.as_str()).unwrap_or("");
    Some(
        number
            * if unit.eq_ignore_ascii_case("m") {
                1_000_000.0
            } else if unit.eq_ignore_ascii_case("k") {
                1_000.0
            } else {
                1.0
            },
    )
}

fn context_of(variant: &CursorVariant) -> Option<f64> {
    variant
        .params
        .iter()
        .find(|(id, _)| id == "context")
        .and_then(|(_, value)| context_tokens(value))
}

/// The variants a local SDK run can select: a larger context is Max Mode, which
/// `ModelSelection` cannot request, so those variants are dropped.
pub fn selectable_variants(variants: &[CursorVariant]) -> Vec<CursorVariant> {
    let contexts: Vec<f64> = variants.iter().filter_map(context_of).collect();
    if contexts.is_empty() {
        return variants.to_vec();
    }
    let standard = contexts.iter().copied().fold(f64::INFINITY, f64::min);
    let kept: Vec<(usize, CursorVariant)> = variants
        .iter()
        .enumerate()
        .filter(|(_, variant)| context_of(variant).unwrap_or(standard) == standard)
        .map(|(index, variant)| (index, variant.clone()))
        .collect();
    let Some(listed) = variants
        .iter()
        .position(|variant| variant.is_default == Some(true))
    else {
        return kept.into_iter().map(|(_, variant)| variant).collect();
    };
    if kept.iter().any(|(index, _)| *index == listed) {
        return kept.into_iter().map(|(_, variant)| variant).collect();
    }
    let agreement = |variant: &CursorVariant| {
        variant
            .params
            .iter()
            .filter(|(id, value)| {
                variants[listed]
                    .params
                    .iter()
                    .any(|(other_id, other)| other_id == id && other == value)
            })
            .count()
    };
    let mut fallback: Option<usize> = None;
    for (index, (_, variant)) in kept.iter().enumerate() {
        match fallback {
            None => fallback = Some(index),
            Some(best) if agreement(variant) > agreement(&kept[best].1) => fallback = Some(index),
            _ => {}
        }
    }
    kept.into_iter()
        .enumerate()
        .map(|(index, (_, mut variant))| {
            variant.is_default = Some(Some(index) == fallback);
            variant
        })
        .collect()
}

fn effort_key(metadata: &CursorMetadata, variants: &[CursorVariant]) -> Option<String> {
    let is_effort = |id: &str| id == "reasoning_effort" || id == "effort" || id == "reasoning";
    if let Some(parameter) = metadata
        .parameters
        .as_ref()
        .and_then(|parameters| parameters.iter().find(|parameter| is_effort(&parameter.id)))
    {
        return Some(parameter.id.clone());
    }
    variants
        .iter()
        .flat_map(|variant| variant.params.iter())
        .find(|(id, _)| is_effort(id))
        .map(|(id, _)| id.clone())
}

fn has_fast_parameter(metadata: &CursorMetadata) -> bool {
    metadata.parameters.as_ref().is_some_and(|parameters| {
        parameters.iter().any(|parameter| {
            parameter.id == "fast" && parameter.values.iter().any(|value| value == "true")
        })
    })
}

fn tier(index: usize, variant: &CursorVariant) -> ModelTier {
    let fast = variant
        .params
        .iter()
        .any(|(id, value)| id == "fast" && value == "true");
    let mut parameters = Map::new();
    for (id, value) in &variant.params {
        parameters.insert(id.clone(), Value::String(value.clone()));
    }
    if fast {
        parameters.insert("serviceTier".into(), Value::String("fast".into()));
    }
    ModelTier {
        id: index.to_string().into(),
        name: variant.display_name.clone().into(),
        parameters,
        speed: fast.then(|| "fast".to_owned()),
    }
}

fn fast_tier() -> ModelTier {
    let mut parameters = Map::new();
    parameters.insert("fast".into(), Value::String("true".into()));
    parameters.insert("serviceTier".into(), Value::String("fast".into()));
    ModelTier {
        id: "fast".to_owned().into(),
        name: "Fast".to_owned().into(),
        parameters,
        speed: Some("fast".to_owned()),
    }
}

/// The SDK catalog's rows. Unusable rows are reported through `rejected` and dropped.
pub fn normalize_cursor_sdk(
    payload: &Value,
    instance: &ModelInstance,
    rejected: &mut dyn FnMut(CursorModelRejection),
) -> Result<Vec<CatalogModel>, CursorError> {
    let available: Vec<CursorModel> = decode_cursor_sdk_models(payload, rejected)?
        .into_iter()
        .filter(|model| chat_metadata(&model.native))
        .collect();
    let mut rows = Vec::new();
    for model in &available {
        let variants = model
            .metadata
            .variants
            .as_ref()
            .map(|variants| selectable_variants(variants));
        let id = model
            .native
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let display_name = model.metadata.display_name.as_deref().unwrap_or(id);
        let mut row = base(instance, id, display_name, &model.native);
        let mut tiers: Vec<ModelTier> = variants
            .as_ref()
            .map(|variants| {
                variants
                    .iter()
                    .enumerate()
                    .map(|(index, variant)| tier(index, variant))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(variants) = &variants
            && let Some(default) = variants
                .iter()
                .position(|variant| variant.is_default == Some(true))
        {
            row.default_tier = decoded_text(Some(&default.to_string()));
        }
        // Effort is a parameter, or folded into the variants; either way the picker
        // reads it as effort. On/off values switch thinking and are not effort.
        let key = effort_key(&model.metadata, variants.as_deref().unwrap_or_default());
        let values: Vec<String> = match (&model.metadata.parameters, &key) {
            (Some(parameters), Some(key)) => parameters
                .iter()
                .find(|parameter| &parameter.id == key)
                .map(|parameter| parameter.values.clone())
                .unwrap_or_default(),
            _ => variants
                .as_ref()
                .map(|variants| {
                    variants
                        .iter()
                        .flat_map(|variant| variant.params.iter())
                        .filter(|(id, _)| Some(id) == key.as_ref())
                        .map(|(_, value)| value.clone())
                        .collect()
                })
                .unwrap_or_default(),
        };
        let values: Vec<String> = values
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect();
        if is_thinking_toggle(values.iter().map(String::as_str)) {
            row.thinking_toggle = Some(true.into());
        }
        row.efforts = model_efforts(values.iter().map(|value| EffortValue::id(value))).into();
        if !tiers
            .iter()
            .any(|tier| tier.speed.as_deref() == Some("fast"))
            && has_fast_parameter(&model.metadata)
        {
            tiers.push(fast_tier());
        }
        row.service_tiers = tiers.into();
        let default_params = variants
            .as_ref()
            .and_then(|variants| {
                variants
                    .iter()
                    .find(|variant| variant.is_default == Some(true))
            })
            .map(|variant| variant.params.as_slice())
            .unwrap_or_default();
        let default_effort = key.as_ref().and_then(|key| {
            default_params
                .iter()
                .find(|(id, _)| id == key)
                .map(|(_, value)| value.as_str())
        });
        row.default_effort = decoded_text(listed_effort(row.efforts.as_slice(), default_effort));
        if validate_row(&row).is_err() {
            rejected(CursorModelRejection {
                index: model.index,
                reason: OVER_LIMITS_REASON,
            });
            continue;
        }
        rows.push(row);
    }
    if !available.is_empty() && rows.is_empty() {
        return Err(CursorError::NoReadableModels);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/cursor-sdk.test.ts` in full except the
    //! `cursorModelParams` half of its last two cases (execution selection, not the
    //! catalog): the row shapes, variant/effort/fast mapping, lenient metadata,
    //! rejection reasons and the row-limit isolation are all here, including the
    //! fixtures `testing/cursor-sdk-fixture.ts` defines.

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn instance() -> ModelInstance {
        ModelInstance::cli("sdk-a", ProviderKind::Cursor, "", "/workspace")
    }

    fn row(model: &CatalogModel) -> Value {
        serde_json::to_value(model).unwrap_or(Value::Null)
    }

    fn normalize(payload: Value) -> Result<Vec<CatalogModel>, CursorError> {
        normalize_cursor_sdk(&payload, &instance(), &mut |_| {})
    }

    #[test]
    fn keeps_sdk_authenticated_model_parameters_separate_from_guessed_acp_defaults() {
        let rows = normalize(json!([{
            "id": "composer-2.5",
            "displayName": "Composer 2.5",
            "parameters": [
                { "id": "reasoning_effort", "values": [{ "value": "high", "displayName": "High" }] }
            ],
            "variants": [{
                "displayName": "High effort",
                "isDefault": true,
                "params": [{ "id": "reasoning_effort", "value": "high" }]
            }],
            "future": { "setting": "retained", "apiKey": "sentinel-key" }
        }]))
        .unwrap_or_default();
        assert_eq!(rows.len(), 1);
        let row = row(&rows[0]);
        assert_eq!(row["instance"], "sdk-a");
        assert_eq!(row["id"], "composer-2.5");
        assert_eq!(
            row["efforts"],
            json!([{ "id": "high", "level": "high", "label": "High" }])
        );
        assert_eq!(row["defaultTier"], "0");
        assert_eq!(
            row["serviceTiers"],
            json!([{ "id": "0", "name": "High effort", "parameters": { "reasoning_effort": "high" } }])
        );
        assert!(
            row["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("retained")
        );
        assert!(
            !row["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("sentinel-key")
        );
        assert_eq!(row["contextWindow"], Value::Null);
        assert_eq!(row["defaultEffort"], "high");
    }

    #[test]
    fn accepts_the_full_sdk_catalog_including_empty_values_and_nullable_extensions() {
        let payload = json!([
            {
                "id": "composer-2.5",
                "displayName": "Composer 2.5",
                "aliases": ["composer"],
                "parameters": [
                    { "id": "reasoning_effort", "values": [{ "value": "" }, { "value": "high" }] },
                    { "id": "speed", "values": [{ "value": "fast" }, { "value": "" }] }
                ],
                "variants": [
                    {
                        "displayName": "Automatic",
                        "isDefault": true,
                        "params": [
                            { "id": "reasoning_effort", "value": "" },
                            { "id": "speed", "value": "" }
                        ]
                    },
                    { "displayName": "High effort", "params": [{ "id": "reasoning_effort", "value": "high" }] }
                ],
                "future": { "category": "new-enum-value", "apiKey": "sentinel-key" }
            },
            { "id": "minimal", "displayName": "Minimal" },
            { "id": "nullable", "displayName": null, "description": null, "aliases": null }
        ]);
        let rows = normalize(payload).unwrap_or_default();
        let ids: Vec<&str> = rows.iter().map(|row| row.id.0.as_str()).collect();
        assert_eq!(ids, ["composer-2.5", "minimal", "nullable"]);
        let composer = row(&rows[0]);
        assert_eq!(composer["aliases"], json!(["composer"]));
        assert_eq!(
            composer["efforts"],
            json!([{ "id": "high", "level": "high", "label": "High" }])
        );
        assert_eq!(composer["defaultTier"], "0");
        assert_eq!(
            composer["serviceTiers"],
            json!([
                { "id": "0", "name": "Automatic", "parameters": { "reasoning_effort": "", "speed": "" } },
                { "id": "1", "name": "High effort", "parameters": { "reasoning_effort": "high" } }
            ])
        );
        assert!(
            composer["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("new-enum-value")
        );
        assert!(
            !composer["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("sentinel-key")
        );
        assert_eq!(row(&rows[2])["displayName"], "Nullable");
    }

    #[test]
    fn keeps_healthy_sdk_models_when_one_entry_has_no_usable_identity() {
        let payload = json!([
            { "id": "composer-2.5", "displayName": "Composer 2.5" },
            { "id": "" },
            { "id": "minimal" },
            { "id": "nullable", "displayName": null },
            { "displayName": "no id" }
        ]);
        let mut rejected = Vec::new();
        let rows = normalize_cursor_sdk(&payload, &instance(), &mut |entry| rejected.push(entry))
            .unwrap_or_default();
        let ids: Vec<&str> = rows.iter().map(|row| row.id.0.as_str()).collect();
        assert_eq!(ids, ["composer-2.5", "minimal", "nullable"]);
        assert_eq!(
            rejected.iter().map(|entry| entry.index).collect::<Vec<_>>(),
            [1, 4]
        );
    }

    #[test]
    fn retains_optional_metadata_as_raw_data_when_it_cannot_be_used_for_controls() {
        let rows = normalize(json!([{
            "id": "usable",
            "parameters": [{ "id": "future", "values": null }],
            "variants": [{ "displayName": null, "params": "future-format" }],
            "aliases": [null]
        }]))
        .unwrap_or_default();
        let row = row(&rows[0]);
        assert_eq!(row["id"], "usable");
        assert_eq!(row["displayName"], "Usable");
        assert_eq!(row["serviceTiers"], json!([]));
        assert_eq!(row["efforts"], json!([]));
        assert!(
            row["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("future-format")
        );
    }

    #[test]
    fn reports_bounded_rejection_reasons_without_vendor_text_and_refuses_unreadable_lists() {
        let rejected = std::cell::RefCell::new(Vec::new());
        let broken = json!([{ "id": "private-vendor-value".repeat(100), "displayName": "private-name" }, null]);
        assert_eq!(
            normalize_cursor_sdk(&broken, &instance(), &mut |entry| rejected
                .borrow_mut()
                .push(entry))
            .err(),
            Some(CursorError::NoReadableModels)
        );
        let rejected = rejected.into_inner();
        assert_eq!(
            rejected.iter().map(|entry| entry.index).collect::<Vec<_>>(),
            [0, 1]
        );
        assert!(rejected.iter().all(|entry| entry.reason.len() <= 200));
        assert!(!format!("{rejected:?}").contains("private"));
        assert_eq!(
            normalize(json!({ "items": [] })).err(),
            Some(CursorError::InvalidList)
        );
        let too_many: Vec<Value> = (0..513).map(|_| json!({ "id": "model" })).collect();
        assert_eq!(
            normalize(Value::Array(too_many)).err(),
            Some(CursorError::InvalidList)
        );
    }

    #[test]
    fn isolates_a_model_that_exceeds_normalized_row_limits_from_healthy_models() {
        let variants: Vec<Value> = (0..32)
            .map(|index| {
                json!({
                    "displayName": format!("Variant {index}"),
                    "params": (0..16).map(|parameter| json!({
                        "id": format!("parameter-{parameter}"),
                        "value": "x".repeat(256)
                    })).collect::<Vec<_>>()
                })
            })
            .collect();
        let payload = json!([
            { "id": "oversized", "variants": variants },
            { "id": "healthy", "displayName": "Healthy" }
        ]);
        let mut rejected = Vec::new();
        let rows = normalize_cursor_sdk(&payload, &instance(), &mut |entry| rejected.push(entry))
            .unwrap_or_default();
        let ids: Vec<&str> = rows.iter().map(|row| row.id.0.as_str()).collect();
        assert_eq!(ids, ["healthy"]);
        assert_eq!(
            rejected,
            [CursorModelRejection {
                index: 0,
                reason: OVER_LIMITS_REASON
            }]
        );
    }

    #[test]
    fn exposes_account_reported_effort_and_fast_parameters_without_guessing_keys() {
        for key in ["effort", "reasoning", "reasoning_effort"] {
            let payload = json!([{
                "id": "native",
                "parameters": [
                    { "id": key, "values": [{ "value": "low" }, { "value": "high" }] },
                    { "id": "fast", "values": [{ "value": "false" }, { "value": "true" }] }
                ],
                "variants": [{
                    "displayName": "Default",
                    "isDefault": true,
                    "params": [
                        { "id": key, "value": "high" },
                        { "id": "context", "value": "300k" },
                        { "id": "fast", "value": "false" }
                    ]
                }]
            }]);
            let rows = normalize(payload).unwrap_or_default();
            let row = row(&rows[0]);
            assert_eq!(
                row["efforts"],
                json!([
                    { "id": "low", "level": "low", "label": "Low" },
                    { "id": "high", "level": "high", "label": "High" }
                ])
            );
            assert_eq!(row["defaultEffort"], "high");
            assert!(row["serviceTiers"].as_array().is_some_and(|tiers| {
                tiers.iter().any(|tier| {
                    tier["speed"] == "fast"
                        && tier["parameters"] == json!({ "fast": "true", "serviceTier": "fast" })
                })
            }));
        }
    }

    #[test]
    fn a_forty_variant_model_keeps_only_standard_context_variants_and_its_efforts() {
        // Claude Opus 4.8's real listing: thinking × context × effort × fast, default at 1m.
        let efforts = ["low", "medium", "high", "xhigh", "max"];
        let mut variants = Vec::new();
        for thinking in ["false", "true"] {
            for context in ["300k", "1m"] {
                for effort in efforts {
                    for fast in ["false", "true"] {
                        variants.push(json!({
                            "displayName": "Claude Opus 4.8",
                            "isDefault": thinking == "true" && context == "1m" && effort == "high" && fast == "false",
                            "params": [
                                { "id": "cyber", "value": "false" },
                                { "id": "thinking", "value": thinking },
                                { "id": "context", "value": context },
                                { "id": "effort", "value": effort },
                                { "id": "fast", "value": fast }
                            ]
                        }));
                    }
                }
            }
        }
        let payload = json!([{
            "id": "claude-opus-4-8",
            "displayName": "Claude Opus 4.8",
            "parameters": [
                { "id": "thinking", "values": [{ "value": "false" }, { "value": "true" }] },
                { "id": "context", "values": [{ "value": "300k" }, { "value": "1m" }] },
                { "id": "effort", "values": efforts.map(|value| json!({ "value": value })) },
                { "id": "fast", "values": [{ "value": "false" }, { "value": "true" }] }
            ],
            "variants": variants
        }]);
        let rows = normalize(payload).unwrap_or_default();
        let row = row(&rows[0]);
        let ids: Vec<&str> = row["efforts"]
            .as_array()
            .map(|efforts| efforts.iter().filter_map(|e| e["id"].as_str()).collect())
            .unwrap_or_default();
        assert_eq!(ids, efforts);
        let tiers = row["serviceTiers"].as_array().cloned().unwrap_or_default();
        assert!(tiers.len() <= 32);
        // The default was a Max Mode variant; the kept fallback agrees with it most.
        let default_index: usize = row["defaultTier"]
            .as_str()
            .and_then(|index| index.parse().ok())
            .unwrap_or(usize::MAX);
        assert!(default_index < tiers.len());
        for tier in &tiers {
            let params = tier["parameters"].as_object().cloned().unwrap_or_default();
            assert_eq!(params.get("context"), Some(&json!("300k")));
        }
        let fallback = &tiers[default_index];
        assert_eq!(
            fallback["parameters"],
            json!({
                "cyber": "false",
                "thinking": "true",
                "context": "300k",
                "effort": "high",
                "fast": "false"
            })
        );
    }
}
