// SPDX-License-Identifier: Apache-2.0
//! ACP sessions' model lists as catalog rows.
//!
//! Ports `normalizeAcp` in `packages/models/src/normalize.ts`, with the selector rules
//! from `packages/agent-registry/src/selectors.ts`: a `configOptions` model selector
//! (`session/set_config_option`) wins over the legacy `models.availableModels` list
//! (`session/set_model`), each malformed entry is read alone, and only ids the
//! session's own selector would send are listed.
//!
//! ACP's option semantics this file doesn't know are kept as raw metadata, never
//! guessed at: thought-level and `reasoning_effort` selects are efforts, a `fast`
//! boolean-select is a Fast tier, a `context` select is the context window, and every
//! other option rides in the row's bounded raw copy.

use ace_protocol::generated::{CatalogModel, ModelTier};
use serde_json::{Map, Value};
use std::sync::OnceLock;

use crate::effort::{EffortValue, model_efforts};
use crate::instance::ModelInstance;
use crate::metadata::chat_metadata;
use crate::native::label;
use crate::raw::raw_payload;
use crate::row::{base, decoded_text, nonzero, validate_row};

const MAX_CONFIG_OPTIONS: usize = 64;
const MAX_OPTIONS: usize = 512;
const MAX_VALUES: usize = 512;
const MAX_ROWS: usize = 512;

/// Why an ACP session cannot be listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpError {
    /// Neither a model selector nor a legacy list is present.
    MissingModelOptions,
    /// More than 512 rows after filtering.
    TooManyModels,
    /// A normalized row breaks the catalog bounds.
    Row(&'static str),
}

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingModelOptions => f.write_str("Missing model options"),
            Self::TooManyModels => f.write_str("Too many models"),
            Self::Row(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for AcpError {}

/// Control, format (bidi overrides and isolates, zero-width) and line/paragraph
/// separators. A label never shows them, and a model id carrying one is skipped.
fn unsafe_text() -> Option<&'static regex::Regex> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| regex::Regex::new(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]").ok())
        .as_ref()
}

fn has_unsafe_text(text: &str) -> bool {
    unsafe_text().is_some_and(|pattern| pattern.is_match(text))
}

/// A label with control, bidi and invisible characters removed, bounded to 256
/// UTF-16 units the way JavaScript's `.slice(0, 256)` is.
pub fn display_label(text: &str) -> String {
    let cleaned = unsafe_text()
        .map(|pattern| pattern.replace_all(text, "").into_owned())
        .unwrap_or_else(|| text.to_owned());
    let trimmed = cleaned.trim();
    let mut units = 0;
    let mut bounded = String::new();
    for character in trimmed.chars() {
        let width = character.len_utf16();
        if units + width > 256 {
            break;
        }
        units += width;
        bounded.push(character);
    }
    bounded
}

fn category(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (1..=256)
        .contains(&text.chars().count())
        .then(|| text.to_owned())
}

fn safe_id(id: &str) -> bool {
    !has_unsafe_text(id)
}

/// One selectable option, with whether its group marks it legacy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectOption {
    pub value: String,
    pub name: String,
    pub legacy: bool,
    pub raw: Value,
}

fn select_option(value: &Value) -> Option<SelectOption> {
    let entry = value.as_object()?;
    Some(SelectOption {
        value: label(entry.get("value"))?,
        name: label(entry.get("name"))?,
        legacy: false,
        raw: value.clone(),
    })
}

fn grouped_option(value: &Value) -> Option<Vec<SelectOption>> {
    let entry = value.as_object()?;
    let group = label(entry.get("group"))?;
    let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
    let legacy = regex::Regex::new(r"(?i)legacy|deprecated|retired")
        .ok()
        .is_some_and(|pattern| pattern.is_match(&format!("{group} {name}")));
    let options = entry.get("options")?.as_array()?;
    if options.len() > MAX_OPTIONS {
        return None;
    }
    let mut parsed = Vec::with_capacity(options.len());
    for option in options {
        // Grouped options are plain strings, unlike a top-level SelectOption.
        let option = option.as_object()?;
        let value = option.get("value")?.as_str()?.to_owned();
        let name = option.get("name")?.as_str()?.to_owned();
        parsed.push(SelectOption {
            value,
            name,
            legacy,
            raw: Value::Object(option.clone()),
        });
    }
    Some(parsed)
}

