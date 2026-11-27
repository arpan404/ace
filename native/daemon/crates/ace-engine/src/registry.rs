// SPDX-License-Identifier: Apache-2.0
//! The native engine's view of the adapter registry (E5.1 step 7). The TypeScript
//! `AdapterRegistry` stays the one owner of the JavaScript adapter objects, keeps its backend
//! across engines, and gains an `observe` listener; this view copies the entries the listener
//! hands it and applies the engine's lookup rules. It never calls `registry.close()`.

use crate::EngineError;

/// One registered adapter, as the shell describes it. `adapter` is the binding's handle to the
/// current bound JavaScript adapter object.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub provider: String,
    pub backend: Option<String>,
    pub adapter: u32,
    pub capabilities: ace_json::Value,
    pub discovery: ace_json::Value,
}

/// The engine's copy of the registry: by provider, and by `provider:backend`.
#[derive(Debug, Default)]
pub struct Registry {
    entries: Vec<Entry>,
    by_provider: std::collections::HashMap<String, usize>,
    by_backend: std::collections::HashMap<String, usize>,
}

fn field<'a>(value: &'a ace_json::Value, name: &str) -> Option<&'a ace_json::Value> {
    match value {
        ace_json::Value::Object(map) => map.get(name),
        _ => None,
    }
}

fn is_current(item: &ace_json::Value) -> bool {
    matches!(field(item, "current"), Some(ace_json::Value::Bool(true)))
}

fn text(value: Option<&ace_json::Value>) -> Option<String> {
    match value {
        Some(ace_json::Value::String(text)) => Some(text.as_str().to_string()),
        _ => None,
    }
}

