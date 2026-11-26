// SPDX-License-Identifier: Apache-2.0
//! Layers, paths and precedence (`service.ts`: `path`, `globalOnlyKeys`, `resolve`).
//!
//! Effective value order is environment overrides, then thread, workspace and global
//! files, then the shipped defaults. A key only the global layer may set is skipped in
//! every other layer, so a repository cannot turn it on for itself.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::schema::{default_value, is_key, validate_value};
use crate::validation::{SettingsCode, SettingsError};

/// Where a value came from, as the protocol's `SettingsProvenance`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    Defaults,
    Global,
    Workspace,
    Thread,
    Environment,
}

impl Provenance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Defaults => "defaults",
            Self::Global => "global",
            Self::Workspace => "workspace",
            Self::Thread => "thread",
            Self::Environment => "environment",
        }
    }
}

/// A place a setting may live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Layer {
    Global,
    Workspace { workspace: PathBuf },
    Thread { thread: String },
}

impl Layer {
    pub fn kind(&self) -> Provenance {
        match self {
            Self::Global => Provenance::Global,
            Self::Workspace { .. } => Provenance::Workspace,
            Self::Thread { .. } => Provenance::Thread,
        }
    }

    /// The file a layer writes, under the daemon's data directory.
    pub fn path(&self, data_dir: &std::path::Path) -> Result<PathBuf, SettingsError> {
        match self {
            Self::Global => Ok(data_dir.join("settings.json")),
            Self::Workspace { workspace } => Ok(workspace.join(".ace").join("settings.json")),
            Self::Thread { thread } => {
                let valid = (1..=128).contains(&thread.chars().count())
                    && thread
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
                if !valid {
                    return Err(SettingsError::new(
                        SettingsCode::Validation,
                        "Invalid thread settings ID",
                    ));
                }
                Ok(data_dir.join("threads").join(thread).join("settings.json"))
            }
        }
    }
}

/// Keys only the global layer may set: a workspace or thread value is ignored.
pub fn global_only(key: &str) -> bool {
    matches!(
        key,
        "computer.lockedUse"
            | "spade.enabled"
            | "beta.spade"
            | "beta.marketplace"
            | "market.askBeforeAgentPublish"
            | "providers.codex.toolSource"
            | "providers.claude.chrome"
            | "remote.machineLocalhost"
    )
}

/// Whether `key` may be written on `layer`, with the TypeScript's own refusal.
pub fn placement(key: &str, layer: &Layer) -> Result<(), SettingsError> {
    let global = matches!(layer, Layer::Global);
    let refusal = |message: &str| Err(SettingsError::new(SettingsCode::Validation, message));
    if !global {
        if key == "providers.configuration" {
            return refusal("Provider configuration is a global user setting");
        }
        if key == "projects.roots" {
            return refusal("Project folders are a global user setting");
        }
        if key.starts_with("browser.download") {
            return refusal("The downloads folder is a global daemon setting");
        }
        if key == "computer.blockedApps" {
            return refusal("Apps agents can't use is a global setting");
        }
        if key == "spade.enabled" {
            return refusal("Running Spade is a global setting");
        }
        if key.starts_with("beta.") {
            return refusal("Beta features are a global setting");
        }
        if global_only(key) {
            return refusal("Working while this Mac is locked is a global setting");
        }
        if crate::roles::role_setting(key) {
            return refusal("Roles are a global setting");
        }
        if key.starts_with("generation.") {
            return refusal("Generation settings belong to the daemon");
        }
    }
    Ok(())
}

/// One resolved setting.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub key: String,
    pub value: Value,
    pub provenance: Provenance,
    pub local_value: Option<Value>,
}

/// One layer file's settings, in order from global to thread.
pub struct LayerValues<'a> {
    pub layer: Provenance,
    pub settings: &'a BTreeMap<String, Value>,
}

/// `resolve`: overrides, then thread, workspace and global, then the default.
pub fn resolve(
    key: &str,
    layers: &[LayerValues<'_>],
    overrides: &BTreeMap<String, Value>,
    requested: Option<Provenance>,
) -> Entry {
    if let Some(value) = overrides.get(key) {
        return Entry {
            key: key.to_owned(),
            value: value.clone(),
            provenance: Provenance::Environment,
            local_value: None,
        };
    }
    for values in layers.iter().rev() {
        if values.layer != Provenance::Global && global_only(key) {
            continue;
        }
        if let Some(value) = values.settings.get(key) {
            let local = (Some(values.layer) == requested).then(|| value.clone());
            return Entry {
                key: key.to_owned(),
                value: value.clone(),
                provenance: values.layer,
                local_value: local,
            };
        }
    }
    Entry {
        key: key.to_owned(),
        value: default_value(key).unwrap_or(Value::Null),
        provenance: Provenance::Defaults,
        local_value: None,
    }
}

/// Checks a batch's shape: 1 to 32 keys, each named once, each known, each placed.
pub fn check_batch<'a>(
    keys: impl IntoIterator<Item = &'a str>,
    layer: &Layer,
) -> Result<Vec<&'a str>, SettingsError> {
    let keys: Vec<&str> = keys.into_iter().collect();
    if keys.is_empty() || keys.len() > 32 {
        return Err(SettingsError::new(
            SettingsCode::Limit,
            "Set between 1 and 32 settings at once",
        ));
    }
    let mut seen = Vec::new();
    for key in &keys {
        if seen.contains(key) {
            return Err(SettingsError::new(
                SettingsCode::Validation,
                "Each setting can be set once per change",
            ));
        }
        seen.push(*key);
        if !is_key(key) {
            return Err(SettingsError::new(
                SettingsCode::Validation,
                "Unknown settings key",
            ));
        }
        placement(key, layer)?;
    }
    Ok(keys)
}

