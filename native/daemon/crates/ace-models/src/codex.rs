// SPDX-License-Identifier: Apache-2.0
//! Codex's `model/list` page as catalog rows.
//!
//! Ports `normalizeCodex` in `packages/models/src/normalize.ts`. A page is 512 rows at
//! most; the tier ids `priority` and `ultrafast` read as Fast and Ultrafast, and every
//! other tier keeps its native id without a speed.

use ace_protocol::generated::{CatalogModel, ModelTier};
use serde_json::{Map, Value};

use crate::instance::ModelInstance;
use crate::metadata::chat_metadata;
use crate::native::{NativeError, flag_or, label, labels, positive_int, required_label};
use crate::row::{base, nonzero, texts, validate_row};

const ROWS_LIMIT: usize = 512;
const EFFORTS_LIMIT: usize = 32;
const TIERS_LIMIT: usize = 32;

/// Codex's tier ids by speed: `priority` is Fast and `ultrafast` Ultrafast; others
/// (`flex`) aren't speeds.
fn codex_speed(id: &str) -> Option<&'static str> {
    match id {
        "priority" => Some("fast"),
        "ultrafast" => Some("ultrafast"),
        _ => None,
    }
}

struct NativeModel {
    raw: Value,
    id: String,
    display_name: String,
    is_default: bool,
    hidden: bool,
    deprecated: bool,
    context_window: Option<u64>,
    efforts: Vec<String>,
    default_effort: String,
    service_tiers: Vec<(String, String)>,
    additional_speed_tiers: Vec<String>,
    default_service_tier: Option<String>,
    input_modalities: Vec<String>,
}

fn parse_model(raw: &Value) -> Result<NativeModel, NativeError> {
    let entry = raw
        .as_object()
        .ok_or(NativeError("Malformed Codex model"))?;
    let id = required_label(entry, "model").ok_or(NativeError("Malformed Codex model"))?;
    // `id` is also required by the page schema even though rows use `model`.
    required_label(entry, "id").ok_or(NativeError("Malformed Codex model"))?;
    let display_name =
        required_label(entry, "displayName").ok_or(NativeError("Malformed Codex model"))?;
    let is_default = entry
        .get("isDefault")
        .and_then(Value::as_bool)
        .ok_or(NativeError("Malformed Codex model"))?;
    let hidden = flag_or(entry, "hidden", false);
    let deprecated = flag_or(entry, "deprecated", false);
    let context_window = match entry.get("contextWindow") {
        None | Some(Value::Null) => None,
        value => Some(positive_int(value).ok_or(NativeError("Malformed Codex model"))?),
    };
    let supported = entry
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .ok_or(NativeError("Malformed Codex model"))?;
    if supported.len() > EFFORTS_LIMIT {
        return Err(NativeError("Malformed Codex model"));
    }
    let mut efforts = Vec::with_capacity(supported.len());
    for option in supported {
        let option = option
            .as_object()
            .ok_or(NativeError("Malformed Codex model"))?;
        efforts.push(
            required_label(option, "reasoningEffort")
                .ok_or(NativeError("Malformed Codex model"))?,
        );
    }
    let default_effort = required_label(entry, "defaultReasoningEffort")
        .ok_or(NativeError("Malformed Codex model"))?;
    let service_tiers = match entry.get("serviceTiers") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(tiers)) => {
            if tiers.len() > TIERS_LIMIT {
                return Err(NativeError("Malformed Codex model"));
            }
            let mut parsed = Vec::with_capacity(tiers.len());
            for tier in tiers {
                let tier = tier
                    .as_object()
                    .ok_or(NativeError("Malformed Codex model"))?;
                parsed.push((
                    required_label(tier, "id").ok_or(NativeError("Malformed Codex model"))?,
                    required_label(tier, "name").ok_or(NativeError("Malformed Codex model"))?,
                ));
            }
            parsed
        }
        Some(_) => return Err(NativeError("Malformed Codex model")),
    };
    let additional_speed_tiers = match entry.get("additionalSpeedTiers") {
        None | Some(Value::Null) => Vec::new(),
        value => labels(value, TIERS_LIMIT).ok_or(NativeError("Malformed Codex model"))?,
    };
    let default_service_tier = match entry.get("defaultServiceTier") {
        None | Some(Value::Null) => None,
        value => Some(label(value).ok_or(NativeError("Malformed Codex model"))?),
    };
    let input_modalities = match entry.get("inputModalities") {
        None | Some(Value::Null) => Vec::new(),
        value => labels(value, EFFORTS_LIMIT).ok_or(NativeError("Malformed Codex model"))?,
    };
    Ok(NativeModel {
        raw: raw.clone(),
        id,
        display_name,
        is_default,
        hidden,
        deprecated,
        context_window,
        efforts,
        default_effort,
        service_tiers,
        additional_speed_tiers,
        default_service_tier,
        input_modalities,
    })
}

