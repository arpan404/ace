// SPDX-License-Identifier: Apache-2.0
//! A dictionary's transaction lifecycle (E5.3 step 4, `records.ts:241`-`:290`): persist,
//! committed, flush and release. The SQL text is the TypeScript's, from the call sites named on
//! each statement.

use ace_core::section::Change;
use ace_store::stmt_cache;
use std::rc::Rc;

use ace_json::Value;

use super::budget::Cached;
use super::{DELETE_APPENDS, DELETE_RECORD, Records, UPSERT_RECORD, insert_patch, text};
use crate::EngineError;

/// A record's typed form loses fields this build does not know; the stored value keeps them
/// (`parseRecord` validates without stripping, `records.ts:15`), so a newer build's fields
/// survive a write by this one.
fn keep_unknown_fields(encoded: &str, base: &str) -> String {
    let (Ok(Value::Object(typed)), Ok(Value::Object(original))) =
        (ace_json::parse(encoded), ace_json::parse(base))
    else {
        return encoded.to_owned();
    };
    let mut merged = typed.clone();
    let added = merge_unknown(&mut merged, &original, &KNOWN_FIELDS);
    if !added {
        return encoded.to_owned();
    }
    ace_json::to_string(&Value::Object(merged))
}

/// Fields of the record types this build writes (`ace-core`'s `AgentRecord`, `Item` and
/// `ToolCall`). A field here that the typed form omitted was cleared by the fold, so the old
/// value must not come back; anything else is a newer build's field and is kept, at any depth.
const KNOWN_FIELDS: [&str; 46] = [
    "agent",
    "activity",
    "lastSignalAt",
    "parentKey",
    "spawnedByKey",
    "appended",
    "completionRelevant",
    "nativeRuns",
    "activeRun",
    "lastRun",
    "lastOutcomeOrder",
    "lastSuccessfulOutcomeOrder",
    "externalStatus",
    "lastError",
    "processSettledStatus",
    "detail",
    "disconnectedAt",
    "retry",
    "wakeUntil",
    "limited",
    "id",
    "threadId",
    "agentId",
    "runId",
    "createdAt",
    "nativeId",
    "complete",
    "type",
    "role",
    "parts",
    "text",
    "call",
    "level",
    "commandId",
    "interactionId",
    "code",
    "title",
    "source",
    "diagnostic",
    "asked",
    "details",
    "measurement",
    "raw",
    "visualization",
    "backgroundTaskId",
    "error",
];

/// The fields of one nested record type, from `ace-core`'s serde definitions below. A nested
/// object merges only against its own type's list, so a cleared optional inside it never comes
/// back and an unknown field a newer build wrote is kept (`AGENTS.md`).
struct Nested {
    key: &'static str,
    fields: &'static [&'static str],
    /// The element type's fields when the value is an array of records.
    element: Option<&'static [&'static str]>,
}

const AGENT: &[&str] = &[
    "id",
    "threadId",
    "parentId",
    "origin",
    "native",
    "fidelity",
    "cwd",
    "status",
    "background",
    "createdAt",
    "spawnedBy",
    "lineage",
    "name",
    "role",
    "model",
    "machine",
    "childThreadId",
    "endedAt",
];
const AGENT_STATUS: &[&str] = &[
    "state",
    "on",
    "refs",
    "until",
    "attempt",
    "message",
    "retryOrder",
    "detail",
];
const AGENT_ERROR: &[&str] = &["kind", "message", "code", "title", "detail", "details"];
const THREAD_STATUS: &[&str] = &[
    "state",
    "agents",
    "interactions",
    "on",
    "slotLimit",
    "slotsInUse",
    "queuePosition",
    "refs",
    "until",
    "attempt",
    "message",
    "retryOrder",
    "hostId",
    "name",
    "threadId",
    "reason",
    "raw",
];
const RETRY: &[&str] = &["on", "attempt", "until", "message"];
const LIMITED: &[&str] = &["until", "message"];
const TOOL_CALL: &[&str] = &[
    "id",
    "agentId",
    "kind",
    "title",
    "status",
    "detail",
    "backgroundTaskId",
    "error",
    "result",
    "startedAt",
    "endedAt",
    "raw",
    "measurement",
];
const TOOL_DETAIL: &[&str] = &[
    "kind",
    "command",
    "rawCommand",
    "description",
    "cwd",
    "exitCode",
    "output",
    "path",
    "diff",
    "oldText",
    "newText",
    "movePath",
    "pattern",
    "query",
    "title",
    "url",
    "language",
    "bytes",
    "lines",
    "changes",
    "target",
    "arguments",
    "result",
    "text",
    "files",
];
const TOOL_RESULT: &[&str] = &[
    "isError",
    "content",
    "structuredContent",
    "durationMs",
    "target",
    "mode",
    "scale",
    "size",
];
const OUTPUT_SUMMARY: &[&str] = &["streamId", "bytes", "tail", "truncated"];
const RAW_PAYLOAD: &[&str] = &["type", "text", "blobRef", "bytes", "mimeType"];
const CONTENT_PART: &[&str] = &[
    "type", "text", "image", "mention", "entryId", "name", "bytes", "mimeType", "path",
];
const ATTACHMENT: &[&str] = &[
    "sha256",
    "bytes",
    "mimeType",
    "name",
    "kind",
    "delivery",
    "width",
    "height",
    "thumbnailAvailable",
];

