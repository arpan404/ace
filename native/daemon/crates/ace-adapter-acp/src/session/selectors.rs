// SPDX-License-Identifier: Apache-2.0
//! Session selector decoding and ACP permission/access mode tables
//! (`packages/agent-registry/src/selectors.ts`,
//! `packages/provider-kit/src/{permission-modes,access-modes}.ts`).

use ace_json::{Map, Value};
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};

use super::negotiation::CompatibilityProfile;
use super::protocol::agent_methods;
use crate::translate::data::{list, object};

const MAX_VALUES: usize = 512;
const MAX_CONFIG_OPTIONS: usize = 64;
const MAX_MODES: usize = 128;
const MAX_LABEL_UNITS: usize = 256;
/// `label = z.string().min(1).max(256)` (`selectors.ts:5`): a zod bound, so code points.
const MAX_LABEL_CODE_POINTS: usize = 256;
/// `category: z.string().max(128)` (`selectors.ts:11`): a zod bound, so code points.
const MAX_CATEGORY_CODE_POINTS: usize = 128;
const MAX_DESCRIPTION_UNITS: usize = 2048;

/// Unicode `Cc` (control), `Cf` (format), `Zl` (line separator), `Zp` (paragraph separator).
fn is_unsafe_text_char(ch: char) -> bool {
    if ch.is_control() {
        return true;
    }
    matches!(
        ch as u32,
        0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x2028..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
    )
}

fn is_safe_id(id: &str) -> bool {
    !id.chars().any(is_unsafe_text_char)
}

fn slice_utf16_units(text: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for ch in text.chars() {
        let len = ch.len_utf16();
        if units + len > max_units {
            break;
        }
        out.push(ch);
        units += len;
    }
    out
}

/// `text` with every control, bidi and invisible format character removed, bounded (`selectors.ts:41`).
pub fn display_label(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|ch| !is_unsafe_text_char(*ch))
        .collect();
    slice_utf16_units(cleaned.trim(), MAX_LABEL_UNITS)
}

fn parse_label(value: Option<&Value>) -> Option<String> {
    let text = value?.as_js_str()?;
    let code_points = text.as_str().chars().count();
    if code_points == 0 || code_points > MAX_LABEL_CODE_POINTS {
        return None;
    }
    Some(text.to_string())
}

fn ids(entries: &[Value], key: &str, max: usize) -> Option<Vec<String>> {
    if entries.len() > max {
        return None;
    }
    let mut out = Vec::new();
    for entry in entries {
        if let Some(id) = parse_label(object(entry).get(key)) {
            out.push(id);
        }
    }
    Some(out)
}

/// One listed model from legacy `models.availableModels` (`selectors.ts:45`–`:49`).
#[derive(Debug, Clone, PartialEq)]
pub struct ListedModel {
    pub model_id: String,
    pub name: String,
    pub native: Map,
}

/// Decoded legacy `models` list (`selectors.ts:56`–`:77`).
#[derive(Debug, Clone, PartialEq)]
pub struct ListedModels {
    pub models: Vec<ListedModel>,
    pub current: Option<String>,
}

pub fn listed_models(raw: &Value) -> Option<ListedModels> {
    let models = object(object(raw).get("models").unwrap_or(&Value::Null));
    let entries = models.get("availableModels")?.as_array()?;
    if entries.len() > MAX_VALUES {
        return None;
    }
    let mut seen = IndexSet::new();
    let mut listed = Vec::new();
    for entry in entries {
        let entry_map = object(entry);
        let Some(id) = parse_label(entry_map.get("modelId")) else {
            continue;
        };
        if !is_safe_id(&id) || !seen.insert(id.clone()) {
            continue;
        }
        let name = entry_map
            .get("name")
            .and_then(Value::as_str)
            .map(display_label)
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| id.clone());
        listed.push(ListedModel {
            model_id: id,
            name,
            native: entry_map.clone(),
        });
    }
    let current = parse_label(models.get("currentModelId"));
    Some(ListedModels {
        models: listed,
        current,
    })
}