fn tier(id: &str, name: &str) -> ModelTier {
    let mut parameters = Map::new();
    parameters.insert("serviceTier".into(), Value::String(id.to_owned()));
    ModelTier {
        id: id.to_owned().into(),
        name: name.to_owned().into(),
        parameters,
        speed: codex_speed(id).map(str::to_owned),
    }
}

/// A `model/list` page's rows.
pub fn normalize_codex(
    payload: &Value,
    instance: &ModelInstance,
) -> Result<Vec<CatalogModel>, NativeError> {
    let page = payload
        .as_object()
        .ok_or(NativeError("Malformed Codex model page"))?;
    let data = page
        .get("data")
        .and_then(Value::as_array)
        .ok_or(NativeError("Malformed Codex model page"))?;
    if data.len() > ROWS_LIMIT {
        return Err(NativeError("Malformed Codex model page"));
    }
    match page.get("nextCursor") {
        None | Some(Value::Null) => {}
        value => {
            label(value).ok_or(NativeError("Malformed Codex model page"))?;
        }
    }
    let mut rows = Vec::new();
    for raw in data {
        if !chat_metadata(raw) {
            continue;
        }
        let native = parse_model(raw)?;
        let mut model = base(instance, &native.id, &native.display_name, &native.raw);
        model.is_default = native.is_default.into();
        model.hidden = native.hidden.into();
        model.deprecated = native.deprecated.into();
        model.context_window = native.context_window.and_then(nonzero);
        model.efforts = crate::effort::model_efforts(
            native
                .efforts
                .iter()
                .map(|id| crate::effort::EffortValue::id(id)),
        )
        .into();
        model.default_effort = crate::row::decoded_text(Some(&native.default_effort));
        model.default_tier = native
            .default_service_tier
            .as_deref()
            .and_then(|tier| crate::row::decoded_text(Some(tier)));
        let tiers: Vec<ModelTier> = if native.service_tiers.is_empty() {
            native
                .additional_speed_tiers
                .iter()
                .map(|id| tier(id, id))
                .collect()
        } else {
            native
                .service_tiers
                .iter()
                .map(|(id, name)| tier(id, name))
                .collect()
        };
        model.service_tiers = tiers.into();
        model.input_modalities = texts(native.input_modalities);
        validate_row(&model).map_err(|_| NativeError("Model row exceeds catalog limits"))?;
        rows.push(model);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/codex-speeds.test.ts`:
    //! "Codex's priority and ultrafast tiers become Fast and Ultrafast, and flex no
    //! speed". The smaller row assertions port the Codex rows in
    //! `packages/models/src/defaults.process.test.ts` ("Codex pages deduplicate model
    //! slugs and remove embedding and internal endpoints") and the dialog's default
    //! and effort fields.

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn instance() -> ModelInstance {
        ModelInstance::cli("codex", ProviderKind::Codex, "codex", "/repo")
    }

    fn payload(model: &str) -> Value {
        json!({
            "data": [{
                "id": format!("catalog-{model}"),
                "model": model,
                "displayName": model.to_uppercase(),
                "isDefault": true,
                "hidden": false,
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Low" },
                    { "reasoningEffort": "high", "description": "High" }
                ],
                "defaultReasoningEffort": "high",
                "inputModalities": ["text", "image"],
                "contextWindow": 200_000,
                "serviceTiers": [{ "id": "priority", "name": "Fast", "description": "Fast tier" }],
                "defaultServiceTier": "priority"
            }],
            "nextCursor": null
        })
    }

    fn row(model: &CatalogModel) -> Value {
        serde_json::to_value(model).unwrap_or(Value::Null)
    }

    #[test]
    fn codexs_priority_and_ultrafast_tiers_become_fast_and_ultrafast_and_flex_has_no_speed() {
        let mut page = payload("gpt-5");
        let native = &mut page["data"][0];
        native["serviceTiers"] = json!([
            { "id": "flex", "name": "Flex", "description": "Slower and cheaper" },
            { "id": "priority", "name": "Fast", "description": "Fast tier" },
            { "id": "ultrafast", "name": "Ultrafast", "description": "Fastest tier" }
        ]);
        let rows = normalize_codex(&page, &instance()).unwrap_or_default();
        let tiers = rows
            .first()
            .map(row)
            .and_then(|row| row["serviceTiers"].as_array().cloned())
            .unwrap_or_default();
        let seen: Vec<(String, Value, Value)> = tiers
            .iter()
            .map(|tier| {
                (
                    tier["id"].as_str().unwrap_or("").to_owned(),
                    tier.get("speed").cloned().unwrap_or(Value::Null),
                    tier["parameters"]["serviceTier"].clone(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                ("flex".to_owned(), Value::Null, json!("flex")),
                ("priority".to_owned(), json!("fast"), json!("priority")),
                (
                    "ultrafast".to_owned(),
                    json!("ultrafast"),
                    json!("ultrafast")
                ),
            ]
        );
    }

    #[test]
    fn a_codex_row_keeps_its_default_effort_efforts_and_input_modalities() {
        let rows = normalize_codex(&payload("coder"), &instance()).unwrap_or_default();
        let row = rows.first().map(row).unwrap_or(Value::Null);
        assert_eq!(row["id"], "coder");
        assert_eq!(row["displayName"], "Coder");
        assert_eq!(row["isDefault"], true);
        assert_eq!(row["contextWindow"], 200_000);
        assert_eq!(row["inputModalities"], json!(["text", "image"]));
        assert_eq!(row["defaultEffort"], "high");
        assert_eq!(row["defaultTier"], "priority");
        assert_eq!(
            row["efforts"],
            json!([
                { "id": "low", "level": "low", "label": "Low" },
                { "id": "high", "level": "high", "label": "High" }
            ])
        );
    }

    #[test]
    fn codex_embedding_and_internal_entries_are_not_listed() {
        let mut page = payload("chat");
        let mut embedding = page["data"][0].clone();
        embedding["model"] = json!("text-embedding-3-large");
        embedding["id"] = json!("catalog-embedding");
        embedding["type"] = json!("embedding");
        let mut internal = page["data"][0].clone();
        internal["model"] = json!("internal-router");
        internal["id"] = json!("catalog-internal");
        internal["internal"] = json!(true);
        page["data"] = json!([embedding, internal, page["data"][0].clone()]);
        let rows = normalize_codex(&page, &instance()).unwrap_or_default();
        let ids: Vec<&str> = rows.iter().map(|row| row.id.0.as_str()).collect();
        assert_eq!(ids, ["chat"]);
    }

    #[test]
    fn a_codex_page_over_512_rows_is_refused() {
        let mut page = payload("chat");
        let rows: Vec<Value> = (0..513).map(|_| page["data"][0].clone()).collect();
        page["data"] = json!(rows);
        assert_eq!(
            normalize_codex(&page, &instance()).err(),
            Some(NativeError("Malformed Codex model page"))
        );
    }
}