fn is_group(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|entry| entry.get("options").is_some_and(Value::is_array))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectConfig {
    pub id: String,
    pub category: Option<String>,
    pub current_value: Option<String>,
    pub options: Option<Vec<SelectOption>>,
}

impl SelectConfig {
    fn values(&self) -> Option<Vec<String>> {
        let options = self.options.as_ref()?;
        let mut values = Vec::new();
        for option in options {
            values.push(option.value.clone());
            if values.len() > MAX_VALUES {
                return None;
            }
        }
        Some(values)
    }

    fn is_model_config(&self) -> bool {
        (self.category.as_deref() == Some("model")
            || (self.category.is_none() && self.id == "model"))
            && self.values().is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigKind {
    Select(SelectConfig),
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigOption {
    pub raw: Value,
    pub kind: ConfigKind,
}

impl ConfigOption {
    fn is_select(&self) -> bool {
        matches!(self.kind, ConfigKind::Select(_))
    }

    fn select(&self) -> Option<&SelectConfig> {
        match &self.kind {
            ConfigKind::Select(config) => Some(config),
            ConfigKind::Other => None,
        }
    }
}

/// One config option, read alone: a malformed entry is skipped, not fatal.
pub fn parse_config_option(value: &Value) -> Option<ConfigOption> {
    let entry = value.as_object()?;
    let id = label(entry.get("id"))?;
    let category = category(entry.get("category"));
    let kind = match entry.get("type").and_then(Value::as_str)? {
        "select" => {
            let current_value = match entry.get("currentValue") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.as_str()?.to_owned()),
            };
            let options = match entry.get("options") {
                None | Some(Value::Null) => None,
                Some(Value::Array(items)) => {
                    if items.len() > MAX_OPTIONS {
                        return None;
                    }
                    let mut parsed = Vec::new();
                    for item in items {
                        if is_group(item) {
                            parsed.extend(grouped_option(item)?);
                        } else {
                            parsed.push(select_option(item)?);
                        }
                    }
                    Some(parsed)
                }
                Some(_) => return None,
            };
            ConfigKind::Select(SelectConfig {
                id,
                category,
                current_value,
                options,
            })
        }
        _ => ConfigKind::Other,
    };
    Some(ConfigOption {
        raw: value.clone(),
        kind,
    })
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

fn config_options(payload: &Value) -> Vec<ConfigOption> {
    let Some(options) = field(payload, "configOptions").and_then(Value::as_array) else {
        return Vec::new();
    };
    if options.len() > MAX_CONFIG_OPTIONS {
        return Vec::new();
    }
    options.iter().filter_map(parse_config_option).collect()
}

/// Whether the session carries a legacy `models.availableModels` list, well-formed or not.
fn has_legacy_list(payload: &Value) -> bool {
    field(payload, "models")
        .and_then(|models| field(models, "availableModels"))
        .is_some_and(Value::is_array)
}

struct ListedModel {
    model_id: String,
    name: String,
    raw: Value,
}

/// The legacy list, decoded leniently: an entry without a usable displayable id is
/// skipped, a duplicate keeps its first name, a missing name shows the id.
fn listed_models(payload: &Value) -> Option<(Vec<ListedModel>, Option<String>)> {
    let models = field(payload, "models")?.as_object()?;
    let entries = models.get("availableModels")?.as_array()?;
    if entries.len() > MAX_VALUES {
        return None;
    }
    let mut seen = Vec::new();
    let mut listed = Vec::new();
    for entry in entries {
        let Some(id) = entry
            .as_object()
            .and_then(|entry| label(entry.get("modelId")))
        else {
            continue;
        };
        if !safe_id(&id) || seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(display_label)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| id.clone());
        listed.push(ListedModel {
            model_id: id,
            name,
            raw: entry.clone(),
        });
    }
    let current = models
        .get("currentModelId")
        .and_then(|value| label(Some(value)));
    Some((listed, current))
}

/// The session's model selector: the first select with `model` semantics, else the
/// legacy list's ids through `session/set_model`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSelector {
    pub config_id: Option<String>,
    pub method: &'static str,
    pub values: Vec<String>,
}

