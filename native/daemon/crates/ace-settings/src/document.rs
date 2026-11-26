// SPDX-License-Identifier: Apache-2.0
//! The versioned settings document (`document.ts`): JSONC with comments, version 2 with
//! a `settings` object, version 1 migrated on read, the TypeScript's v2 migrations, known
//! values checked against their key, retired keys dropped or refused, unknown keys and
//! envelope fields preserved, and scalar edits that leave the rest of the file alone.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::jsonc::{
    ObjectLayout, ScalarRange, Scanned, Segment, SettingsLayout, insert_setting, parse_document,
    remove_setting, replace_scalar,
};
use crate::schema::{default_value, is_key, validate_value};
use crate::validation::{MAX_DOCUMENT_BYTES, SettingsCode, SettingsError, guard_secrets};

/// The keys `access.defaultMode` replaced (ADR 0075).
pub const RETIRED_ACCESS_KEYS: [&str; 3] = [
    "permissions.providerModes",
    "permissions.defaultMode",
    "approvals.policy",
];

/// Settings this build retired (ADR 0208) and drops on read.
pub const RETIRED_MEDIA_KEYS: [&str; 4] = [
    "media.encode",
    "media.delivery",
    "media.recordings",
    "media.stills",
];

/// The Cursor SDK instance id older selections called the CLI default.
pub const CURSOR_DEFAULT_INSTANCE_ID: &str = "cursor-sdk-default";

/// A validated document.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedDocument {
    pub settings: Map<String, Value>,
    pub text: String,
    pub bytes: usize,
    pub migrated: bool,
    pub ranges: BTreeMap<String, ScalarRange>,
    pub layouts: BTreeMap<Vec<Segment>, ObjectLayout>,
    pub layout: Option<SettingsLayout>,
}

/// The text a fresh settings file starts with.
pub fn empty_text() -> &'static str {
    "{\n  \"version\": 2,\n  \"settings\": {}\n}\n"
}

