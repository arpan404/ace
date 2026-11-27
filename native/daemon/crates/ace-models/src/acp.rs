// SPDX-License-Identifier: Apache-2.0
//! ACP sessions' model lists as catalog rows.
//!
//! Ports `normalizeAcp` in `packages/models/src/normalize.ts`. The selector rules and
//! the reviewed compatibility profiles are `ace-adapter-acp`'s (already ported from
//! `packages/agent-registry/src/selectors.ts` and `profiles.ts`): a `configOptions`
//! model selector (`session/set_config_option`) wins over the legacy
//! `models.availableModels` list (`session/set_model`), a `denySelectors` profile
//! lists nothing, each malformed entry is read alone, and only ids the session's own
//! selector would send are listed.
//!
//! ACP's option semantics this file doesn't know are kept as raw metadata, never
//! guessed at: thought-level and `reasoning_effort` selects are efforts, a `fast`
//! boolean-select is a Fast tier, a `context` select is the context window, and every
//! other option rides in the row's bounded raw copy.

use std::sync::OnceLock;

use ace_adapter_acp::session::{display_label, listed_models, reviewed_profile, session_selectors};
use ace_json as aj;
use ace_protocol::generated::{CatalogModel, ModelTier};
use serde_json::{Map, Value};

use crate::effort::{EffortValue, model_efforts};
use crate::instance::ModelInstance;
use crate::metadata::chat_metadata;
use crate::native::label;
use crate::raw::raw_payload;
use crate::row::{base, decoded_text, nonzero, validate_row};

const MAX_CONFIG_OPTIONS: usize = 64;
const MAX_OPTIONS: usize = 512;
const MAX_ROWS: usize = 512;