fn model_selector(options: &[ConfigOption], payload: &Value) -> Option<ModelSelector> {
    for option in options {
        let Some(config) = option.select() else {
            continue;
        };
        if config.is_model_config() {
            let values = config
                .values()?
                .into_iter()
                .filter(|value| safe_id(value))
                .collect();
            return Some(ModelSelector {
                config_id: Some(config.id.clone()),
                method: "session/set_config_option",
                values,
            });
        }
    }
    let (listed, _) = listed_models(payload)?;
    if listed.is_empty() {
        return None;
    }
    Some(ModelSelector {
        config_id: None,
        method: "session/set_model",
        values: listed.into_iter().map(|model| model.model_id).collect(),
    })
}

fn per_model_configs(native: &Value) -> Option<Vec<ConfigOption>> {
    match field(native, "configOptions") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            if items.len() > MAX_CONFIG_OPTIONS {
                return None;
            }
            items
                .iter()
                .map(parse_config_option)
                .collect::<Option<Vec<ConfigOption>>>()
        }
        Some(_) => None,
    }
}

fn apply_config(model: &mut CatalogModel, configs: &[ConfigOption]) {
    for option in configs {
        let Some(config) = option.select() else {
            continue;
        };
        let values = config.options.clone().unwrap_or_default();
        if config.category.as_deref() == Some("thought_level") || config.id == "reasoning_effort" {
            model.efforts = model_efforts(
                values
                    .iter()
                    .map(|value| EffortValue::named(&value.value, &value.name)),
            )
            .into();
            if let Some(current) = config.current_value.as_deref() {
                model.default_effort = decoded_text(Some(current));
            }
        }
        if config.id == "fast" && values.iter().any(|option| option.value == "true") {
            let name = values
                .iter()
                .find(|option| option.value == "true")
                .map(|option| option.name.clone())
                .unwrap_or_else(|| "Fast".to_owned());
            let mut parameters = Map::new();
            parameters.insert(config.id.clone(), Value::String("true".into()));
            model.service_tiers = vec![ModelTier {
                id: "fast".to_owned().into(),
                name: name.into(),
                parameters,
                speed: Some("fast".to_owned()),
            }]
            .into();
            if config.current_value.as_deref() == Some("true") {
                model.default_tier = decoded_text(Some("fast"));
            }
        }
        if config.id == "context"
            && let Some(current) = config.current_value.as_deref()
            && let Some(tokens) = context_window(current)
        {
            model.context_window = nonzero(tokens);
        }
    }
}

fn context_window(value: &str) -> Option<u64> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex::Regex::new(r"(?i)^(\d+)([km])?$").ok());
    let captures = pattern.as_ref()?.captures(value.trim())?;
    let number: u64 = captures.get(1)?.as_str().parse().ok()?;
    let factor = match captures
        .get(2)
        .map(|unit| unit.as_str().to_ascii_lowercase())
    {
        Some(unit) if unit == "m" => 1_000_000,
        Some(unit) if unit == "k" => 1_000,
        _ => 1,
    };
    number.checked_mul(factor)
}

fn row_raw(native: &Value, configs: &[ConfigOption], session_extensions: &[Value]) -> Value {
    let mut raw = native.as_object().cloned().unwrap_or_default();
    raw.insert(
        "configOptions".into(),
        Value::Array(configs.iter().map(|config| config.raw.clone()).collect()),
    );
    if !session_extensions.is_empty() {
        raw.insert(
            "sessionConfigOptions".into(),
            Value::Array(session_extensions.to_vec()),
        );
    }
    Value::Object(raw)
}

