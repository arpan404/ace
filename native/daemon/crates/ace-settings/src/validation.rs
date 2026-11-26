// SPDX-License-Identifier: Apache-2.0
//! Settings errors, size caps and the credential guards (`validation.ts`).

use std::sync::OnceLock;

use serde_json::Value;

pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_CLIENT_BYTES: usize = 64 * 1024;
const MAX_NESTING: usize = 64;

/// A settings failure, carrying the protocol's diagnostic code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsCode {
    Validation,
    Version,
    Size,
    Secret,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsError {
    pub code: SettingsCode,
    pub message: String,
}

impl SettingsError {
    pub fn new(code: SettingsCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SettingsError {}

fn credential_value() -> Option<&'static regex::Regex> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)(?:\bBearer\s+\S+|\b(?:sk-|ghp_|github_pat_|AKIA)[a-zA-Z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)",
            )
            .ok()
        })
        .as_ref()
}

fn secret_word() -> Option<&'static regex::Regex> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)(?:^|[._\-\s])(?:tokens?|keys?|passwords?|passwd|pwd|secrets?|credentials?|authorization)(?:$|[._\-\s])",
            )
            .ok()
        })
        .as_ref()
}

fn api_key_word() -> Option<&'static regex::Regex> {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(r"(?i)(?:api|access|refresh|private|secret)(?:key|token)").ok()
        })
        .as_ref()
}

/// Whether a property name looks like a credential (`guardProperty`).
pub fn secret_property(key: &str) -> bool {
    if matches!(key, "__proto__" | "constructor" | "prototype") {
        return true;
    }
    let words = regex::Regex::new(r"([a-z])([A-Z])")
        .ok()
        .map(|pattern| pattern.replace_all(key, "${1}_${2}").into_owned())
        .unwrap_or_else(|| key.to_owned());
    secret_word().is_some_and(|pattern| pattern.is_match(&words))
        || api_key_word().is_some_and(|pattern| pattern.is_match(key))
}

/// Refuses credential-looking values and property names anywhere in `value`.
pub fn guard_secrets(value: &Value) -> Result<(), SettingsError> {
    guard(value, 0)
}

fn guard(value: &Value, depth: usize) -> Result<(), SettingsError> {
    if depth > MAX_NESTING {
        return Err(SettingsError::new(
            SettingsCode::Size,
            "Settings nesting exceeds 64 levels",
        ));
    }
    match value {
        Value::String(text) => {
            if credential_value().is_some_and(|pattern| pattern.is_match(text)) {
                Err(SettingsError::new(
                    SettingsCode::Secret,
                    "Credentials cannot be stored in settings",
                ))
            } else {
                Ok(())
            }
        }
        Value::Array(items) => items.iter().try_for_each(|item| guard(item, depth + 1)),
        Value::Object(entries) => {
            for (key, item) in entries {
                if secret_property(key) {
                    return Err(SettingsError::new(
                        SettingsCode::Secret,
                        "Secret-looking fields cannot be stored in settings",
                    ));
                }
                guard(item, depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/settings/src/service.test.ts`'s "secret-looking fields and
    //! values are rejected without echoing their contents" and the 64-level nesting
    //! guard.

    use super::*;
    use serde_json::json;

    #[test]
    fn secret_looking_fields_and_values_are_rejected() {
        for value in [
            json!({ "apiKey": "x" }),
            json!({ "providers": { "password": "x" } }),
            json!(["sk-abcdefghijklmnop"]),
            json!({ "header": "Bearer abcdef" }),
            json!({ "key": "-----BEGIN RSA PRIVATE KEY-----" }),
            json!({ "__proto__": {} }),
        ] {
            assert_eq!(
                guard_secrets(&value).map_err(|error| error.code),
                Err(SettingsCode::Secret),
                "{value}"
            );
        }
        assert!(guard_secrets(&json!({ "providers.coder.model": "claude-opus-5-5" })).is_ok());
    }

    #[test]
    fn nesting_past_sixty_four_levels_is_a_size_error() {
        let mut value = json!(true);
        for _ in 0..66 {
            value = json!([value]);
        }
        assert_eq!(
            guard_secrets(&value).map_err(|error| error.code),
            Err(SettingsCode::Size)
        );
    }
}