/// Why an ACP session cannot be listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpError {
    /// Neither a model selector nor a legacy list is present.
    MissingModelOptions,
    /// More than 512 rows after filtering.
    TooManyModels,
    /// The session payload cannot be read at all.
    Malformed,
    /// A normalized row breaks the catalog bounds.
    Row(&'static str),
}

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingModelOptions => f.write_str("Missing model options"),
            Self::TooManyModels => f.write_str("Too many models"),
            Self::Malformed => f.write_str("Malformed ACP session"),
            Self::Row(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for AcpError {}

/// The adapter's decoded value as this crate's JSON; both are JSON, so this cannot change it.
fn to_ace(value: &Value) -> Option<aj::Value> {
    aj::parse(&serde_json::to_string(value).ok()?).ok()
}

fn from_ace(value: &aj::Value) -> Option<Value> {
    serde_json::from_str(&aj::ser::to_string(value).ok()?).ok()
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

fn category(entry: &Map<String, Value>) -> Option<Option<String>> {
    match entry.get("category") {
        None | Some(Value::Null) => Some(None),
        // `native-schemas.ts`'s `SelectConfigOption.category` is a label when present.
        Some(Value::String(text)) => {
            let count = text.chars().count();
            (1..=256).contains(&count).then(|| Some(text.clone()))
        }
        Some(_) => None,
    }
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
        let mut option = select_option(option)?;
        option.legacy = legacy;
        if legacy {
            // `options()` assigns `legacy: true` onto the value it keeps as raw.
            if let Some(raw) = option.raw.as_object_mut() {
                raw.insert("legacy".into(), Value::Bool(true));
            }
        }
        parsed.push(option);
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
    let category = category(entry)?;
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

struct Source {
    model_id: String,
    name: String,
    raw: Value,
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
    let ace_payload = to_ace(payload).ok_or(AcpError::Malformed)?;
    let profile = instance
        .acp_agent_id
        .as_deref()
        .and_then(|id| id.strip_prefix("official:"))
        .and_then(|agent| {
            reviewed_profile(
                agent,
                instance.installation_version.as_deref().unwrap_or(""),
            )
        });
    let selectors = session_selectors(&ace_payload, profile.as_ref(), true);
    if generic && selectors.model.is_none() {
        return Ok(Vec::new());
    }
    let options = config_options(payload);
    let model_config = selectors
        .model
        .as_ref()
        .and_then(|selector| selector.config_id.as_ref())
        .and_then(|config_id| {
            options
                .iter()
                .filter_map(ConfigOption::select)
                .find(|config| &config.id == config_id)
        });
    if model_config.is_none() && !has_legacy_list(payload) {
        return Err(AcpError::MissingModelOptions);
    }
    let legacy = if model_config.is_some() {
        None
    } else {
        listed_models(&ace_payload)
    };
    let current = model_config
        .and_then(|config| config.current_value.clone())
        .or_else(|| legacy.as_ref().and_then(|listed| listed.current.clone()));
    let sendable = selectors.model.as_ref().map(|selector| &selector.values);
    let mut sources: Vec<Source> = if let Some(config) = model_config {
        config
            .options
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|option| {
                // `displayLabel(option.name) || option.value`.
                let cleaned = display_label(&option.name);
                let name = if cleaned.is_empty() {
                    option.value.clone()
                } else {
                    cleaned
                };
                Source {
                    model_id: option.value,
                    name,
                    raw: option.raw,
                }
            })
            .collect()
    } else {
        let mut sources = Vec::new();
        if let Some(listed) = legacy {
            for model in listed.models {
                let raw = from_ace(&aj::Value::Object(model.native)).ok_or(AcpError::Malformed)?;
                sources.push(Source {
                    model_id: model.model_id,
                    name: model.name,
                    raw,
                });
            }
        }
        sources
    };
    sources.retain(|source| sendable.is_none_or(|values| values.contains(&source.model_id)));
    if sources.len() > MAX_ROWS {
        return Err(AcpError::TooManyModels);
    }
    let available: Vec<Source> = sources
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
        }
        if let Some(selector) = &selectors.model {
            model.selector_method = decoded_text(Some(&selector.method));
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
    fn a_deny_selectors_profile_lists_no_models_for_an_official_agent() {
        let payload = json!({ "configOptions": [model_option()] });
        let mut old = agent("official:qwen-code");
        old.installation_version = Some("0.0.14".into());
        assert!(normalize_acp(&payload, &old).unwrap_or_default().is_empty());
        let mut modern = agent("official:qwen-code");
        modern.installation_version = Some("0.24.7".into());
        assert_eq!(
            normalize_acp(&payload, &modern).unwrap_or_default().len(),
            2
        );
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

    #[test]
    fn an_empty_category_reads_as_the_id_named_model_selector() {
        // selectors.ts's `!config.category` treats "" like an absent category, so the
        // option `id: "model"` is the model selector, and its values still filter a
        // legacy list. Without a legacy list TS throws "Missing model options".
        let option = json!({
            "id": "model",
            "category": "",
            "type": "select",
            "currentValue": "a",
            "options": [{ "value": "a", "name": "A" }]
        });
        assert_eq!(
            normalize_acp(&json!({ "configOptions": [option.clone()] }), &local()).err(),
            Some(AcpError::MissingModelOptions)
        );
        let rows = normalize_acp(
            &json!({
                "configOptions": [option],
                "models": { "availableModels": [{ "modelId": "a" }, { "modelId": "b" }] }
            }),
            &local(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        // Measured against `normalizeAcp`: one row, and the selector it was read through
        // (the config option itself is dropped, so the legacy list supplies the row).
        assert_eq!(
            simple(&rows, &["id", "selectorMethod"]),
            [[json!("a"), json!("session/set_config_option")]]
        );
    }

    #[test]
    fn a_grouped_legacy_option_keeps_the_legacy_flag_in_its_raw_copy() {
        let rows = normalize_acp(
            &json!({
                "configOptions": [{
                    "id": "model",
                    "type": "select",
                    "currentValue": "a",
                    "options": [{
                        "group": "Legacy models",
                        "options": [{ "value": "a", "name": "A" }]
                    }]
                }]
            }),
            &local(),
        )
        .unwrap_or_default();
        assert_eq!(rows.len(), 1);
        let raw: Value =
            serde_json::from_str(row(&rows[0])["raw"]["json"].as_str().unwrap_or("null"))
                .unwrap_or(Value::Null);
        // The row's native entry is the grouped option itself, which `options()`
        // marked legacy.
        assert_eq!(raw["legacy"], true);
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