fn error(code: SettingsCode, message: &str) -> SettingsError {
    SettingsError::new(code, message)
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

fn version_of(value: &Value) -> Option<i64> {
    let number = value.get("version")?.as_f64()?;
    (number.fract() == 0.0 && number.is_finite()).then_some(number as i64)
}

/// `validateAssignment`: the key's schema, after the credential guard.
pub fn validate_assignment(key: &str, value: &Value) -> Result<Value, SettingsError> {
    let mut probe = Map::new();
    probe.insert(key.to_owned(), value.clone());
    guard_secrets(&Value::Object(probe))?;
    if !is_key(key) {
        return Err(error(SettingsCode::Validation, "Unknown settings key"));
    }
    validate_value(key, value)
}

fn check_known_values(settings: &Map<String, Value>) -> Result<(), SettingsError> {
    for (key, value) in settings {
        if is_key(key) {
            validate_value(key, value).map_err(|_| {
                error(
                    SettingsCode::Validation,
                    "Settings document has invalid known values",
                )
            })?;
        }
    }
    Ok(())
}

fn retired_workflow_keys(settings: &Map<String, Value>) -> Vec<String> {
    settings
        .keys()
        .filter(|key| *key == "offshift" || key.starts_with("offshift."))
        .cloned()
        .collect()
}

fn transport_networks(transport: &str, relay_url: &str) -> (bool, bool, bool) {
    (
        transport != "tailscale",
        transport == "tailscale",
        transport == "relay" || !relay_url.is_empty(),
    )
}

/// The networks a document gains, or none (`remote-networks-migration.ts`).
fn remote_networks(settings: &Map<String, Value>) -> Option<((bool, bool, bool), bool)> {
    let relay_url = settings
        .get("remote.relayUrl")
        .and_then(Value::as_str)
        .unwrap_or("");
    if let Some(transport) = settings.get("remote.transport").and_then(Value::as_str) {
        return Some((transport_networks(transport, relay_url), true));
    }
    let chosen = settings.contains_key("remote.lan")
        || settings.contains_key("remote.tailscale")
        || settings.contains_key("remote.relay");
    if chosen || relay_url.is_empty() {
        return None;
    }
    Some((transport_networks("lan", relay_url), false))
}

/// SDK-specific Cursor preferences win a collision with a retired CLI default.
fn cursor_configuration(rows: &Value) -> Value {
    let Some(rows) = rows.as_array() else {
        return rows.clone();
    };
    let mut next: Vec<Value> = Vec::new();
    for value in rows {
        let Some(row) = value.as_object() else {
            next.push(value.clone());
            continue;
        };
        let provider = row.get("provider").and_then(Value::as_str);
        let instance = row.get("instance").and_then(Value::as_str);
        let collapsed = provider == Some("cursor") && instance == Some("cursor-cli-default");
        let target = if provider == Some("cursor") {
            match instance {
                Some("cursor-cli-default") => Some(CURSOR_DEFAULT_INSTANCE_ID.to_owned()),
                other => other.map(str::to_owned),
            }
        } else {
            instance.map(str::to_owned)
        };
        if collapsed
            && target.as_ref().is_some_and(|target| {
                rows.iter().any(|other| {
                    let other = other.as_object();
                    other
                        .and_then(|other| other.get("provider"))
                        .and_then(Value::as_str)
                        == Some("cursor")
                        && other
                            .and_then(|other| other.get("instance"))
                            .and_then(Value::as_str)
                            == Some(target.as_str())
                })
            })
        {
            continue;
        }
        let mut kept = Map::new();
        for (name, field) in row {
            if name == "binaryPath" {
                continue;
            }
            kept.insert(name.clone(), field.clone());
        }
        if provider == Some("cursor") {
            match target {
                Some(target) => {
                    kept.insert("instance".to_owned(), Value::String(target));
                }
                None => {
                    kept.remove("instance");
                }
            }
        }
        next.push(Value::Object(kept));
    }
    Value::Array(next)
}

impl DecodedDocument {
    /// Reads a document, migrating version 1 and this build's v2 upgrades.
    pub fn decode(text: &str) -> Result<Self, SettingsError> {
        let mut text = text.to_owned();
        let mut migrated = false;
        for _ in 0..16 {
            let scanned = parse_document(&text)?;
            if scanned.bytes > MAX_DOCUMENT_BYTES {
                return Err(error(SettingsCode::Size, "Settings document exceeds 1 MiB"));
            }
            let Some(header) = object(Some(&scanned.value)) else {
                return Err(error(
                    SettingsCode::Validation,
                    "Settings require a versioned document",
                ));
            };
            let version = version_of(&scanned.value).ok_or_else(|| {
                error(
                    SettingsCode::Validation,
                    "Settings require a versioned document",
                )
            })?;
            if version == 1 {
                if header.contains_key("settings") {
                    return Err(error(
                        SettingsCode::Validation,
                        "Invalid version 1 settings document",
                    ));
                }
                let values = object(header.get("values")).ok_or_else(|| {
                    error(
                        SettingsCode::Validation,
                        "Invalid version 1 settings document",
                    )
                })?;
                text = rewrite_version_one(&text, values)?;
                migrated = true;
                continue;
            }
            if version != 2 {
                return Err(error(
                    SettingsCode::Version,
                    "Unsupported settings document version",
                ));
            }
            let Some(settings) = object(header.get("settings")) else {
                return Err(error(
                    SettingsCode::Validation,
                    "Settings document has no settings object",
                ));
            };
            check_known_values(settings)?;
            let retired: Vec<String> = retired_workflow_keys(settings)
                .into_iter()
                .chain(
                    RETIRED_MEDIA_KEYS
                        .into_iter()
                        .filter(|key| settings.contains_key(*key))
                        .map(str::to_owned),
                )
                .collect();
            if !retired.is_empty() {
                text = remove_keys(&scanned, &retired)?.text;
                migrated = true;
                continue;
            }
            if let Some(((lan, tailscale, relay), drop_transport)) = remote_networks(settings) {
                let mut next = scanned.clone();
                for (key, value) in [
                    ("remote.lan", Value::Bool(lan)),
                    ("remote.tailscale", Value::Bool(tailscale)),
                    ("remote.relay", Value::Bool(relay)),
                ] {
                    next = set_setting(&next, key, &value)?;
                }
                if drop_transport {
                    next = remove_keys(&next, &["remote.transport".to_owned()])?;
                }
                text = next.text;
                migrated = true;
                continue;
            }
            for key in ["clients.theme", "clients.keybindings"] {
                if let Some(value) = settings.get(key) {
                    validate_value(key, value)?;
                }
            }
            let refused: Vec<&str> = RETIRED_ACCESS_KEYS
                .into_iter()
                .filter(|key| settings.contains_key(*key))
                .collect();
            if !refused.is_empty() {
                return Err(error(
                    SettingsCode::Validation,
                    &format!(
                        "Settings use {}, which this build no longer reads. Set access.defaultMode instead and remove them.",
                        refused.join(", ")
                    ),
                ));
            }
            if let Some(configuration) = settings.get("providers.configuration") {
                let next = cursor_configuration(configuration);
                if &next != configuration {
                    let next_document = set_setting(&scanned, "providers.configuration", &next)?;
                    text = next_document.text;
                    migrated = true;
                    continue;
                }
            }
            let envelope: Map<String, Value> = header
                .iter()
                .filter(|(key, _)| key.as_str() != "version" && key.as_str() != "settings")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            let mut kept = Map::new();
            for (key, value) in settings {
                if is_key(key) {
                    kept.insert(key.clone(), validate_value(key, value)?);
                } else {
                    kept.insert(key.clone(), value.clone());
                }
            }
            let _ = envelope;
            return Ok(Self {
                settings: kept,
                text: scanned.text.clone(),
                bytes: scanned.bytes,
                migrated,
                ranges: scanned.ranges.clone(),
                layouts: scanned.layouts.clone(),
                layout: scanned.layout.clone(),
            });
        }
        Err(error(
            SettingsCode::Validation,
            "Settings document has invalid known values",
        ))
    }

    /// A value the document holds, unknown keys included.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.settings.get(key)
    }

    /// A value that is set, else the key's shipped default, else null.
    pub fn resolved(&self, key: &str) -> Value {
        self.settings
            .get(key)
            .cloned()
            .or_else(|| default_value(key))
            .unwrap_or(Value::Null)
    }

    /// Sets a value, with the TypeScript's scalar fast path and migration-aware fallback.
    pub fn assign(&self, key: &str, value: &Value) -> Result<Self, SettingsError> {
        let parsed = validate_assignment(key, value)?;
        if migrates_on_write(key)
            || parsed.is_array()
            || parsed.is_object()
            || (parsed.is_null() && !self.ranges.contains_key(key))
        {
            let scanned = Scanned {
                value: Value::Object(Map::new()),
                bytes: self.bytes,
                ranges: self.ranges.clone(),
                layouts: self.layouts.clone(),
                layout: self.layout.clone(),
                text: self.text.clone(),
            };
            let next = set_setting(&scanned, key, &parsed)?;
            return Self::decode(&next.text);
        }
        let Some(range) = self.ranges.get(key).copied() else {
            let scanned = Scanned {
                value: Value::Object(Map::new()),
                bytes: self.bytes,
                ranges: self.ranges.clone(),
                layouts: self.layouts.clone(),
                layout: self.layout.clone(),
                text: self.text.clone(),
            };
            let next = set_setting(&scanned, key, &parsed)?;
            return Self::decode(&next.text);
        };
        let content = serde_json::to_string(&parsed)
            .map_err(|_| error(SettingsCode::Validation, "Settings are not serializable"))?;
        let bytes = self.bytes - (range.end - range.start) + content.len();
        if bytes > MAX_DOCUMENT_BYTES {
            return Err(error(SettingsCode::Size, "Settings document exceeds 1 MiB"));
        }
        let text = replace_scalar(&self.text, range, &content);
        let mut next = self.clone();
        next.text = text;
        next.bytes = bytes;
        next.settings.insert(key.to_owned(), parsed);
        let shift = content.len() as isize - (range.end - range.start) as isize;
        for (other, position) in next.ranges.iter_mut() {
            if other.as_str() == key {
                position.end = position.start + content.len();
            } else if position.start > range.start {
                position.start = (position.start as isize + shift).max(0) as usize;
                position.end = (position.end as isize + shift).max(0) as usize;
            }
        }
        if let Some(layout) = next.layout.as_mut()
            && let Some(span) = layout.properties.get_mut(key)
        {
            let key_start = span.key_start;
            span.value_end = span.value_end.saturating_add_signed(shift);
            for (_, other) in layout.properties.iter_mut() {
                if other.key_start > key_start {
                    other.key_start = other.key_start.saturating_add_signed(shift);
                    other.value_end = other.value_end.saturating_add_signed(shift);
                    if let Some(comma) = other.comma_before.as_mut() {
                        *comma = comma.saturating_add_signed(shift);
                    }
                    if let Some(comma) = other.comma_after.as_mut() {
                        *comma = comma.saturating_add_signed(shift);
                    }
                }
            }
            if let Some(last) = layout.last_value_end.as_mut() {
                *last = last.saturating_add_signed(shift);
            }
            layout.close = layout.close.saturating_add_signed(shift);
        }
        Ok(next)
    }

    /// Removes known preferences, keeping unknown keys and comments.
    pub fn reset(&self, keys: &[&str]) -> Result<Self, SettingsError> {
        let scanned = Scanned {
            value: Value::Object(Map::new()),
            bytes: self.bytes,
            ranges: self.ranges.clone(),
            layouts: self.layouts.clone(),
            layout: self.layout.clone(),
            text: self.text.clone(),
        };
        let mut next = scanned;
        for key in keys {
            next = remove_keys(&next, &[(*key).to_owned()])?;
        }
        Self::decode(&next.text)
    }

    /// The document's text, or the size refusal.
    pub fn to_text(&self) -> Result<String, SettingsError> {
        if self.bytes > MAX_DOCUMENT_BYTES {
            return Err(error(SettingsCode::Size, "Settings document exceeds 1 MiB"));
        }
        Ok(self.text.clone())
    }
}

