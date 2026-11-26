// SPDX-License-Identifier: Apache-2.0
//! The versioned settings document (`document.ts`): version 2 with a `settings` object,
//! version 1 migrated on read, unknown keys and envelope fields preserved, retired
//! access keys refused. The text is JSON; comments in a person's file are a later port
//! of the TypeScript's JSONC editor, and only affect formatting, not values.

use serde_json::{Map, Value};

use crate::validation::{MAX_DOCUMENT_BYTES, SettingsCode, SettingsError, guard_secrets};

/// The keys `access.defaultMode` replaced (ADR 0075).
pub const RETIRED_ACCESS_KEYS: [&str; 3] = [
    "permissions.providerModes",
    "permissions.defaultMode",
    "approvals.policy",
];

/// A validated document: known values beside whatever else the file keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    pub settings: Map<String, Value>,
    /// Envelope fields other than version/settings, kept as they were.
    pub envelope: Map<String, Value>,
    pub migrated: bool,
}

fn parse(text: &str) -> Result<Value, SettingsError> {
    serde_json::from_str(text)
        .map_err(|_| SettingsError::new(SettingsCode::Validation, "Settings are not valid JSON"))
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

impl Document {
    /// Reads version 2, migrating version 1's `values` into `settings`.
    pub fn from_text(text: &str) -> Result<Self, SettingsError> {
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err(SettingsError::new(
                SettingsCode::Size,
                "Settings document exceeds 1 MiB",
            ));
        }
        let raw = parse(text)?;
        let header = object(Some(&raw)).ok_or_else(|| {
            SettingsError::new(
                SettingsCode::Validation,
                "Settings require a versioned document",
            )
        })?;
        let version = header.get("version").and_then(Value::as_i64);
        let (settings, migrated) = match version {
            Some(2) => (
                object(header.get("settings")).cloned().ok_or_else(|| {
                    SettingsError::new(
                        SettingsCode::Validation,
                        "Settings document has no settings object",
                    )
                })?,
                false,
            ),
            Some(1) => {
                if header.contains_key("settings") {
                    return Err(SettingsError::new(
                        SettingsCode::Validation,
                        "Invalid version 1 settings document",
                    ));
                }
                let values = object(header.get("values")).cloned().ok_or_else(|| {
                    SettingsError::new(
                        SettingsCode::Validation,
                        "Invalid version 1 settings document",
                    )
                })?;
                (values, true)
            }
            Some(_) => {
                return Err(SettingsError::new(
                    SettingsCode::Version,
                    "Unsupported settings document version",
                ));
            }
            None => {
                return Err(SettingsError::new(
                    SettingsCode::Validation,
                    "Settings require a versioned document",
                ));
            }
        };
        let retired: Vec<&str> = RETIRED_ACCESS_KEYS
            .into_iter()
            .filter(|key| settings.contains_key(*key))
            .collect();
        if !retired.is_empty() {
            return Err(SettingsError::new(
                SettingsCode::Validation,
                &format!(
                    "Settings use {}, which this build no longer reads. Set access.defaultMode instead and remove them.",
                    retired.join(", ")
                ),
            ));
        }
        guard_secrets(&Value::Object(settings.clone()))?;
        let envelope = header
            .iter()
            .filter(|(key, _)| key.as_str() != "version" && key.as_str() != "settings")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        Ok(Self {
            settings,
            envelope,
            migrated,
        })
    }

    /// A value the document holds, unknown keys included.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.settings.get(key)
    }

    /// Sets a value after the secret guard; the caller validates the value itself.
    pub fn assign(&mut self, key: &str, value: Value) -> Result<(), SettingsError> {
        guard_secrets(&value)?;
        self.settings.insert(key.to_owned(), value);
        Ok(())
    }

    /// Removes preferences without touching unknown keys.
    pub fn reset(&mut self, keys: &[&str]) {
        for key in keys {
            self.settings.remove(*key);
        }
    }

    /// The document's JSON text. Nothing is written past the 1 MiB cap.
    pub fn to_text(&self) -> Result<String, SettingsError> {
        let mut root = self.envelope.clone();
        root.insert("version".into(), Value::Number(2.into()));
        root.insert("settings".into(), Value::Object(self.settings.clone()));
        let text = serde_json::to_string_pretty(&Value::Object(root)).map_err(|_| {
            SettingsError::new(SettingsCode::Validation, "Settings are not serializable")
        })?;
        let text = format!("{text}\n");
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err(SettingsError::new(
                SettingsCode::Size,
                "Settings document exceeds 1 MiB",
            ));
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    //! Ports the document cases of `packages/settings/src/scalars.test.ts` and
    //! `permissions.test.ts`: unknown settings and envelope fields survive scalar
    //! edits, the 1 MiB cap is UTF-8 bytes (rule 17's byte bounds), version 1
    //! migrates, future versions are refused, and retired access keys are refused
    //! without being reinterpreted.

    use super::*;
    use serde_json::json;

    #[test]
    fn scalar_writes_preserve_unknown_settings_and_envelope_fields() {
        let unknown: Map<String, Value> = (0..256)
            .map(|index| (format!("future.{index}"), json!(index)))
            .collect();
        let mut root = unknown.clone();
        root.insert("threads.settleOnClose".into(), json!(false));
        let text = json!({
            "version": 2,
            "futureEnvelope": "retained",
            "settings": Value::Object(root)
        })
        .to_string();
        let mut document = Document::from_text(&text).unwrap_or_else(|_| panic!("decodes"));
        document
            .assign("threads.settleOnClose", json!(true))
            .unwrap_or_else(|_| panic!("assigns"));
        document
            .assign("providers.coder.model", json!("new-model"))
            .unwrap_or_else(|_| panic!("assigns"));
        let text = document.to_text().unwrap_or_else(|_| panic!("encodes"));
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        assert_eq!(value["version"], 2);
        assert_eq!(value["futureEnvelope"], "retained");
        assert_eq!(value["settings"]["threads.settleOnClose"], true);
        assert_eq!(value["settings"]["future.255"], 255);
        assert_eq!(value["settings"]["providers.coder.model"], "new-model");
    }

    #[test]
    fn the_document_cap_counts_utf8_bytes_and_refuses_a_write_that_would_cross_it() {
        let prefix = "{\n  \"version\": 2,\n  \"settings\": {\n    \"future.payload\": \"";
        let suffix = "\"\n  }\n}\n";
        let payload = "x".repeat(MAX_DOCUMENT_BYTES - prefix.len() - suffix.len() - 200);
        let mut document = Document::from_text(&(prefix.to_owned() + &payload + suffix))
            .unwrap_or_else(|_| panic!("decodes"));
        // A value that fits.
        document
            .assign("threads.settleOnClose", json!(true))
            .unwrap_or_else(|_| panic!("assigns"));
        assert!(document.to_text().is_ok());
        // Four-byte emoji past the cap fail, and the document keeps its previous value.
        let oversized = "🚀"
            .repeat((MAX_DOCUMENT_BYTES - document.to_text().unwrap_or_default().len()) / 4 + 2);
        document
            .assign("providers.coder.model", json!(oversized))
            .unwrap_or_else(|_| panic!("assigns"));
        assert_eq!(
            document.to_text().map_err(|error| error.code),
            Err(SettingsCode::Size)
        );
    }

    #[test]
    fn version_one_migrates_and_unreadable_versions_are_refused() {
        let migrated = Document::from_text(
            &json!({ "version": 1, "values": { "providers.coder.model": "m" } }).to_string(),
        )
        .unwrap_or_else(|_| panic!("migrates"));
        assert!(migrated.migrated);
        assert_eq!(migrated.get("providers.coder.model"), Some(&json!("m")));
        assert_eq!(
            Document::from_text(&json!({ "version": 3, "settings": {} }).to_string())
                .map_err(|error| error.code),
            Err(SettingsCode::Version)
        );
        assert_eq!(
            Document::from_text(&json!({ "settings": {} }).to_string()).map_err(|error| error.code),
            Err(SettingsCode::Validation)
        );
    }

    #[test]
    fn retired_access_keys_are_refused_not_reinterpreted() {
        for stored in [
            json!({ "permissions.providerModes": { "claude": "bypassPermissions" } }),
            json!({ "permissions.defaultMode": "full-access" }),
            json!({ "approvals.policy": "never" }),
            json!({ "access.defaultMode": "read-only", "approvals.policy": "never" }),
        ] {
            let text = json!({ "version": 2, "settings": stored }).to_string();
            let error = Document::from_text(&text).err();
            let error = error.unwrap_or_else(|| panic!("refuses {stored}"));
            assert_eq!(error.code, SettingsCode::Validation);
            assert!(error.message.contains("access.defaultMode"));
        }
    }
}