/// Checks one override map at construction, refusing an unknown key or value.
pub fn validate_overrides(
    entries: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, SettingsError> {
    let mut kept = BTreeMap::new();
    for (key, value) in entries {
        if !is_key(key) {
            return Err(SettingsError::new(
                SettingsCode::Validation,
                "Unknown settings key",
            ));
        }
        let value = crate::cursor::normalize_assignment(key, validate_value(key, value)?);
        kept.insert(key.clone(), value);
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    //! Ports `packages/settings/src/service.test.ts`'s layer cases and
    //! `global-only.test.ts`: the thread and workspace values win over global, a
    //! global-only key set below global is skipped and refused on write, and each
    //! refusal keeps the TypeScript's text.

    use super::*;
    use serde_json::json;

    #[test]
    fn thread_then_workspace_then_global_then_default() {
        let global: BTreeMap<String, Value> =
            [("threads.settleOnClose".to_owned(), json!(true))].into();
        let workspace: BTreeMap<String, Value> =
            [("threads.settleOnClose".to_owned(), json!(false))].into();
        let thread: BTreeMap<String, Value> =
            [("threads.followUpBehavior".to_owned(), json!("steer"))].into();
        let layers = [
            LayerValues {
                layer: Provenance::Global,
                settings: &global,
            },
            LayerValues {
                layer: Provenance::Workspace,
                settings: &workspace,
            },
            LayerValues {
                layer: Provenance::Thread,
                settings: &thread,
            },
        ];
        let resolve_one = |key: &str| resolve(key, &layers, &BTreeMap::new(), None);
        assert_eq!(
            resolve_one("threads.settleOnClose").provenance,
            Provenance::Workspace
        );
        assert_eq!(resolve_one("threads.settleOnClose").value, json!(false));
        assert_eq!(
            resolve_one("threads.followUpBehavior").provenance,
            Provenance::Thread
        );
        assert_eq!(
            resolve_one("threads.sortBy").provenance,
            Provenance::Defaults
        );
        assert_eq!(resolve_one("threads.sortBy").value, json!("activity"));
    }

    #[test]
    fn a_global_only_key_is_ignored_below_global_and_refused_on_write() {
        let workspace: BTreeMap<String, Value> =
            [("computer.lockedUse".to_owned(), json!(true))].into();
        let layers = [LayerValues {
            layer: Provenance::Workspace,
            settings: &workspace,
        }];
        let entry = resolve("computer.lockedUse", &layers, &BTreeMap::new(), None);
        assert_eq!(entry.provenance, Provenance::Defaults);
        assert_eq!(entry.value, json!(false));
        assert_eq!(
            placement(
                "beta.spade",
                &Layer::Workspace {
                    workspace: "/repo".into()
                }
            )
            .map_err(|error| error.message),
            Err("Beta features are a global setting".into())
        );
        assert_eq!(
            placement(
                "projects.roots",
                &Layer::Thread {
                    thread: "one".into()
                }
            )
            .map_err(|error| error.message),
            Err("Project folders are a global user setting".into())
        );
        assert_eq!(
            placement(
                "providers.coder.provider",
                &Layer::Workspace {
                    workspace: "/repo".into()
                }
            )
            .map_err(|error| error.message),
            Err("Roles are a global setting".into())
        );
        assert!(
            placement(
                "threads.sortBy",
                &Layer::Thread {
                    thread: "one".into()
                }
            )
            .is_ok()
        );
    }

    #[test]
    fn an_environment_override_wins_over_every_file() {
        let global: BTreeMap<String, Value> =
            [("threads.sortBy".to_owned(), json!("manual"))].into();
        let layers = [LayerValues {
            layer: Provenance::Global,
            settings: &global,
        }];
        let overrides: BTreeMap<String, Value> =
            [("threads.sortBy".to_owned(), json!("created"))].into();
        let entry = resolve("threads.sortBy", &layers, &overrides, None);
        assert_eq!(entry.provenance, Provenance::Environment);
        assert_eq!(entry.value, json!("created"));
    }

    #[test]
    fn a_batch_is_one_to_thirty_two_unique_placed_keys() {
        assert_eq!(
            check_batch(Vec::new(), &Layer::Global).map_err(|error| (error.code, error.message)),
            Err((
                SettingsCode::Limit,
                "Set between 1 and 32 settings at once".into()
            ))
        );
        assert_eq!(
            check_batch(["threads.sortBy", "threads.sortBy"], &Layer::Global)
                .map_err(|error| error.message),
            Err("Each setting can be set once per change".into())
        );
        assert!(check_batch(["threads.sortBy", "threads.settleOnClose"], &Layer::Global).is_ok());
    }
}