impl Registry {
    /// Replaces the view with the entries `observe` (or construction) handed over.
    pub fn set_entries(&mut self, json: &str) -> Result<(), EngineError> {
        let parsed =
            ace_json::parse(json).map_err(|error| EngineError::Registry(error.to_string()))?;
        let items = match parsed {
            ace_json::Value::Array(items) => items.into_vec(),
            _ => {
                return Err(EngineError::Registry(
                    "registry entries are not an array".into(),
                ));
            }
        };
        self.entries.clear();
        self.by_provider.clear();
        self.by_backend.clear();
        // The shell marks each provider's current entry. Older callers omit the marker, and
        // then the last registration wins, as before.
        let marked = items.iter().any(is_current);
        for item in items {
            let provider = text(field(&item, "provider")).unwrap_or_default();
            if provider.is_empty() {
                continue;
            }
            let backend = text(field(&item, "backend"));
            let adapter = match field(&item, "adapter") {
                Some(ace_json::Value::Number(number)) => number.as_u64().unwrap_or(0) as u32,
                _ => 0,
            };
            let index = self.entries.len();
            self.entries.push(Entry {
                provider: provider.clone(),
                backend: backend.clone(),
                adapter,
                capabilities: field(&item, "capabilities").cloned().unwrap_or_default(),
                discovery: field(&item, "discovery").cloned().unwrap_or_default(),
            });
            if is_current(&item) || !marked {
                self.by_provider.insert(provider.clone(), index);
            }
            if let Some(backend) = backend {
                self.by_backend
                    .insert(format!("{provider}:{backend}"), index);
            }
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn has(&self, provider: &str) -> bool {
        self.by_provider.contains_key(provider)
    }

    /// `has` with an identity asks the adapter (`acceptsIdentity`); E5.6's session opening is
    /// its first caller, and E5.1 answers with the provider's presence.
    pub fn has_identity(&self, provider: &str, _identity: Option<&str>) -> bool {
        self.has(provider)
    }

    /// `get`: Cursor is pinned to `cursor-sdk`, and a missing entry fails with today's message.
    pub fn get(&self, provider: &str, backend: Option<&str>) -> Result<&Entry, EngineError> {
        let pinned = if provider == "cursor" {
            self.by_provider
                .get(provider)
                .map(|index| self.entries[*index].backend.as_deref() == Some("cursor-sdk"))
                .unwrap_or(false)
        } else {
            false
        };
        let backend = if pinned { Some("cursor-sdk") } else { backend };
        let found = match backend {
            Some(backend) => self.by_backend.get(&format!("{provider}:{backend}")),
            None => self.by_provider.get(provider),
        };
        found
            .and_then(|index| self.entries.get(*index))
            .ok_or(EngineError::ProviderNotReady)
    }

    /// `providerAvailability`: the discovery reading a command gates on.
    pub fn availability(&self, provider: &str) -> Result<String, EngineError> {
        let discovery = &self.get(provider, None)?.discovery;
        let installed = matches!(
            field(discovery, "installed"),
            Some(ace_json::Value::Bool(true))
        );
        let auth = text(field(discovery, "auth")).unwrap_or_else(|| "unknown".to_string());
        Ok(format!(
            "{{\"installed\":{installed},\"auth\":\"{}\"}}",
            auth.replace('"', "\\\"")
        ))
    }

    /// `capabilities`: a fresh copy each call, as the TypeScript returns.
    pub fn capabilities(
        &self,
        provider: &str,
        backend: Option<&str>,
    ) -> Result<String, EngineError> {
        Ok(ace_json::to_string(
            &self.get(provider, backend)?.capabilities,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Registry {
        let mut registry = Registry::default();
        registry
            .set_entries(
                r#"[
                    {"provider":"codex","backend":"sdk","adapter":1,
                     "capabilities":{"steer":true},
                     "discovery":{"installed":true,"auth":"ok","path":"/x","version":"1"}},
                    {"provider":"cursor","backend":"cursor-sdk","adapter":2,
                     "capabilities":{"steer":false},
                     "discovery":{"installed":false,"auth":"unknown"}}
                ]"#,
            )
            .expect("entries");
        registry
    }

    #[test]
    fn a_missing_provider_fails_with_todays_message() {
        let registry = registry();
        let error = registry.get("claude", None).expect_err("not ready");
        assert_eq!(
            error.to_string(),
            "The provider isn't ready yet. Check its connection in Settings and try again."
        );
    }

    #[test]
    fn cursor_is_pinned_to_the_sdk_backend() {
        let registry = registry();
        // Asking for the ACP backend still resolves the SDK entry the registry holds.
        let entry = registry.get("cursor", Some("acp")).expect("pinned");
        assert_eq!(entry.backend.as_deref(), Some("cursor-sdk"));
    }

    #[test]
    fn availability_and_capabilities_come_from_the_entry() {
        let registry = registry();
        assert_eq!(
            registry.availability("codex").expect("availability"),
            r#"{"installed":true,"auth":"ok"}"#
        );
        assert_eq!(
            registry.capabilities("codex", None).expect("capabilities"),
            r#"{"steer":true}"#
        );
    }

    /// The shell's snapshot lists each provider's current entry, then the older backend
    /// registrations; the provider default must resolve the entry the snapshot marked current,
    /// whichever position it takes in the list.
    #[test]
    fn the_current_entry_wins_the_provider_default() {
        let mut registry = Registry::default();
        registry
            .set_entries(
                r#"[
                    {"provider":"codex","backend":"acp","adapter":2,"current":true,
                     "capabilities":{"steer":false},
                     "discovery":{"installed":true,"auth":"ok"}},
                    {"provider":"codex","backend":"sdk","adapter":1,"current":false,
                     "capabilities":{"steer":true},
                     "discovery":{"installed":true,"auth":"ok"}}
                ]"#,
            )
            .expect("entries");
        let entry = registry.get("codex", None).expect("provider default");
        assert_eq!(entry.adapter, 2, "the current entry");
        assert_eq!(
            registry.capabilities("codex", None).expect("capabilities"),
            r#"{"steer":false}"#
        );
        // An older backend keeps its own lookup beside the current entry.
        assert_eq!(
            registry
                .get("codex", Some("sdk"))
                .expect("older backend")
                .adapter,
            1
        );
    }

    #[test]
    fn an_unknown_backend_fails_like_a_missing_provider() {
        let registry = registry();
        assert!(registry.get("codex", Some("acp")).is_err());
        assert!(registry.has("codex"));
        assert!(!registry.has("claude"));
    }
}
