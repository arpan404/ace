//! The person's accepted plugins (ADR 0014) as Spade's bots use them (ADR 0151): `plugins.list`
//! and `plugins.spade` through the daemon's `pluginRequest` envelope, on the skill library's
//! socket. Hand-written mirrors of `packages/protocol/src/plugins.ts`; an execution of a kind
//! Spade doesn't know is kept raw, never dropped.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::skills::{AceSkills, SkillsError};

/// Mirrors `PluginInstall`: one accepted version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstall {
    pub name: String,
    pub version: String,
    pub commit: String,
    pub hash: String,
    #[serde(default)]
    pub accepted_at: u64,
}

/// An accepted plugin and whether ace has it on (`plugins.availability`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub install: PluginInstall,
    pub enabled: bool,
}

/// Mirrors `PluginSpade`: one accepted plugin with its components' text and its executions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpadePlugin {
    pub install: PluginInstall,
    pub enabled: bool,
    /// The accepted version's folder, which `${PLUGIN_ROOT}` names in a command.
    pub root: String,
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub executions: Vec<Execution>,
    #[serde(default)]
    pub unsupported: Vec<String>,
}

/// Mirrors `PluginSpadeComponent`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Component {
    /// `skill`, `command`, `agent` or `rule`; a kind added later is kept as sent.
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted: Option<String>,
    /// A skill's other files, by their path in its folder; fetched with
    /// [`AceSkills::plugin_file`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<PluginFile>,
}

/// Mirrors `PluginSpadeFile`: one of a plugin skill's files besides `SKILL.md`, as accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginFile {
    pub path: String,
    pub bytes: u64,
    pub hash: String,
    #[serde(default)]
    pub executable: bool,
}

/// Mirrors `PluginExecution`: something of the plugin's that runs, exactly as accepted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Execution {
    Known(KnownExecution),
    /// A kind this Spade doesn't know, as sent.
    Other(Value),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KnownExecution {
    Hook {
        event: String,
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        matcher: Option<String>,
    },
    Stdio {
        name: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        /// What its tools do, by tool name (ADR 0171): an effect word or a list of them.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        effects: BTreeMap<String, Value>,
    },
    Remote {
        name: String,
        /// `http` or `sse`.
        #[serde(rename = "type")]
        transport: String,
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

impl AceSkills {
    /// Every accepted plugin and whether ace has it on.
    pub async fn plugins(&self) -> Result<Vec<Installed>, SkillsError> {
        let response = self
            .plugin_request(&json!({ "type": "plugins.list" }))
            .await?;
        if response.get("type").and_then(Value::as_str) != Some("plugins.list") {
            return Err(unexpected(response));
        }
        let installs: Vec<PluginInstall> = match response.get("installs").cloned() {
            Some(value) => {
                serde_json::from_value(value).map_err(|_| unexpected(response.clone()))?
            }
            None => Vec::new(),
        };
        // A plugin with no saved policy is on (`PluginClientOperations.availability`).
        let off: Vec<&str> = response
            .get("availability")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|entry| entry.get("enabled").and_then(Value::as_bool) == Some(false))
            .filter_map(|entry| entry.get("name").and_then(Value::as_str))
            .collect();
        Ok(installs
            .into_iter()
            .map(|install| Installed {
                enabled: !off.contains(&install.name.as_str()),
                install,
            })
            .collect())
    }

    /// One accepted plugin as Spade uses it. A plugin ace doesn't have is the daemon's refusal.
    pub async fn plugin_for_spade(&self, name: &str) -> Result<SpadePlugin, SkillsError> {
        let response = self
            .plugin_request(&json!({ "type": "plugins.spade", "name": name }))
            .await?;
        if response.get("type").and_then(Value::as_str) != Some("plugins.spade") {
            return Err(unexpected(response));
        }
        response
            .get("plugin")
            .cloned()
            .and_then(|plugin| serde_json::from_value(plugin).ok())
            .ok_or_else(|| unexpected(response))
    }

    /// One file of an accepted plugin's skill, by its path in the plugin, with its content. The
    /// daemon reads it and checks it against the accepted hash; Spade never reads the folder.
    pub async fn plugin_file(&self, name: &str, path: &str) -> Result<Vec<u8>, SkillsError> {
        use base64::Engine as _;
        let response = self
            .plugin_request(&json!({ "type": "plugins.spadeFile", "name": name, "path": path }))
            .await?;
        if response.get("type").and_then(Value::as_str) != Some("plugins.spadeFile") {
            return Err(unexpected(response));
        }
        let content = response.get("content").and_then(Value::as_str);
        match content.map(|c| base64::engine::general_purpose::STANDARD.decode(c.as_bytes())) {
            Some(Ok(bytes)) => Ok(bytes),
            _ => Err(unexpected(response)),
        }
    }
}

fn unexpected(raw: Value) -> SkillsError {
    SkillsError::UnexpectedResult {
        kind: raw
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        raw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_execution_of_a_kind_spade_does_not_know_is_kept_as_sent() {
        let plugin: SpadePlugin = serde_json::from_value(json!({
            "install": {"name": "p", "version": "1", "commit": "c", "hash": "h", "acceptedAt": 1},
            "enabled": true,
            "root": "/r",
            "components": [{"kind": "rule", "name": "style", "path": "rules/style.md",
                "description": "", "text": "Use tabs."}],
            "executions": [
                {"kind": "hook", "event": "Stop", "command": "check"},
                {"kind": "lsp", "name": "x", "command": "y"},
            ],
            "unsupported": [],
        }))
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            plugin.executions[0],
            Execution::Known(KnownExecution::Hook {
                event: "Stop".into(),
                command: "check".into(),
                matcher: None
            })
        );
        assert!(matches!(&plugin.executions[1], Execution::Other(raw) if raw["kind"] == "lsp"));
        assert_eq!(plugin.components[0].text.as_deref(), Some("Use tabs."));
    }
}