/// An ACP session's rows.
pub fn normalize_acp(
    payload: &Value,
    instance: &ModelInstance,
) -> Result<Vec<CatalogModel>, AcpError> {
    let generic = instance.provider == ace_protocol::generated::ProviderKind::Acp
        && instance.acp_agent_id.is_some();
    let options = config_options(payload);
    let selector = model_selector(&options, payload);
    if generic && selector.is_none() {
        return Ok(Vec::new());
    }
    let model_config = options
        .iter()
        .filter_map(ConfigOption::select)
        .find(|config| {
            config.is_model_config()
                && Some(&config.id)
                    == selector
                        .as_ref()
                        .and_then(|selector| selector.config_id.as_ref())
        });
    if model_config.is_none() && !has_legacy_list(payload) {
        return Err(AcpError::MissingModelOptions);
    }
    let legacy = if model_config.is_some() {
        None
    } else {
        listed_models(payload)
    };
    let current = model_config
        .and_then(|config| config.current_value.clone())
        .or_else(|| legacy.as_ref().and_then(|(_, current)| current.clone()));
    let sendable = selector.as_ref().map(|selector| &selector.values);
    let mut sources: Vec<ListedModel> = if let Some(config) = model_config {
        config
            .options
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|option| ListedModel {
                model_id: option.value,
                name: display_label(&option.name),
                raw: option.raw,
            })
            .collect()
    } else {
        legacy.map(|(models, _)| models).unwrap_or_default()
    };
    sources.retain(|source| sendable.is_none_or(|values| values.contains(&source.model_id)));
    if sources.len() > MAX_ROWS {
        return Err(AcpError::TooManyModels);
    }
    let available: Vec<ListedModel> = sources
        .into_iter()
        .filter(|source| chat_metadata(&source.raw))
        .collect();
    let representative = available
        .iter()
        .position(|source| Some(&source.model_id) == current.as_ref())
        .unwrap_or(0);
    let session_configs: Vec<ConfigOption> = options.clone();
    let session_extensions: Vec<Value> = session_configs
        .iter()
        .filter(|config| !config.is_select())
        .map(|config| config.raw.clone())
        .collect();
    let mut rows = Vec::with_capacity(available.len());
    for (index, source) in available.iter().enumerate() {
        let mut model = base(instance, &source.model_id, &source.name, &source.raw);
        if let Some(config) = model_config {
            model.model_config_id = decoded_text(Some(&config.id));
            model.selector_method = decoded_text(Some("session/set_config_option"));
        } else if let Some(selector) = &selector {
            model.selector_method = decoded_text(Some(selector.method));
        }
        let is_default = Some(&source.model_id) == current.as_ref();
        model.is_default = is_default.into();
        let per_model = per_model_configs(&source.raw);
        let configs = match &per_model {
            Some(configs) => configs.clone(),
            None if is_default => session_configs.clone(),
            None => Vec::new(),
        };
        let include_session = index == representative
            && (per_model.is_some() || !is_default)
            && !session_extensions.is_empty();
        let raw = row_raw(
            &source.raw,
            &configs,
            if include_session {
                &session_extensions
            } else {
                &[]
            },
        );
        model.raw = {
            let payload = raw_payload(&raw);
            ace_protocol::generated::CatalogRaw {
                json: payload.json,
                truncated: payload.truncated,
            }
        };
        if !generic {
            apply_config(&mut model, &configs);
        }
        validate_row(&model).map_err(|error| AcpError::Row(error.0))?;
        rows.push(model);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/acp-legacy-models.test.ts` in full (six cases) and
    //! the normalize cases of `packages/models/src/acp-extensions.test.ts` (unknown
    //! option semantics, fallback rows, per-model efforts, session extensions and
    //! their redacted bounded raw copy). The catalog-update case at the end of
    //! acp-extensions belongs to the catalog service, not this parser.

    use super::*;
    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    fn agent(acp_agent_id: &str) -> ModelInstance {
        ModelInstance {
            label: None,
            acp_agent_id: Some(acp_agent_id.into()),
            ..ModelInstance::cli("agent", ProviderKind::Acp, "/never-executed", "/repo")
        }
    }

    fn local() -> ModelInstance {
        agent("local:custom")
    }

    /// A provider-level ACP instance with no agent id: the non-generic path, which
    /// applies per-model config options (acp-extensions' `instance("acp")`).
    fn plain() -> ModelInstance {
        ModelInstance::cli("agent", ProviderKind::Acp, "/never-executed", "/repo")
    }

    fn legacy(available_models: Value, current: &str) -> Value {
        json!({ "models": { "availableModels": available_models, "currentModelId": current } })
    }

    fn row(model: &CatalogModel) -> Value {
        serde_json::to_value(model).unwrap_or(Value::Null)
    }

    fn simple(rows: &[CatalogModel], keys: &[&str]) -> Vec<Vec<Value>> {
        rows.iter()
            .map(|model| {
                let row = row(model);
                keys.iter().map(|key| row[*key].clone()).collect()
            })
            .collect()
    }

    #[test]
    fn an_unprofiled_agent_lists_its_legacy_models_chosen_through_set_model() {
        let rows = normalize_acp(
            &legacy(
                json!([
                    { "modelId": "alpha", "name": "Alpha Model" },
                    { "modelId": "beta", "name": "Beta Model" }
                ]),
                "alpha",
            ),
            &local(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "displayName", "selectorMethod", "isDefault"]),
            [
                [
                    json!("alpha"),
                    json!("Alpha Model"),
                    json!("session/set_model"),
                    json!(true)
                ],
                [
                    json!("beta"),
                    json!("Beta Model"),
                    json!("session/set_model"),
                    json!(false)
                ]
            ]
        );
        // An official agent whose profile has no legacy dialect still lists the list.
        let rows = normalize_acp(
            &legacy(
                json!([
                    { "modelId": "alpha", "name": "Alpha Model" },
                    { "modelId": "beta", "name": "Beta Model" }
                ]),
                "alpha",
            ),
            &agent("official:qwen-code"),
        )
        .unwrap_or_default();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn a_malformed_legacy_list_lists_the_well_formed_models_and_never_throws() {
        let rows = normalize_acp(
            &legacy(
                json!([
                    null,
                    "bare",
                    { "name": "no id" },
                    { "modelId": 5, "name": "numeric" },
                    { "modelId": "alpha", "name": 12, "configOptions": "not a list" },
                    { "modelId": "alpha", "name": "Duplicate" }
                ]),
                "alpha",
            ),
            &local(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "displayName"]),
            [[json!("alpha"), json!("Alpha")]]
        );
    }

    #[test]
    fn an_oversized_legacy_list_gives_an_unprofiled_agent_no_models_instead_of_failing() {
        let many: Vec<Value> = (0..513)
            .map(|index| json!({ "modelId": format!("m{index}"), "name": "M" }))
            .collect();
        let rows = normalize_acp(&legacy(Value::Array(many), "m0"), &local()).unwrap_or_default();
        assert!(rows.is_empty());
    }

    #[test]
    fn model_names_lose_control_and_bidi_characters_and_ids_carrying_them_are_never_listed() {
        let rows = normalize_acp(
            &legacy(
                json!([
                    { "modelId": "alpha", "name": "Al\u{202e}pha\u{0} Pro\u{2066}" },
                    { "modelId": "spoof\u{202e}gpj", "name": "Spoof" }
                ]),
                "alpha",
            ),
            &local(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "displayName"]),
            [[json!("alpha"), json!("Alpha Pro")]]
        );
        let rows = normalize_acp(
            &json!({
                "configOptions": [{
                    "id": "picker",
                    "category": "model",
                    "type": "select",
                    "currentValue": "one",
                    "options": [
                        { "value": "one", "name": "One\u{200f}\u{7}" },
                        { "value": "two\u{2067}", "name": "Two" }
                    ]
                }]
            }),
            &local(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "displayName"]),
            [[json!("one"), json!("One")]]
        );
    }

    #[test]
    fn a_malformed_standard_selector_beside_a_well_formed_legacy_list_still_lists_the_legacy_models()
     {
        let rows = normalize_acp(
            &json!({
                "configOptions": [{ "id": "model", "category": "model", "type": "select", "options": "not a list" }],
                "models": {
                    "availableModels": [{ "modelId": "alpha" }, { "modelId": "beta" }]
                }
            }),
            &local(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "selectorMethod"]),
            [
                [json!("alpha"), json!("session/set_model")],
                [json!("beta"), json!("session/set_model")]
            ]
        );
    }

    #[test]
    fn a_malformed_legacy_list_beside_a_well_formed_selector_still_lists_the_selectors_models() {
        let rows = normalize_acp(
            &json!({
                "configOptions": [{
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "alpha",
                    "options": [
                        { "value": "alpha", "name": "Alpha" },
                        { "value": "beta", "name": "Beta" }
                    ]
                }],
                "models": { "availableModels": "not a list", "currentModelId": 7 }
            }),
            &local(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "selectorMethod"]),
            [
                [json!("alpha"), json!("session/set_config_option")],
                [json!("beta"), json!("session/set_config_option")]
            ]
        );
    }

    fn model_option() -> Value {
        json!({
            "id": "model",
            "type": "select",
            "currentValue": "a",
            "options": [
                { "value": "a", "name": "A" },
                { "value": "b", "name": "B" }
            ]
        })
    }

    #[test]
    fn unknown_option_semantics_preserve_models_and_bounded_redacted_raw_metadata() {
        let future = json!({
            "id": "reasoning_effort",
            "type": "boolean",
            "currentValue": true,
            "options": { "enabled": true },
            "metadata": { "description": "future setting", "apiKey": "private-value" }
        });
        let rows = normalize_acp(
            &json!({ "configOptions": [model_option(), future] }),
            &plain(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "isDefault"]),
            [[json!("a"), json!(true)], [json!("b"), json!(false)]]
        );
        let first = row(&rows[0]);
        assert_eq!(first["efforts"], json!([]));
        assert_eq!(first["defaultEffort"], Value::Null);
        assert_eq!(first["raw"]["truncated"], false);
        let raw: Value = serde_json::from_str(first["raw"]["json"].as_str().unwrap_or("null"))
            .unwrap_or(Value::Null);
        assert_eq!(raw["configOptions"][0], model_option());
        assert_eq!(raw["configOptions"][1]["metadata"]["apiKey"], "[redacted]");
        assert!(
            !row(&rows[1])["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("future setting")
        );
        let large = normalize_acp(
            &json!({
                "configOptions": [model_option(), {
                    "id": "reasoning_effort",
                    "type": "boolean",
                    "currentValue": true,
                    "extra": "x".repeat(4096)
                }]
            }),
            &plain(),
        )
        .unwrap_or_default();
        assert_eq!(row(&large[0])["raw"]["truncated"], true);
        assert!(row(&large[0])["raw"]["json"].as_str().unwrap_or("").len() <= 2048);
    }

    #[test]
    fn unknown_model_option_types_fall_back_to_legacy_rows_and_preserve_their_metadata() {
        let future =
            json!({ "id": "model", "type": "future", "currentValue": false, "options": [1, 2] });
        let rows = normalize_acp(
            &json!({
                "configOptions": [future],
                "models": {
                    "currentModelId": "legacy",
                    "availableModels": [{ "modelId": "legacy", "name": "Legacy" }]
                }
            }),
            &plain(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "isDefault"]),
            [[json!("legacy"), json!(true)]]
        );
        let raw: Value =
            serde_json::from_str(row(&rows[0])["raw"]["json"].as_str().unwrap_or("null"))
                .unwrap_or(Value::Null);
        assert_eq!(raw["configOptions"], json!([future]));
    }

    #[test]
    fn per_model_unknown_options_do_not_affect_known_select_effort_choices() {
        let rows = normalize_acp(
            &json!({
                "configOptions": [{
                    "id": "model",
                    "type": "select",
                    "currentValue": "a",
                    "options": [{
                        "value": "a",
                        "name": "A",
                        "configOptions": [
                            { "id": "future", "type": "range", "currentValue": 3, "options": { "min": 0, "max": 5 } },
                            { "id": "reasoning_effort", "type": "select", "currentValue": "high", "options": [{ "value": "high", "name": "High" }] }
                        ]
                    }]
                }]
            }),
            &plain(),
        )
        .unwrap_or_default();
        let row = row(&rows[0]);
        assert_eq!(row["id"], "a");
        assert_eq!(
            row["efforts"],
            json!([{ "id": "high", "level": "high", "label": "High" }])
        );
        assert_eq!(row["defaultEffort"], "high");
        assert!(
            row["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("\"currentValue\":3")
        );
    }

    #[test]
    fn empty_per_model_configs_preserve_session_extensions_without_inheriting_session_semantics() {
        let per_model = json!({ "id": "model-future", "type": "range", "currentValue": 3 });
        let session_extension = json!({
            "id": "session-future", "type": "boolean", "currentValue": true,
            "metadata": { "description": "session extension", "apiKey": "private-value" }
        });
        let session_effort = json!({
            "id": "reasoning_effort", "type": "select", "currentValue": "high",
            "options": [{ "value": "high", "name": "High" }]
        });
        let mut a = model_option();
        a["options"] = json!([
            { "value": "a", "name": "A", "configOptions": [] },
            { "value": "b", "name": "B", "configOptions": [per_model.clone()] }
        ]);
        let rows = normalize_acp(
            &json!({ "configOptions": [a, session_extension, session_effort] }),
            &plain(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "isDefault"]),
            [[json!("a"), json!(true)], [json!("b"), json!(false)]]
        );
        for model in &rows {
            let row = row(model);
            assert_eq!(row["efforts"], json!([]));
            assert_eq!(row["defaultEffort"], Value::Null);
            assert_eq!(row["raw"]["truncated"], false);
        }
        let first: Value =
            serde_json::from_str(row(&rows[0])["raw"]["json"].as_str().unwrap_or("null"))
                .unwrap_or(Value::Null);
        assert_eq!(first["configOptions"], json!([]));
        assert_eq!(
            first["sessionConfigOptions"][0]["metadata"]["apiKey"],
            "[redacted]"
        );
        let second: Value =
            serde_json::from_str(row(&rows[1])["raw"]["json"].as_str().unwrap_or("null"))
                .unwrap_or(Value::Null);
        assert_eq!(second["configOptions"], json!([per_model]));
        assert!(
            !row(&rows[1])["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("session extension")
        );
    }

    #[test]
    fn session_extensions_have_a_deterministic_representative_when_the_current_model_is_absent() {
        let per_model = json!({ "id": "model-future", "type": "range", "currentValue": 3 });
        let session_extension = json!({
            "id": "session-future", "type": "boolean", "currentValue": true,
            "metadata": { "description": "session extension", "apiKey": "private-value" }
        });
        let mut model = model_option();
        model["currentValue"] = json!("missing");
        model["options"] = json!([
            { "value": "a", "name": "A", "configOptions": [per_model.clone()] },
            { "value": "b", "name": "B" }
        ]);
        let rows = normalize_acp(
            &json!({ "configOptions": [model, session_extension] }),
            &plain(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "isDefault"]),
            [[json!("a"), json!(false)], [json!("b"), json!(false)]]
        );
        let first: Value =
            serde_json::from_str(row(&rows[0])["raw"]["json"].as_str().unwrap_or("null"))
                .unwrap_or(Value::Null);
        assert_eq!(first["configOptions"], json!([per_model]));
        assert_eq!(
            first["sessionConfigOptions"][0]["metadata"]["apiKey"],
            "[redacted]"
        );
        assert!(
            !row(&rows[1])["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("session extension")
        );
        for model in &rows {
            let row = row(model);
            assert_eq!(row["efforts"], json!([]));
            assert_eq!(row["defaultEffort"], Value::Null);
        }
    }

    #[test]
    fn session_extensions_choose_the_current_row_even_when_it_is_not_first() {
        let mut model = model_option();
        model["currentValue"] = json!("b");
        model["options"] = json!([
            { "value": "a", "name": "A", "configOptions": [] },
            { "value": "b", "name": "B", "configOptions": [] }
        ]);
        let session_extension = json!({
            "id": "session-future", "type": "boolean", "currentValue": true
        });
        let rows = normalize_acp(
            &json!({ "configOptions": [model, session_extension] }),
            &plain(),
        )
        .unwrap_or_default();
        assert_eq!(
            simple(&rows, &["id", "isDefault"]),
            [[json!("a"), json!(false)], [json!("b"), json!(true)]]
        );
        assert!(
            !row(&rows[0])["raw"]["json"]
                .as_str()
                .unwrap_or("")
                .contains("session extension")
        );
        let second: Value =
            serde_json::from_str(row(&rows[1])["raw"]["json"].as_str().unwrap_or("null"))
                .unwrap_or(Value::Null);
        assert_eq!(
            second["sessionConfigOptions"],
            json!([{ "id": "session-future", "type": "boolean", "currentValue": true }])
        );
    }

    #[test]
    fn a_fast_select_becomes_a_fast_tier_and_a_context_select_sets_the_window() {
        let rows = normalize_acp(
            &json!({
                "configOptions": [
                    {
                        "id": "model",
                        "type": "select",
                        "currentValue": "a",
                        "options": [{ "value": "a", "name": "A", "configOptions": [
                            { "id": "fast", "type": "select", "currentValue": "true",
                              "options": [{ "value": "false", "name": "Off" }, { "value": "true", "name": "Fast" }] },
                            { "id": "context", "type": "select", "currentValue": "200k",
                              "options": [{ "value": "200k", "name": "200K" }, { "value": "1m", "name": "1M" }] }
                        ] }]
                    }
                ]
            }),
            &plain(),
        )
        .unwrap_or_default();
        let row = row(&rows[0]);
        assert_eq!(row["contextWindow"], 200_000);
        assert_eq!(row["defaultTier"], "fast");
        assert_eq!(
            row["serviceTiers"],
            json!([{ "id": "fast", "name": "Fast", "speed": "fast", "parameters": { "fast": "true" } }])
        );
    }
}
