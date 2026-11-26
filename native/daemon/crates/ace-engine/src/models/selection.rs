// SPDX-License-Identifier: Apache-2.0
//! `@ace/models`' selection helpers, ported beside `models/select.rs` (E5.4e): the default
//! sentinel, the execution id a catalog row resolves to, and the filter a selection asks for.

use ace_json::{Map, Value};

/// `isDefaultSelection` (`model-selection.ts:3`): "default" or "default (recommended)",
/// case-insensitive and trimmed.
pub fn is_default_selection(model: Option<&str>) -> bool {
    let Some(model) = model else {
        return false;
    };
    let lowered = model.trim().to_lowercase();
    if lowered == "default" {
        return true;
    }
    lowered
        .strip_prefix("default")
        .is_some_and(|rest| rest.trim_start() == "(recommended)")
}

/// `executionModelId` (`execution-id.ts:8`): the provider's own id, source-qualified when the
/// catalog row records a source the model id does not already carry.
pub fn execution_model_id(native_model_id: &str, native_provider_id: Option<&str>) -> String {
    let prefix = match native_provider_id {
        Some(provider) if !provider.is_empty() => format!("{provider}/"),
        _ => return native_model_id.to_owned(),
    };
    if native_model_id.starts_with(&prefix) {
        native_model_id.to_owned()
    } else {
        format!("{prefix}{native_model_id}")
    }
}

/// `selectionModelFilter` (`selection-scope.ts:5`): without an account the native CLI is meant,
/// never an arbitrary one; ACP rows are selected by their source-qualified identity.
pub fn selection_model_filter(
    provider: &str,
    instance: Option<&str>,
    identity: Option<&Value>,
) -> Option<Value> {
    let mut filter = Map::new();
    filter.insert("provider", Value::from(provider));
    if provider == "acp" {
        let identity = identity?;
        for key in ["acpAgentId", "installationId", "instanceId"] {
            let value = identity.get(key)?.clone();
            filter.insert(key, value);
        }
        return Some(Value::Object(filter));
    }
    let instance = instance.map_or_else(|| format!("{provider}-cli-default"), str::to_owned);
    filter.insert("instance", Value::from(instance));
    Some(Value::Object(filter))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn the_default_sentinel_is_trimmed_and_case_insensitive() {
        for text in [
            "default",
            " Default ",
            "DEFAULT",
            "default (recommended)",
            "default(recommended)",
        ] {
            assert!(is_default_selection(Some(text)), "{text}");
        }
        for text in [
            "defaultx",
            "default recommended",
            "gpt-5",
            "default (recommended) now",
        ] {
            assert!(!is_default_selection(Some(text)), "{text}");
        }
        assert!(!is_default_selection(None));
    }

    #[test]
    fn an_execution_id_carries_the_source_only_when_the_model_id_lacks_it() {
        assert_eq!(
            execution_model_id("claude-sonnet", Some("anthropic")),
            "anthropic/claude-sonnet"
        );
        assert_eq!(
            execution_model_id("anthropic/claude-sonnet", Some("anthropic")),
            "anthropic/claude-sonnet"
        );
        assert_eq!(execution_model_id("claude-sonnet", None), "claude-sonnet");
        assert_eq!(
            execution_model_id("claude-sonnet", Some("")),
            "claude-sonnet"
        );
    }

    #[test]
    fn a_filter_names_the_cli_default_or_the_acp_identity() {
        assert_eq!(
            ace_json::to_string(&selection_model_filter("codex", None, None).unwrap()),
            r#"{"provider":"codex","instance":"codex-cli-default"}"#
        );
        assert_eq!(
            ace_json::to_string(&selection_model_filter("claude", Some("work"), None).unwrap()),
            r#"{"provider":"claude","instance":"work"}"#
        );
        let identity =
            value(r#"{"acpAgentId":"agent","installationId":"install","instanceId":"instance"}"#);
        assert_eq!(
            ace_json::to_string(&selection_model_filter("acp", None, Some(&identity)).unwrap()),
            r#"{"provider":"acp","acpAgentId":"agent","installationId":"install","instanceId":"instance"}"#
        );
        assert!(selection_model_filter("acp", None, None).is_none());
    }
}
