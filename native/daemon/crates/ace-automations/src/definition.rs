// SPDX-License-Identifier: Apache-2.0
//! The automation definition and its one-time migrations, ported from
//! `packages/automations/src/definition.ts` and `@ace/provider-kit`'s `storedAccess`. Unknown
//! fields are kept in [`Extra`] and written back, so a field another build added survives a
//! save here.

use ace_json::{Map, Value};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{AutomationsError, Result};
use crate::recurrence::Schedule;

/// Fields this build doesn't know, kept in the object's order and spliced back verbatim.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Extra(pub Map);

impl<'de> Deserialize<'de> for Extra {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Extra, D::Error> {
        Ok(Extra(Map::deserialize(deserializer)?))
    }
}

impl Serialize for Extra {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in self.0.iter() {
            let text = ace_json::to_string(value);
            map.serialize_entry(key.as_str(), &ace_json::PreSpliced(&text))?;
        }
        map.end()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub id: String,
    pub title: String,
    pub enabled: bool,
    pub workspace: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    pub prompt: String,
    pub worktree: bool,
    pub trigger: Trigger,
    pub missed_run: String,
    pub concurrency: i64,
    pub jitter_ms: i64,
    /// Anything this build doesn't model, written back on the next save.
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    Manual,
    Schedule {
        schedule: Schedule,
    },
    Github {
        repository: String,
        event: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(
            rename = "pullRequest",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        pull_request: Option<i64>,
        #[serde(rename = "pollIntervalMs")]
        poll_interval_ms: i64,
    },
    File {
        paths: Vec<String>,
    },
    Webhook,
}

impl Trigger {
    pub fn kind(&self) -> &'static str {
        match self {
            Trigger::Manual => "manual",
            Trigger::Schedule { .. } => "schedule",
            Trigger::Github { .. } => "github",
            Trigger::File { .. } => "file",
            Trigger::Webhook => "webhook",
        }
    }

    pub fn schedule(&self) -> Option<&ScheduleTrigger> {
        match self {
            Trigger::Schedule { schedule } => Some(schedule),
            _ => None,
        }
    }
}

/// A schedule trigger, so callers need not reach into the enum.
pub type ScheduleTrigger = Schedule;

impl Definition {
    pub fn missed_run_skips(&self) -> bool {
        self.missed_run == "skip"
    }

    pub fn schedule(&self) -> Option<&Schedule> {
        match &self.trigger {
            Trigger::Schedule { schedule } => Some(schedule),
            _ => None,
        }
    }

    /// Parse a stored definition, applying `normalizeAutomation`'s migration.
    pub fn from_value(value: &Value) -> Result<Definition> {
        Definition::normalize(value)
    }

    /// `normalizeAutomation` (`definition.ts:13`): a native `permissionMode` stored before ace's
    /// four access modes maps once onto `access` and is removed; the next save writes only
    /// `access`. Every other field, known or not, is kept.
    pub fn normalize(input: &Value) -> Result<Definition> {
        let mut value = input.clone();
        if let Value::Object(map) = &mut value {
            let permission = map
                .get("permissionMode")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if permission.is_some() {
                map.shift_remove("permissionMode");
            }
            match map.get("access") {
                Some(Value::Null) => {
                    if permission.is_none() {
                        // An explicit null is not an absent access; `Automation.parse` rejects it.
                        return Err(AutomationsError::message("Invalid automation"));
                    }
                    map.shift_remove("access");
                    if let Some(permission) = &permission {
                        let provider = map
                            .get("provider")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        if let Some(access) = stored_access(&provider, permission) {
                            map.insert("access", Value::String(access.into()));
                        }
                    }
                }
                None => {
                    if let Some(permission) = &permission {
                        let provider = map
                            .get("provider")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        if let Some(access) = stored_access(&provider, permission) {
                            map.insert("access", Value::String(access.into()));
                        }
                    }
                }
                // A string is left for validation; any other explicit value fails parse.
                Some(_) => {}
            }
        }
        let definition: Definition = ace_json::from_value(&value)
            .map_err(|error| AutomationsError::message(error.to_string()))?;
        definition.validate()?;
        Ok(definition)
    }