/// Keys whose writes may change other network settings (`migratesOnWrite`).
pub fn migrates_on_write(key: &str) -> bool {
    key == "remote.transport" || key == "remote.relayUrl"
}

fn rewrite_version_one(text: &str, values: &Map<String, Value>) -> Result<String, SettingsError> {
    // Path edits, as `document.ts`'s `edit` calls: `values` becomes `settings` in place, the
    // old key and the version are edited at their own paths. Envelope fields and the
    // document's comments stay, and a decoded key is written back escaped.
    let settings = Value::Object(values.clone());
    let text = crate::edit::modify(text, &["settings"], Some(&settings))?;
    let text = crate::edit::modify(&text, &["values"], None)?;
    crate::edit::modify(&text, &["version"], Some(&Value::Number(2.into())))
}

fn set_setting(scanned: &Scanned, key: &str, value: &Value) -> Result<Scanned, SettingsError> {
    let Some(layout) = scanned.layout.clone() else {
        return Err(error(
            SettingsCode::Validation,
            "Settings document has no settings object",
        ));
    };
    let text = if let Some(span) = layout.properties.get(key) {
        let content = serde_json::to_string(value)
            .map_err(|_| error(SettingsCode::Validation, "Settings are not serializable"))?;
        replace_scalar(
            &scanned.text,
            ScalarRange {
                start: span.key_start,
                end: span.value_end,
            },
            &format!("\"{key}\": {content}"),
        )
    } else {
        insert_setting(&scanned.text, &layout, key, value)?
    };
    parse_document(&text)
}

