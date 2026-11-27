// SPDX-License-Identifier: Apache-2.0
//! `session-open-route.ts`, `session-fenced.ts`, `resume-open-error.ts` and `startup-skip.ts`: the
//! small decisions a provider session's open and a startup pass make. Moved cases:
//! `open-failure.process.test.ts`, whose unavailable-history and refused-CLI cases rest on these.

use ace_json::Value;

/// `SessionOpenRoute`: local diagnostics only; it excludes launch options, environment and
/// credentials.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionOpenRoute {
    pub model: Option<String>,
    pub instance: Option<String>,
    pub backend: Option<String>,
}

impl SessionOpenRoute {
    pub fn to_json(&self) -> Value {
        let mut value = ace_json::Map::new();
        if let Some(model) = &self.model {
            value.insert("model", Value::from(model.as_str()));
        }
        if let Some(instance) = &self.instance {
            value.insert("instance", Value::from(instance.as_str()));
        }
        if let Some(backend) = &self.backend {
            value.insert("backend", Value::from(backend.as_str()));
        }
        Value::Object(value)
    }
}

/// `SessionFenced`: the thread is moving or moved to another machine (ADR 0191), so no provider
/// opens for it; a send that meets this goes back to the queue, held, never failed.
pub const SESSION_FENCED: &str = "This thread is moving to another machine; nothing more runs here";

/// `unavailableNativeHistory`: only provider evidence about the native conversation justifies
/// unavailable-history guidance.
pub fn unavailable_native_history(code: &str, detail: &str) -> bool {
    matches!(
        code,
        "resume_unavailable"
            | "resume_unsupported"
            | "session_not_found"
            | "thread_not_found"
            | "conversation_not_found"
    ) || (code == "session_open_failed" && starts_with_conversation_not_found(detail))
}

/// `/^No conversation found\b/i`: the provider's own words, up to a word boundary.
fn starts_with_conversation_not_found(detail: &str) -> bool {
    const PREFIX: &str = "no conversation found";
    let Some(prefix) = detail.get(..PREFIX.len()) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case(PREFIX) {
        return false;
    }
    match detail[PREFIX.len()..].chars().next() {
        Some(next) => !(next.is_ascii_alphanumeric() || next == '_'),
        None => true,
    }
}

/// `skippableAtStartup`: whether startup may skip one thread whose stored state failed and
/// recover the rest. A busy store is retried by the caller, and data another ace build wrote is
/// refused for the whole database, so neither may skip every thread.
pub fn skippable_at_startup(is_store_retry: bool, incompatible_data: bool) -> bool {
    !is_store_retry && !incompatible_data
}
