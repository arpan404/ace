// SPDX-License-Identifier: Apache-2.0
//! The permission-mode vocabulary (`permission-modes.ts`): native modes per CLI, and the
//! modes an ACP agent reports, read leniently so one odd entry never hides the rest.

use ace_protocol::generated::ProviderKind;
use serde_json::{Value, json};

const MODE_LIMIT: usize = 128;
const CONFIGS_LIMIT: usize = 64;

fn record(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}

fn mode_entry(entry: &Value, id_key: &str) -> Option<Value> {
    let value = record(entry)?;
    let id = value.get(id_key)?.as_str()?;
    if !(1..=256).contains(&id.chars().count()) {
        return None;
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(id);
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    Some(json!({
        "id": id,
        "label": name.chars().take(256).collect::<String>(),
        "description": description.chars().take(2048).collect::<String>(),
        "risk": "medium",
    }))
}

fn presentation(entry: Value, provider: ProviderKind, profile: Option<&str>) -> Value {
    let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
    let full = (id == "yolo"
        && (provider == ProviderKind::Antigravity
            || profile == Some("gemini-043")
            || profile == Some("qwen-modern")))
        || (id == "bypassPermissions" && profile == Some("claude-bridge"))
        || (id == "agent-full-access" && profile == Some("codex-bridge"));
    if !full {
        return entry;
    }
    let mut object = entry.as_object().cloned().unwrap_or_default();
    object.insert("presentation".into(), json!("full-access"));
    Value::Object(object)
}

/// The modes an ACP agent reports (`acpPermissionModes`).
pub fn acp_permission_modes(
    raw: &Value,
    provider: ProviderKind,
    profile: Option<&str>,
) -> Vec<Value> {
    let presented = |entries: &[Value], id_key: &str| -> Vec<Value> {
        if entries.len() > MODE_LIMIT {
            return Vec::new();
        }
        entries
            .iter()
            .filter_map(|entry| mode_entry(entry, id_key))
            .map(|entry| presentation(entry, provider, profile))
            .collect()
    };
    let setup = record(raw).cloned().unwrap_or_default();
    let configs = setup
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for config_value in configs.iter().take(CONFIGS_LIMIT) {
        let Some(config) = record(config_value) else {
            continue;
        };
        let key = config
            .get("category")
            .and_then(Value::as_str)
            .or_else(|| config.get("id").and_then(Value::as_str));
        if !key.is_some_and(|key| matches!(key, "mode" | "permission" | "permissions")) {
            continue;
        }
        let options = config
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let flattened: Vec<Value> = options
            .iter()
            .flat_map(|option| {
                record(option)
                    .and_then(|option| option.get("options"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| vec![option.clone()])
            })
            .collect();
        return presented(&flattened, "value");
    }
    let modes = setup
        .get("modes")
        .and_then(record)
        .and_then(|modes| modes.get("availableModes"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    presented(&modes, "id")
}

#[cfg(test)]
mod tests {
    //! Ports `packages/provider-kit/src/permission-modes.ts`'s ACP half through
    //! `packages/models/src/session-write-order.test.ts`'s "modes reported A, then B,
    //! then A again are stored as A" and `acp-extensions.test.ts`'s mode lists.

    use super::*;

    #[test]
    fn available_modes_read_leniently_and_a_long_list_is_ignored() {
        let modes = acp_permission_modes(
            &json!({ "modes": { "availableModes": [
                { "id": "plan", "name": "plan" },
                { "id": "", "name": "nameless" },
                { "id": "yolo" }
            ]}}),
            ProviderKind::Antigravity,
            None,
        );
        assert_eq!(modes.len(), 2);
        assert_eq!(modes[0]["id"], "plan");
        assert_eq!(modes[0]["risk"], "medium");
        assert_eq!(modes[1]["presentation"], "full-access");
        let too_many: Vec<Value> = (0..129)
            .map(|index| json!({ "id": format!("m{index}") }))
            .collect();
        assert!(
            acp_permission_modes(
                &json!({ "modes": { "availableModes": too_many } }),
                ProviderKind::Acp,
                None
            )
            .is_empty()
        );
    }

    #[test]
    fn a_mode_config_option_wins_over_available_modes() {
        let modes = acp_permission_modes(
            &json!({
                "configOptions": [{
                    "id": "mode",
                    "category": "mode",
                    "options": [
                        { "value": "default", "name": "Default" },
                        { "value": "group", "options": [{ "value": "auto", "name": "Auto" }] }
                    ]
                }],
                "modes": { "availableModes": [{ "id": "ignored" }] }
            }),
            ProviderKind::Acp,
            None,
        );
        let ids: Vec<&str> = modes
            .iter()
            .filter_map(|mode| mode.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, ["default", "auto"]);
    }
}
