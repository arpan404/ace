// SPDX-License-Identifier: Apache-2.0
//! Lenient decoding of the optional hints every provider's model entry may carry.
//!
//! Ports `packages/models/src/catalog-metadata.ts`. One malformed extension must
//! not erase the others, so every field is decoded alone and a bad one reads as
//! absent. zod's bounds count code points (rule 17), so an id of 256 emoji is
//! accepted and 257 is not.

use serde_json::Value;

use crate::native::{label, labels};
use std::sync::OnceLock;

const ALIAS_LIMIT: usize = 32;

/// The hints ace reads from a native model entry, each independently decoded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CatalogMetadata {
    pub status: Option<String>,
    pub resolved_model: Option<String>,
    pub resolved_model_id: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub deprecated: Option<bool>,
    pub legacy: Option<bool>,
    pub internal: Option<bool>,
    /// The entry's `type` hint (renamed so the Rust field isn't a keyword).
    pub kind: Option<String>,
    pub task: Option<String>,
    pub chat: Option<bool>,
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

fn text(value: Option<&Value>) -> Option<String> {
    value?.as_str().map(str::to_owned)
}

fn flag(value: Option<&Value>) -> Option<bool> {
    value?.as_bool()
}

/// The hints in `value`; an unreadable field is absent and does not affect the rest.
pub fn catalog_metadata(value: &Value) -> CatalogMetadata {
    let capabilities = field(value, "capabilities");
    CatalogMetadata {
        status: text(field(value, "status")),
        resolved_model: label(field(value, "resolvedModel")),
        resolved_model_id: label(field(value, "resolvedModelId")),
        aliases: labels(field(value, "aliases"), ALIAS_LIMIT),
        deprecated: flag(field(value, "deprecated")),
        legacy: flag(field(value, "legacy")),
        internal: flag(field(value, "internal")),
        kind: text(field(value, "type")),
        task: text(field(value, "task")),
        chat: capabilities.and_then(|capabilities| flag(field(capabilities, "chat"))),
    }
}

fn non_chat_hint(hint: &str) -> bool {
    static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(
            r"(?i)^(?:embedding|rerank|transcription|image-generation|speech|internal)$",
        )
        .ok()
    });
    pattern
        .as_ref()
        .map(|pattern| pattern.is_match(hint))
        .unwrap_or(false)
}

/// Whether the entry is a chat model the catalog may list.
pub fn chat_metadata(value: &Value) -> bool {
    let info = catalog_metadata(value);
    !info.internal.unwrap_or(false)
        && info
            .status
            .as_deref()
            .is_none_or(|status| status.to_lowercase() != "internal")
        && info.chat != Some(false)
        && ![info.kind.as_deref(), info.task.as_deref()]
            .into_iter()
            .flatten()
            .any(non_chat_hint)
}

/// Whether the provider marks the entry legacy, deprecated or retired.
pub fn legacy_metadata(value: &Value) -> bool {
    let info = catalog_metadata(value);
    info.legacy.unwrap_or(false)
        || info.deprecated.unwrap_or(false)
        || info
            .status
            .as_deref()
            .map(|status| {
                static PATTERN: OnceLock<Option<regex::Regex>> = OnceLock::new();
                PATTERN
                    .get_or_init(|| regex::Regex::new(r"(?i)^(?:legacy|deprecated|retired)$").ok())
                    .as_ref()
                    .map(|pattern| pattern.is_match(status))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    //! Ports the catalog-classification cases that pin the metadata decoder:
    //! - `packages/models/src/defaults.process.test.ts`, "Codex pages deduplicate
    //!   model slugs and remove embedding and internal endpoints": `internal` and
    //!   embedding entries are not chat models, while an unknown status is;
    //! - the same file's "OpenCode current connected rows survive earlier legacy and
    //!   internal duplicates": `status: "legacy"` and `internal: true` classify as the
    //!   decoder's legacy/non-chat result;
    //! - "unknown ACP option semantics preserve models and bounded redacted raw
    //!   metadata": `aliases: 42` is ignored while `internal` still reads;
    //! - `packages/models/src/acp-legacy-models.test.ts`'s malformed-list cases rely on
    //!   unknown hints never throwing.
    //!
    //! Rule 17: the id/alias bounds are zod's, so they count code points.

    use super::*;
    use serde_json::json;

    #[test]
    fn internal_and_embedding_entries_are_not_chat_models() {
        assert!(!chat_metadata(&json!({ "internal": true })));
        assert!(!chat_metadata(&json!({ "status": "Internal" })));
        assert!(!chat_metadata(&json!({ "type": "embedding" })));
        assert!(!chat_metadata(&json!({ "task": "Rerank" })));
        assert!(!chat_metadata(
            &json!({ "capabilities": { "chat": false } })
        ));
        assert!(chat_metadata(&json!({ "status": "active" })));
        assert!(chat_metadata(&json!({ "status": "legacy" })));
        assert!(chat_metadata(&json!({ "capabilities": { "chat": true } })));
        assert!(chat_metadata(&json!({})));
    }

    #[test]
    fn legacy_covers_the_flag_the_deprecation_and_the_provider_status() {
        assert!(legacy_metadata(&json!({ "legacy": true })));
        assert!(legacy_metadata(&json!({ "deprecated": true })));
        assert!(legacy_metadata(&json!({ "status": "Deprecated" })));
        assert!(legacy_metadata(&json!({ "status": "retired" })));
        assert!(!legacy_metadata(&json!({ "status": "active" })));
        assert!(!legacy_metadata(&json!({ "status": "internal" })));
    }

    #[test]
    fn one_malformed_hint_does_not_erase_the_others() {
        let info = catalog_metadata(&json!({
            "internal": true,
            "aliases": 42,
            "resolvedModel": "claude-opus-5-5",
            "deprecated": "yes",
        }));
        assert_eq!(info.internal, Some(true));
        assert_eq!(info.aliases, None);
        assert_eq!(info.resolved_model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(info.deprecated, None);
    }

    #[test]
    fn id_and_alias_bounds_count_code_points_not_bytes() {
        let accepted = "🚀".repeat(256);
        let rejected = "🚀".repeat(257);
        assert!(
            catalog_metadata(&json!({ "resolvedModel": accepted }))
                .resolved_model
                .is_some()
        );
        assert!(
            catalog_metadata(&json!({ "resolvedModel": rejected }))
                .resolved_model
                .is_none()
        );
        assert_eq!(
            catalog_metadata(&json!({ "resolvedModelId": "" })).resolved_model_id,
            None
        );
        let aliases: Vec<String> = (0..32).map(|n| format!("alias-{n}")).collect();
        assert_eq!(
            catalog_metadata(&json!({ "aliases": aliases }))
                .aliases
                .map(|list| list.len()),
            Some(32)
        );
        let too_many: Vec<String> = (0..33).map(|n| format!("alias-{n}")).collect();
        assert_eq!(
            catalog_metadata(&json!({ "aliases": too_many })).aliases,
            None
        );
        // One malformed alias fails the whole list, as the zod array does.
        assert_eq!(
            catalog_metadata(&json!({ "aliases": ["ok", 7] })).aliases,
            None
        );
    }
}