    /// The protocol's trigger and numeric bounds, so a row another build wrote cannot reach a
    /// decision with an event this build doesn't poll.
    fn validate(&self) -> Result<()> {
        if !matches!(self.missed_run.as_str(), "skip" | "run_once")
            || !(1..=32).contains(&self.concurrency)
            || !(0..=3_600_000).contains(&self.jitter_ms)
            || self
                .access
                .as_deref()
                .is_some_and(|access| !ACCESS_MODES.contains(&access))
        {
            return Err(AutomationsError::message("Invalid automation"));
        }
        if let Trigger::Github {
            repository,
            event,
            poll_interval_ms,
            ..
        } = &self.trigger
        {
            let part = |value: &str| {
                !value.is_empty()
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
                    })
            };
            let Some((owner, name)) = repository.split_once('/') else {
                return Err(AutomationsError::message("Invalid automation"));
            };
            if !part(owner) || !part(name) || name.contains('/') || repository.len() > 256 {
                return Err(AutomationsError::message("Invalid automation"));
            }
            if !matches!(
                event.as_str(),
                "pr_changed" | "ci_failed" | "review_comment" | "issue_labelled"
            ) || !(60_000..=86_400_000).contains(poll_interval_ms)
            {
                return Err(AutomationsError::message("Invalid automation"));
            }
        }
        Ok(())
    }

    /// This definition after the migration, for a save or for decisions on a hand-built value.
    pub fn normalized(&self) -> Result<Definition> {
        let text = ace_json::ser::to_string(self)
            .map_err(|error| AutomationsError::message(error.to_string()))?;
        Definition::normalize(
            &ace_json::parse(&text)
                .map_err(|error| AutomationsError::message(error.to_string()))?,
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerError {
    pub message: String,
    pub at: i64,
}

const ACCESS_MODES: [&str; 4] = ["read-only", "ask", "auto-review", "full-access"];

/// `storedAccess` (`provider-kit/src/access-modes.ts:233`): one native selector's ace mode.
/// `None` means the value has no ace equivalent and the defaults apply.
pub fn stored_access(provider: &str, stored: &str) -> Option<String> {
    if ACCESS_MODES.contains(&stored) {
        return Some(stored.to_owned());
    }
    let mapped = match provider {
        "claude" => match stored {
            "plan" => "read-only",
            "default" | "dontAsk" => "ask",
            "acceptEdits" | "auto" => "auto-review",
            "bypassPermissions" => "full-access",
            _ => return None,
        },
        "codex" => {
            let permissions = if stored.starts_with('{') {
                let parsed: CodexStored =
                    ace_json::from_value(&ace_json::parse(stored).ok()?).ok()?;
                parsed.permissions
            } else {
                stored.to_owned()
            };
            match permissions.as_str() {
                ":read-only" => "read-only",
                ":workspace" => "auto-review",
                ":danger-full-access" => "full-access",
                // A custom permission profile can't be ranked; it runs no broader than Ask.
                _ => "ask",
            }
        }
        "opencode" => match stored {
            "plan" => "read-only",
            "build" => "auto-review",
            _ => return None,
        },
        "cursor" => {
            let parsed: CursorStored = ace_json::from_value(&ace_json::parse(stored).ok()?).ok()?;
            if !parsed.sandbox_options.enabled && !parsed.auto_review {
                "full-access"
            } else {
                "auto-review"
            }
        }
        "pi" => return None,
        "acp" | "antigravity" => match stored {
            "plan" | "read-only" => "read-only",
            "default" => "ask",
            "auto_edit" | "auto-edit" | "acceptEdits" | "auto" | "agent" | "workspace-write" => {
                "auto-review"
            }
            "yolo" | "bypassPermissions" | "agent-full-access" => "full-access",
            _ => return None,
        },
        _ => return None,
    };
    Some(mapped.to_owned())
}

#[derive(Deserialize)]
struct CodexStored {
    permissions: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorStored {
    sandbox_options: CursorSandbox,
    auto_review: bool,
}

#[derive(Deserialize)]
struct CursorSandbox {
    enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition_json(access: Option<&str>, extra: &str) -> String {
        format!(
            r#"{{"id":"a","title":"A","enabled":true,"workspace":"/w","provider":"claude",{}"prompt":"Go","worktree":false,"trigger":{{"kind":"manual"}},"missedRun":"skip","concurrency":1,"jitterMs":0{extra}}}"#,
            access.map_or(String::new(), |access| format!("\"access\":\"{access}\","))
        )
    }

    #[test]
    fn every_permission_mode_maps_once_and_the_next_save_has_only_access() {
        let cases: &[(&str, &str, Option<&str>)] = &[
            ("claude", "plan", Some("read-only")),
            ("claude", "default", Some("ask")),
            ("claude", "dontAsk", Some("ask")),
            ("claude", "acceptEdits", Some("auto-review")),
            ("claude", "auto", Some("auto-review")),
            ("claude", "bypassPermissions", Some("full-access")),
            ("codex", ":read-only", Some("read-only")),
            ("codex", ":workspace", Some("auto-review")),
            ("codex", ":danger-full-access", Some("full-access")),
            ("codex", "custom-profile", Some("ask")),
            (
                "codex",
                r#"{"permissions":":workspace"}"#,
                Some("auto-review"),
            ),
            ("codex", "{not json", None),
            ("opencode", "plan", Some("read-only")),
            ("opencode", "build", Some("auto-review")),
            (
                "cursor",
                r#"{"sandboxOptions":{"enabled":false},"autoReview":false}"#,
                Some("full-access"),
            ),
            (
                "cursor",
                r#"{"sandboxOptions":{"enabled":true},"autoReview":false}"#,
                Some("auto-review"),
            ),
            ("cursor", "not json", None),
            ("pi", "plan", None),
            ("acp", "plan", Some("read-only")),
            ("acp", "default", Some("ask")),
            ("acp", "auto_edit", Some("auto-review")),
            ("acp", "yolo", Some("full-access")),
            ("antigravity", "agent-full-access", Some("full-access")),
            ("claude", "read-only", Some("read-only")),
            ("claude", "auto-review", Some("auto-review")),
            ("claude", "unknown-native", None),
        ];
        for (provider, permission, expected) in cases {
            let text = definition_json(None, "").replace(
                "\"provider\":\"claude\"",
                &format!("\"provider\":\"{provider}\""),
            );
            let value: Value = ace_json::parse(&text).expect("json");
            let Value::Object(mut map) = value else {
                panic!("object")
            };
            map.insert("permissionMode", Value::String((*permission).into()));
            let definition = Definition::normalize(&Value::Object(map)).expect("normalizes");
            assert_eq!(
                definition.access.as_deref(),
                *expected,
                "{provider} {permission}"
            );
            let saved =
                ace_json::ser::to_string(&definition.normalized().expect("save")).expect("json");
            assert!(!saved.contains("permissionMode"), "{saved}");
            if let Some(expected) = expected {
                assert!(
                    saved.contains(&format!("\"access\":\"{expected}\"")),
                    "{saved}"
                );
            }
        }
    }

    #[test]
    fn an_invalid_explicit_access_is_rejected_like_automation_parse() {
        let cases = [
            r#""access":123,"permissionMode":"bypassPermissions","#,
            r#""access":null,"#,
            r#""access":"plan","#,
            r#""access":true,"#,
        ];
        for fields in cases {
            let text =
                definition_json(None, "").replace("\"prompt\"", &format!("{fields}\"prompt\""));
            assert!(
                Definition::normalize(&ace_json::parse(&text).expect("json")).is_err(),
                "{fields}"
            );
        }
        // A null access with a legacy selector is absent, so the selector maps it.
        let text = definition_json(None, "").replace(
            "\"prompt\"",
            "\"access\":null,\"permissionMode\":\"plan\",\"prompt\"",
        );
        let definition =
            Definition::normalize(&ace_json::parse(&text).expect("json")).expect("valid");
        assert_eq!(definition.access.as_deref(), Some("read-only"));
    }

    #[test]
    fn an_existing_access_wins_over_the_legacy_selector() {
        let text = definition_json(Some("ask"), "")
            .replace("\"prompt\"", "\"permissionMode\":\"plan\",\"prompt\"");
        let definition =
            Definition::normalize(&ace_json::parse(&text).expect("json")).expect("normalizes");
        assert_eq!(definition.access.as_deref(), Some("ask"));
    }

    #[test]
    fn unknown_fields_are_kept_in_order_and_written_back() {
        let text = definition_json(None, r#","future":{"a":[1,true,null]}"#);
        let definition =
            Definition::normalize(&ace_json::parse(&text).expect("json")).expect("normalizes");
        let saved = ace_json::ser::to_string(&definition).expect("json");
        assert!(
            saved.ends_with(r#","future":{"a":[1,true,null]}}"#),
            "{saved}"
        );
    }
}