fn select_values(options: &[Value]) -> Option<Vec<String>> {
    let mut values = Vec::new();
    for option in options {
        let entry = object(option);
        let found = if let Some(group) = entry.get("options").and_then(Value::as_array) {
            ids(group, "value", MAX_VALUES)?
        } else {
            ids(std::slice::from_ref(option), "value", 1)?
        };
        values.extend(found);
        if values.len() > MAX_VALUES {
            return None;
        }
    }
    Some(values)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectorKind {
    Model,
    Mode,
    Effort,
}

impl SelectorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SelectorKind::Model => "model",
            SelectorKind::Mode => "mode",
            SelectorKind::Effort => "effort",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectorSpec {
    pub config_id: Option<String>,
    pub method: String,
    pub values: Vec<String>,
}

/// Decoded session selectors (`selectors.ts:91`–`:109`).
#[derive(Debug, Clone, PartialEq)]
pub struct SelectorState {
    pub model: Option<SelectorSpec>,
    pub mode: Option<SelectorSpec>,
    pub effort: Option<SelectorSpec>,
    pub raw: Value,
}

impl Default for SelectorState {
    fn default() -> Self {
        Self {
            model: None,
            mode: None,
            effort: None,
            raw: Value::Object(Map::new()),
        }
    }
}

impl SelectorState {
    pub fn get(&self, kind: SelectorKind) -> Option<&SelectorSpec> {
        match kind {
            SelectorKind::Model => self.model.as_ref(),
            SelectorKind::Mode => self.mode.as_ref(),
            SelectorKind::Effort => self.effort.as_ref(),
        }
    }
}

/// Decode selectors from session setup or update (`selectors.ts:117`–`:162`).
pub fn session_selectors(
    raw: &Value,
    profile: Option<&CompatibilityProfile>,
    legacy_model: bool,
) -> SelectorState {
    if profile.is_some_and(|p| p.deny_selectors) {
        return SelectorState {
            model: None,
            mode: None,
            effort: None,
            raw: raw.clone(),
        };
    }
    let session = object(raw);
    let mut model: Option<SelectorSpec> = None;
    let mut mode: Option<SelectorSpec> = None;
    let mut effort: Option<SelectorSpec> = None;

    let config_options = list(session.get("configOptions").unwrap_or(&Value::Null));
    if config_options.len() <= MAX_CONFIG_OPTIONS {
        for entry in config_options {
            let map = object(entry);
            let Some(id) = parse_label(map.get("id")) else {
                continue;
            };
            if map.get("type").and_then(Value::as_str) != Some("select") {
                continue;
            }
            let Some(options) = map.get("options").and_then(Value::as_array) else {
                continue;
            };
            let category = map
                .get("category")
                .and_then(Value::as_js_str)
                .filter(|c| c.as_str().chars().count() <= MAX_CATEGORY_CODE_POINTS)
                .map(ToString::to_string);
            let Some(values) = select_values(options) else {
                continue;
            };
            // `selectors.ts`'s `!config.category` treats an empty category like an absent
            // one for the id-named model selector; the mode key below keeps it as it is.
            if model.is_none()
                && (category.as_deref() == Some("model")
                    || (category.as_deref().is_none_or(str::is_empty) && id == "model"))
            {
                model = Some(SelectorSpec {
                    config_id: Some(id.clone()),
                    method: agent_methods::SESSION_SET_CONFIG_OPTION.to_owned(),
                    values: values.iter().filter(|v| is_safe_id(v)).cloned().collect(),
                });
            }
            let mode_key = category.as_deref().unwrap_or(&id);
            if mode.is_none() && matches!(mode_key, "mode" | "permission" | "permissions") {
                mode = Some(SelectorSpec {
                    config_id: Some(id.clone()),
                    method: agent_methods::SESSION_SET_CONFIG_OPTION.to_owned(),
                    values: values.clone(),
                });
            }
            if effort.is_none()
                && (category.as_deref() == Some("thought_level") || id == "reasoning_effort")
            {
                effort = Some(SelectorSpec {
                    config_id: Some(id),
                    method: agent_methods::SESSION_SET_CONFIG_OPTION.to_owned(),
                    values,
                });
            }
        }
    }

    let model_ids: Option<Vec<String>> = listed_models(raw).map(|listed| {
        listed
            .models
            .into_iter()
            .map(|entry| entry.model_id)
            .collect()
    });
    let modes = object(session.get("modes").unwrap_or(&Value::Null));
    let mode_ids = modes
        .get("availableModes")
        .and_then(Value::as_array)
        .and_then(|entries| ids(entries, "id", MAX_MODES));

    if model.is_none()
        && legacy_model
        && let Some(values) = model_ids
        && !values.is_empty()
    {
        model = Some(SelectorSpec {
            config_id: None,
            method: agent_methods::SESSION_SET_MODEL.to_owned(),
            values,
        });
    }
    if mode.is_none()
        && let Some(values) = mode_ids
    {
        mode = Some(SelectorSpec {
            config_id: None,
            method: agent_methods::SESSION_SET_MODE.to_owned(),
            values,
        });
    }

    SelectorState {
        model,
        mode,
        effort,
        raw: raw.clone(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SelectorRequest {
    pub method: String,
    pub params: Map,
}

/// Build the JSON-RPC request for a listed selector value (`selectors.ts:163`–`:180`).
pub fn selector_request(
    selectors: &SelectorState,
    kind: SelectorKind,
    value: &str,
    session_id: &str,
) -> Result<SelectorRequest, String> {
    let Some(selector) = selectors.get(kind) else {
        return Err(format!("ACP {} selection unavailable", kind.as_str()));
    };
    if !selector.values.iter().any(|v| v == value) {
        return Err(format!("ACP {} selection unavailable", kind.as_str()));
    }
    let mut params = Map::with_capacity(3);
    params.insert("sessionId", Value::from(session_id));
    if let Some(config_id) = &selector.config_id {
        params.insert("configId", Value::from(config_id.as_str()));
        params.insert("value", Value::from(value));
    } else if kind == SelectorKind::Model {
        params.insert("modelId", Value::from(value));
    } else {
        params.insert("modeId", Value::from(value));
    }
    Ok(SelectorRequest {
        method: selector.method.clone(),
        params,
    })
}

/// Native permission mode entry (`permission-modes.ts:173`–`:230`).
pub fn acp_permission_modes(raw: &Value, provider: &str, profile_id: Option<&str>) -> Vec<Value> {
    let setup = object(raw);
    let presented = |entries: &[Value], id_key: &str| -> Vec<Value> {
        if entries.len() > MAX_MODES {
            return Vec::new();
        }
        let mut out = Vec::new();
        for entry in entries {
            let map = object(entry);
            let Some(id) = parse_label(map.get(id_key)) else {
                continue;
            };
            let label_src = map
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(&id);
            let description_src = map.get("description").and_then(Value::as_str).unwrap_or("");
            let mut mode = Map::with_capacity(5);
            mode.insert("id", Value::from(id.as_str()));
            mode.insert(
                "label",
                Value::from(slice_utf16_units(label_src, MAX_LABEL_UNITS)),
            );
            mode.insert(
                "description",
                Value::from(slice_utf16_units(description_src, MAX_DESCRIPTION_UNITS)),
            );
            mode.insert("risk", Value::from("medium"));
            let full = (id == "yolo"
                && (provider == "antigravity"
                    || profile_id == Some("gemini-043")
                    || profile_id == Some("qwen-modern")))
                || (id == "bypassPermissions" && profile_id == Some("claude-bridge"))
                || (id == "agent-full-access" && profile_id == Some("codex-bridge"));
            if full {
                mode.insert("presentation", Value::from("full-access"));
            }
            out.push(Value::Object(mode));
        }
        out
    };

    let config_options = list(setup.get("configOptions").unwrap_or(&Value::Null));
    if config_options.len() <= MAX_CONFIG_OPTIONS {
        for entry in config_options {
            let config = object(entry);
            let key = config
                .get("category")
                .and_then(Value::as_str)
                .or_else(|| config.get("id").and_then(Value::as_str));
            if !matches!(key, Some("mode" | "permission" | "permissions")) {
                continue;
            }
            let options = list(config.get("options").unwrap_or(&Value::Null));
            let mut flat = Vec::new();
            for option in options {
                if let Some(group) = object(option).get("options").and_then(Value::as_array) {
                    flat.extend(group.iter().cloned());
                } else {
                    flat.push(option.clone());
                }
            }
            return presented(&flat, "value");
        }
    }
    let modes = list(
        object(setup.get("modes").unwrap_or(&Value::Null))
            .get("availableModes")
            .unwrap_or(&Value::Null),
    );
    presented(modes, "id")
}

/// Access mode offers for ACP / Antigravity (`access-modes.ts:72`–`:115`).
pub fn access_mode_offers(
    provider: &str,
    profile_id: Option<&str>,
    available: &[String],
) -> Vec<Value> {
    let table: &[(&str, &str)] = if provider == "antigravity" {
        &[("full-access", "yolo")]
    } else if provider == "acp" {
        match profile_id {
            Some("gemini-043" | "qwen-modern") => &[
                ("read-only", "plan"),
                ("ask", "default"),
                ("full-access", "yolo"),
            ],
            Some("claude-bridge") => &[
                ("read-only", "plan"),
                ("ask", "default"),
                ("auto-review", "auto"),
                ("full-access", "bypassPermissions"),
            ],
            Some("codex-bridge") => &[
                ("read-only", "read-only"),
                ("auto-review", "agent"),
                ("full-access", "agent-full-access"),
            ],
            _ => &[],
        }
    } else {
        &[]
    };

    let mut offers = Vec::new();
    for &(mode, native) in table {
        if available.iter().any(|id| id == native) {
            let mut entry = Map::with_capacity(2);
            entry.insert("mode", Value::from(mode));
            entry.insert("native", Value::from(native));
            offers.push(Value::Object(entry));
        }
    }
    offers
}

#[cfg(test)]
mod tests {
    use super::session_selectors;
    use ace_json::json;

    /// `label` and `category` are zod bounds: code points, so an astral id fits at the
    /// limit and one past it does not (rule 17).
    #[test]
    fn selector_label_and_category_bounds_count_code_points() {
        let id = "\u{1F600}".repeat(256);
        assert_eq!(id.chars().count(), 256);
        assert_eq!(id.encode_utf16().count(), 512);
        let raw = json!({
            "configOptions": [{
                "id": id,
                "category": "model",
                "type": "select",
                "options": [{ "value": "a" }]
            }]
        });
        let selectors = session_selectors(&raw, None, false);
        assert_eq!(
            selectors
                .model
                .as_ref()
                .and_then(|m| m.config_id.as_deref()),
            Some(id.as_str())
        );
        let over = "\u{1F600}".repeat(257);
        let raw = json!({
            "configOptions": [{
                "id": over,
                "category": "model",
                "type": "select",
                "options": [{ "value": "a" }]
            }]
        });
        assert!(session_selectors(&raw, None, false).model.is_none());

        // `category: z.string().max(128)`: a kept category keys the option, a dropped one
        // falls back to the option's own id (here `mode`).
        let kept = "\u{1F600}".repeat(128);
        let raw = json!({
            "configOptions": [{
                "id": "mode",
                "category": kept,
                "type": "select",
                "options": [{ "value": "plan" }]
            }]
        });
        assert!(
            session_selectors(&raw, None, false).mode.is_none(),
            "128 code points are kept, so they key the option"
        );
        let dropped = "\u{1F600}".repeat(129);
        let raw = json!({
            "configOptions": [{
                "id": "mode",
                "category": dropped,
                "type": "select",
                "options": [{ "value": "plan" }]
            }]
        });
        assert!(
            session_selectors(&raw, None, false).mode.is_some(),
            "129 code points are dropped, so the id keys it"
        );
    }
}