const NESTED: [Nested; 15] = [
    Nested {
        key: "agent",
        fields: AGENT,
        element: None,
    },
    Nested {
        key: "status",
        fields: AGENT_STATUS,
        element: None,
    },
    Nested {
        key: "lastError",
        fields: AGENT_ERROR,
        element: None,
    },
    Nested {
        key: "externalStatus",
        fields: THREAD_STATUS,
        element: None,
    },
    Nested {
        key: "processSettledStatus",
        fields: AGENT_STATUS,
        element: None,
    },
    Nested {
        key: "retry",
        fields: RETRY,
        element: None,
    },
    Nested {
        key: "limited",
        fields: LIMITED,
        element: None,
    },
    Nested {
        key: "call",
        fields: TOOL_CALL,
        element: None,
    },
    Nested {
        key: "detail",
        fields: TOOL_DETAIL,
        element: None,
    },
    Nested {
        key: "result",
        fields: TOOL_RESULT,
        element: None,
    },
    Nested {
        key: "output",
        fields: OUTPUT_SUMMARY,
        element: None,
    },
    Nested {
        key: "raw",
        fields: RAW_PAYLOAD,
        element: Some(RAW_PAYLOAD),
    },
    Nested {
        key: "parts",
        fields: CONTENT_PART,
        element: Some(CONTENT_PART),
    },
    Nested {
        key: "content",
        fields: CONTENT_PART,
        element: Some(CONTENT_PART),
    },
    Nested {
        key: "attachments",
        fields: ATTACHMENT,
        element: Some(ATTACHMENT),
    },
];

fn nested(key: &str) -> Option<&'static Nested> {
    NESTED.iter().find(|nested| nested.key == key)
}

/// Copy every field the typed form does not know, at every depth: a known field the fold cleared
/// stays cleared, and an unknown one a newer build wrote is kept. Objects of types not in
/// [`NESTED`] are left as the typed form has them; an array of a listed type merges element by
/// element.
fn merge_unknown(typed: &mut ace_json::Map, original: &ace_json::Map, known: &[&str]) -> bool {
    let mut added = false;
    for (key, value) in original {
        if known.contains(&key.as_str()) && !typed.contains_key(key) {
            continue;
        }
        match typed.get_mut(key) {
            None => {
                typed.insert(key.clone(), value.clone());
                added = true;
            }
            Some(Value::Object(inner)) => {
                if let (Value::Object(outer), Some(nested)) = (value, nested(key)) {
                    added |= merge_unknown(inner, outer, nested.fields);
                }
            }
            Some(Value::Array(inner)) => {
                if let (Value::Array(outer), Some(nested)) = (value, nested(key))
                    && let Some(element) = nested.element
                {
                    for (typed, original) in inner.iter_mut().zip(outer) {
                        if let (Value::Object(typed), Value::Object(original)) = (typed, original) {
                            added |= merge_unknown(typed, original, element);
                        }
                    }
                }
            }
            Some(_) => {}
        }
    }
    added
}