fn remove_keys(scanned: &Scanned, keys: &[String]) -> Result<Scanned, SettingsError> {
    let mut text = scanned.text.clone();
    for key in keys {
        // Re-read so every later removal uses the spans of the text it removes from.
        let current = parse_document(&text)?;
        let Some(layout) = current.layout.as_ref() else {
            break;
        };
        if let Some(span) = layout.properties.get(key) {
            text = remove_setting(&text, span);
        }
    }
    parse_document(&text)
}

#[cfg(test)]
mod tests {
    //! Ports the document cases of `scalars.test.ts`, `permissions.test.ts`,
    //! `retired-media-keys.test.ts`, `remote-networks.test.ts`,
    //! `cursor-migration.process.test.ts` and the review's failing inputs: a commented
    //! file loads, `version: 2.0` is accepted, retired media and Offshift keys are
    //! dropped, `remote.transport` becomes the three networks, a Cursor CLI default
    //! becomes the SDK default, unknown keys survive, and retired access keys are
    //! refused.

    use super::*;
    use serde_json::json;

    #[test]
    fn a_commented_document_loads_and_keeps_its_comments() {
        let text = "{\n  // ops note\n  \"version\": 2,\n  \"settings\": {\n    \"threads.settleOnClose\": true // keep\n  }\n}\n";
        let document = DecodedDocument::decode(text).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            document.get("threads.settleOnClose"),
            Some(&Value::Bool(true))
        );
        let next = document
            .assign("threads.settleOnClose", &Value::Bool(false))
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(next.to_text().unwrap_or_default().contains("// ops note"));
        assert!(next.to_text().unwrap_or_default().contains("// keep"));
        assert_eq!(next.get("threads.settleOnClose"), Some(&Value::Bool(false)));
    }

    #[test]
    fn version_two_as_a_float_is_accepted_and_other_versions_are_not() {
        let text = json!({ "version": 2.0, "settings": {} }).to_string();
        assert!(DecodedDocument::decode(&text).is_ok());
        assert_eq!(
            DecodedDocument::decode(&json!({ "version": 3, "settings": {} }).to_string())
                .map_err(|error| error.code),
            Err(SettingsCode::Version)
        );
    }

    #[test]
    fn a_known_value_the_schema_refuses_refuses_the_document() {
        let text = json!({
            "version": 2,
            "settings": { "threads.followUpBehavior": "soon" }
        })
        .to_string();
        assert_eq!(
            DecodedDocument::decode(&text).map_err(|error| (error.code, error.message)),
            Err((
                SettingsCode::Validation,
                "Settings document has invalid known values".into()
            ))
        );
    }

    #[test]
    fn retired_media_workflow_and_transport_values_are_migrated_on_read() {
        let text = json!({
            "version": 2,
            "settings": {
                "media.encode": "h264",
                "offshift.keep": true,
                "remote.transport": "tailscale"
            }
        })
        .to_string();
        let document = DecodedDocument::decode(&text).unwrap_or_else(|error| panic!("{error}"));
        assert!(document.migrated);
        assert!(document.get("media.encode").is_none());
        assert!(document.get("offshift.keep").is_none());
        assert!(document.get("remote.transport").is_none());
        assert_eq!(document.get("remote.lan"), Some(&Value::Bool(false)));
        assert_eq!(document.get("remote.tailscale"), Some(&Value::Bool(true)));
        assert_eq!(document.get("remote.relay"), Some(&Value::Bool(false)));
    }

    #[test]
    fn a_cursor_cli_default_becomes_the_sdk_default_without_binary_paths() {
        let text = json!({
            "version": 2,
            "settings": {
                "providers.configuration": [{
                    "provider": "cursor",
                    "instance": "cursor-cli-default",
                    "binaryPath": "/opt/cursor"
                }]
            }
        })
        .to_string();
        let document = DecodedDocument::decode(&text).unwrap_or_else(|error| panic!("{error}"));
        let rows = document
            .get("providers.configuration")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(rows[0]["instance"], CURSOR_DEFAULT_INSTANCE_ID);
        assert!(rows[0].get("binaryPath").is_none());
        assert!(document.migrated);
    }

    #[test]
    fn unknown_keys_and_envelope_fields_survive_edits() {
        let text = json!({
            "version": 2,
            "futureEnvelope": "retained",
            "settings": { "future.note": 1, "threads.settleOnClose": false }
        })
        .to_string();
        let document = DecodedDocument::decode(&text).unwrap_or_else(|error| panic!("{error}"));
        let next = document
            .assign("providers.coder.model", &json!("new-model"))
            .unwrap_or_else(|error| panic!("{error}"));
        let text = next.to_text().unwrap_or_default();
        assert!(text.contains("\"futureEnvelope\":\"retained\""));
        let decoded = DecodedDocument::decode(&text).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(decoded.get("future.note"), Some(&json!(1)));
        assert_eq!(
            decoded.get("providers.coder.model"),
            Some(&json!("new-model"))
        );
    }

    #[test]
    fn a_scalar_write_replaces_the_whole_value_even_when_it_is_an_array() {
        let text = "{\"version\":2,\"settings\":{\"clients.theme\":[1]}}";
        let document = DecodedDocument::decode(text).unwrap_or_else(|error| panic!("{error}"));
        assert!(
            !document.ranges.contains_key("clients.theme"),
            "an array element is not the setting's value"
        );
        let next = document
            .assign("clients.theme", &Value::Bool(false))
            .unwrap_or_else(|error| panic!("{error}"));
        let text = next.to_text().unwrap_or_default();
        assert!(!text.contains("[false]"), "{text}");
        assert_eq!(next.get("clients.theme"), Some(&Value::Bool(false)));
        let fresh = DecodedDocument::decode(&text).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(fresh.get("clients.theme"), Some(&Value::Bool(false)));
    }

    #[test]
    fn a_version_one_document_is_migrated_by_path_edits() {
        // A decoded envelope key with a quote is written back escaped, not interpolated.
        let text = "{\"version\":1,\"values\":{},\"note\\\"name\":1}";
        let document = DecodedDocument::decode(text).unwrap_or_else(|error| panic!("{error}"));
        assert!(document.migrated);
        let migrated = document.to_text().unwrap_or_default();
        assert!(migrated.contains(r#""note\"name":1"#), "{migrated}");
        assert_eq!(DecodedDocument::decode(&migrated).map(|_| ()), Ok(()));

        // A key inside `values` with a quote survives too.
        let text = "{\"version\":1,\"values\":{\"a\\\"b\":1}}";
        let document = DecodedDocument::decode(text).unwrap_or_else(|error| panic!("{error}"));
        let migrated = document.to_text().unwrap_or_default();
        assert_eq!(DecodedDocument::decode(&migrated).map(|_| ()), Ok(()));
        assert_eq!(document.get("a\"b"), Some(&json!(1)));

        // A top-level comment stays where it was.
        let text = "{\n  // keep\n  \"version\": 1,\n  \"values\": {\n    \"threads.settleOnClose\": true\n  }\n}\n";
        let document = DecodedDocument::decode(text).unwrap_or_else(|error| panic!("{error}"));
        let migrated = document.to_text().unwrap_or_default();
        assert!(migrated.contains("// keep"), "{migrated}");
        assert!(migrated.contains("\"version\": 2"), "{migrated}");
        assert!(!migrated.contains("\"values\""), "{migrated}");
        assert_eq!(
            document.get("threads.settleOnClose"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn retired_access_keys_are_refused_not_reinterpreted() {
        for stored in [
            json!({ "permissions.providerModes": { "claude": "bypassPermissions" } }),
            json!({ "permissions.defaultMode": "full-access" }),
            json!({ "approvals.policy": "never" }),
        ] {
            let text = json!({ "version": 2, "settings": stored }).to_string();
            let error = DecodedDocument::decode(&text)
                .err()
                .unwrap_or_else(|| panic!("refuses"));
            assert_eq!(error.code, SettingsCode::Validation);
            assert!(error.message.contains("access.defaultMode"));
        }
    }

    #[test]
    fn an_unknown_assignment_key_is_refused() {
        assert_eq!(
            validate_assignment("threads.settleSoon", &json!(true)).map_err(|error| error.message),
            Err("Unknown settings key".into())
        );
    }
}