impl<T: Clone + 'static> Records<T> {
    /// `persist` (`records.ts:241`): pending patches of keys not replaced, then every written
    /// and deleted slot.
    pub fn persist(&mut self) -> Result<(), EngineError> {
        let patches: Vec<(String, Vec<super::Append>)> = self
            .patches
            .iter()
            .map(|(key, patches)| (key.clone(), patches.clone()))
            .collect();
        for (key, list) in patches {
            if self.replaced.contains(&key) {
                continue;
            }
            for patch in list {
                insert_patch(&self.conn, &self.thread, &self.group, &key, &patch)?;
            }
        }
        for (key, change) in self.section.changes() {
            match change {
                Change::Deleted => {
                    stmt_cache::run(
                        &self.conn,
                        DELETE_APPENDS,
                        vec![text(&self.thread), text(&self.group), text(&key)],
                    )?;
                    stmt_cache::run(
                        &self.conn,
                        DELETE_RECORD,
                        vec![text(&self.thread), text(&self.group), text(&key)],
                    )?;
                }
                Change::Written(value) => {
                    if self.appended.contains(&key) && !self.replaced.contains(&key) {
                        continue;
                    }
                    let json = (self.encode)(&key, value)?;
                    let base = self
                        .section
                        .base_json(&key)
                        .map(str::to_owned)
                        .or_else(|| self.cache.get::<T>(&key).map(|cached| cached.json))
                        .unwrap_or_default();
                    let json = keep_unknown_fields(&json, &base);
                    if json != base || self.replaced.contains(&key) {
                        stmt_cache::run(
                            &self.conn,
                            DELETE_APPENDS,
                            vec![text(&self.thread), text(&self.group), text(&key)],
                        )?;
                        stmt_cache::run(
                            &self.conn,
                            UPSERT_RECORD,
                            vec![
                                text(&self.thread),
                                text(&self.group),
                                text(&key),
                                text(&json),
                            ],
                        )?;
                    }
                    let bytes = json.len();
                    self.cache.set(
                        &key,
                        Cached {
                            value: Rc::new(value.clone()),
                            json,
                            bytes,
                        },
                        bytes,
                    );
                }
            }
        }
        Ok(())
    }

    /// `committed` (`records.ts:278`): clear every overlay and the enumeration.
    pub fn committed(&mut self) {
        self.patches.clear();
        self.section.committed();
        self.replaced.clear();
        self.appended.clear();
        self.append_value = None;
    }

    /// `flush` (`records.ts:287`).
    pub fn flush(&mut self) -> Result<(), EngineError> {
        self.persist()?;
        self.committed();
        Ok(())
    }

    /// `release` (`records.ts:182`): give back this dictionary's share of the budget.
    /// Permanent: a released section caches nothing, and later reads use SQLite. Unflushed
    /// changes stay in the overlay, as the TypeScript's `touched` entries do.
    pub fn release(&mut self) {
        self.cache.disable();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(value: &impl serde::Serialize) -> Vec<String> {
        let json = ace_json::ser::to_string(value).unwrap();
        match ace_json::parse(&json).unwrap() {
            Value::Object(map) => map.keys().map(|key| key.as_str().to_owned()).collect(),
            _ => Vec::new(),
        }
    }

    /// A const must list every field the struct serializes: the literal forces each field, so a
    /// field added to the struct fails this test until the const gains it too.
    #[test]
    fn each_nested_field_list_is_the_structs_serde_fields() {
        let retry = ace_core::state::RetryInfo {
            on: "network".to_owned(),
            attempt: Some(1),
            until: Some(2),
            message: Some("m".to_owned()),
        };
        assert_eq!(keys(&retry), RETRY);
        let limited = ace_core::state::LimitedInfo {
            until: Some(1),
            message: Some("m".to_owned()),
        };
        assert_eq!(keys(&limited), LIMITED);
        let error = ace_core::status::AgentError {
            kind: "k".to_owned(),
            message: "m".to_owned(),
            code: Some("c".to_owned()),
            title: Some("t".to_owned()),
            detail: Some("d".to_owned()),
            details: Some(ace_core::status::ProviderErrorDetails {
                code: "c".to_owned(),
                provider: "p".to_owned(),
                title: Some("t".to_owned()),
                detail: Some("d".to_owned()),
                model: Some("m".to_owned()),
            }),
        };
        assert_eq!(keys(&error), AGENT_ERROR);
        let attachment = ace_core::item_model::Attachment {
            sha256: "s".to_owned(),
            bytes: 1,
            mime_type: "image/png".to_owned(),
            name: "n".to_owned(),
            kind: Some("image".to_owned()),
            delivery: Some("inline".to_owned()),
            width: Some(1),
            height: Some(2),
            thumbnail_available: Some(true),
        };
        let mut listed = keys(&attachment);
        listed.sort();
        let mut expected: Vec<String> = ATTACHMENT.iter().map(|key| (*key).to_owned()).collect();
        expected.sort();
        assert_eq!(listed, expected);
    }

    #[test]
    fn an_unknown_field_inside_a_part_survives_and_a_cleared_one_does_not() {
        let typed = r#"{"parts":[{"type":"text","text":"hi"}],"call":{"status":"succeeded"}}"#;
        let base = r#"{"parts":[{"type":"text","text":"old","futurePart":true}],"call":{"status":"running","futureNested":{"b":2},"error":"old"}}"#;
        let merged = keep_unknown_fields(typed, base);
        assert!(merged.contains(r#""futurePart":true"#), "{merged}");
        assert!(merged.contains(r#""futureNested":{"b":2}"#), "{merged}");
        assert!(merged.contains(r#""text":"hi""#), "{merged}");
        assert!(!merged.contains(r#""error":"old""#), "{merged}");
    }
}
