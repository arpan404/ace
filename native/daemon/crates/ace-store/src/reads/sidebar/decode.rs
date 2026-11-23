// SPDX-License-Identifier: Apache-2.0
//! Trusted thread-row decode for the sidebar and thread lists.
//!
//! Mirrors the trusted path of `decodeThreadRow` (`apps/daemon/src/thread-row.ts`)
//! with its fragments from `stored-decode.ts`: a row this build confirmed at its
//! current revision (`row_trusted === 1`, see `thread-row-trust.ts`) is read as
//! stored, field for field. Anything else, and any row that does not read as its
//! trusted shape, is marked `{"$untrusted":true}` so the TypeScript shell decodes
//! it with the existing lenient decoders. A row whose stored JSON cannot be read
//! therefore never fails here; it fails, if at all, where the TypeScript decode
//! fails.
//!
//! Stored fragments go out as stored: JSON columns are TEXT holding JSON text,
//! so one level is unwrapped and the inner text is spliced verbatim, never
//! re-encoded. The top level is assembled in `Thread.shape` field order with the
//! cursor continuation, as `assemble` does. The key sets below are those
//! `stored-decode.ts` picks with; a schema change clears every trust stamp
//! (`threadRowShape`), which turns every row untrusted until this file is updated
//! to match, so staleness stays correct.

use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::fmt;

/// Ways decoding a batch of thread rows can fail. A row that is not trusted, or
/// that does not read as its trusted shape, is marked untrusted in the output
/// instead of failing: only a malformed batch fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The input was not a JSON array of row objects.
    Input(&'static str),
    /// The input was not valid JSON.
    Json(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Input(why) => write!(f, "sidebar thread rows: {why}"),
            Error::Json(why) => write!(f, "sidebar thread rows: invalid JSON: {why}"),
        }
    }
}

impl std::error::Error for Error {}

/// The result of decoding thread rows.
pub type Result<T> = std::result::Result<T, Error>;

/// Marker for a row the shell must decode itself, parallel to the thread a
/// trusted row decodes to. A real thread never carries this key: the trusted
/// decode only emits `Thread.shape` fields.
const UNTRUSTED: &str = "{\"$untrusted\":true}";

/// `Thread.shape` field order, as `assemble` emits it.
const FIELD_ORDER: &[&str] = &[
    "pinned",
    "pinOrder",
    "listOrder",
    "unread",
    "readAt",
    "settledAt",
    "settledReason",
    "settledOverQueue",
    "snoozedUntil",
    "snoozeWake",
    "snoozeWoke",
    "deletedAt",
    "activityAt",
    "autoSettleAt",
    "autoSettle",
    "settleWhenDone",
    "prSettled",
    "prSettledKey",
    "activitySeq",
    "hasSentMessage",
    "details",
    "live",
    "movedFrom",
    "host",
    "hostKey",
    "id",
    "workspaceId",
    "title",
    "queue",
    "goal",
    "titleSource",
    "provider",
    "backend",
    "continuation",
    "capabilities",
    "capabilitiesRef",
    "permission",
    "handoff",
    "acpAgentId",
    "installationId",
    "instanceId",
    "effectiveCapabilities",
    "acpSupport",
    "rootAgentId",
    "status",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "imported",
    "lineage",
    "delegatedBy",
    "delegatedFrom",
    "startedBy",
    "startedByClient",
    "treeRootId",
    "queuedLaunch",
    "execution",
    "switch",
];

/// `ThreadClientFields` without `details`, as `stored-decode.ts` picks it.
const CLIENT_KEYS: &[&str] = &[
    "pinned",
    "pinOrder",
    "listOrder",
    "unread",
    "readAt",
    "settledAt",
    "settledReason",
    "settledOverQueue",
    "snoozedUntil",
    "snoozeWake",
    "snoozeWoke",
    "deletedAt",
    "activityAt",
    "autoSettleAt",
    "autoSettle",
    "settleWhenDone",
    "prSettled",
    "prSettledKey",
    "activitySeq",
    "hasSentMessage",
    "live",
    "movedFrom",
    "host",
    "hostKey",
];

/// `ThreadTransitionView`, as `stored-decode.ts` picks it.
const TRANSITION_KEYS: &[&str] = &[
    "lineage",
    "delegatedBy",
    "delegatedFrom",
    "startedBy",
    "startedByClient",
    "treeRootId",
    "queuedLaunch",
    "execution",
    "switch",
];

/// `ThreadProviderMetadata`, as `stored-decode.ts` picks it.
const ACP_KEYS: &[&str] = &[
    "acpAgentId",
    "installationId",
    "instanceId",
    "effectiveCapabilities",
    "acpSupport",
];

/// The provider-metadata fields that are thread fields, as `stored-decode.ts`.
const METADATA_KEYS: &[&str] = &[
    "backend",
    "handoff",
    "permission",
    "titleSource",
    "queue",
    "goal",
];

/// The cursor continuation `assemble` adds for retired Cursor threads.
const CONTINUATION: &str = "{\"state\":\"read_only\",\"reason\":\"cursor_cli_retired\",\"actionId\":\"thread.continue_new\"}";

/// Decode every row the TypeScript loader read into its thread, as one JSON
/// array parallel to the input rows. Trusted rows decode to their thread; any
/// other row decodes to the untrusted marker.
pub fn decode_thread_rows(rows_json: &str) -> Result<String> {
    let rows: Vec<&RawValue> =
        serde_json::from_str(rows_json).map_err(|error| Error::Json(error.to_string()))?;
    if rows.is_empty() {
        return Ok(String::from("[]"));
    }
    let mut out = String::with_capacity(rows_json.len());
    out.push('[');
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        match decode_row(row.get()) {
            Some(thread) => out.push_str(&thread),
            None => out.push_str(UNTRUSTED),
        }
    }
    out.push(']');
    Ok(out)
}

/// Whether this row reads as stored: the trust stamp at its current revision.
fn trusted(row: &BTreeMap<&str, &RawValue>) -> bool {
    row.get("row_trusted")
        .and_then(|raw| raw.get().parse::<i64>().ok())
        == Some(1)
}

/// A verbatim scalar (string, number, boolean or null, as the row holds it), or
/// nothing for an object or array, which a trusted scalar column never holds.
fn scalar(text: &str) -> Option<&str> {
    match text.as_bytes().first() {
        Some(b'"') | Some(b'-') | Some(b'0'..=b'9') | Some(b't') | Some(b'f') | Some(b'n') => {
            Some(text)
        }
        _ => None,
    }
}

/// The inner JSON text of a stored JSON column, which the row holds as a JSON
/// string: nothing when the column is null, invalid when it is not stored text
/// holding valid JSON. Mirrors `String(row.column)` then `JSON.parse`.
fn inner_json(text: &str) -> Option<Option<String>> {
    if text == "null" {
        return Some(None);
    }
    if text.starts_with('"') {
        let inner: String = serde_json::from_str(text).ok()?;
        serde_json::from_str::<serde_json::Value>(&inner).ok()?;
        return Some(Some(inner));
    }
    // A scalar where stored text was expected: `String(value)` keeps it.
    if text.starts_with('{') || text.starts_with('[') {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(text).ok()?;
    Some(Some(text.to_owned()))
}

/// The picked fragments of a stored object column, verbatim. Null and
/// non-object JSON read as empty, as `picked` does.
fn fragments(inner: &str) -> BTreeMap<String, Box<RawValue>> {
    serde_json::from_str(inner).unwrap_or_default()
}

fn push_field(out: &mut String, first: &mut bool, name: &str, raw: &str) {
    if !*first {
        out.push(',');
    }
    *first = false;
    out.push('"');
    out.push_str(name);
    out.push_str("\":");
    out.push_str(raw);
}

/// The thread a trusted row reads as, or nothing when the row is not trusted
/// or does not read as its trusted shape.
fn decode_row(text: &str) -> Option<String> {
    let row: BTreeMap<&str, &RawValue> = serde_json::from_str(text).ok()?;
    let cell = |key: &str| row.get(key).map(|raw| raw.get());
    if !trusted(&row) {
        return None;
    }
    let client = inner_json(cell("client")?)?;
    let transitions = inner_json(cell("transitions")?)?;
    let metadata = inner_json(cell("provider_metadata")?)?;
    let acp = inner_json(cell("acp")?)?;
    let details = inner_json(cell("details")?)?;
    let capabilities = inner_json(cell("capabilities")?)?;
    let status = inner_json(cell("status")?)?;
    let imported = inner_json(cell("imported").unwrap_or("null"))?;
    let client = client.map(|json| fragments(&json)).unwrap_or_default();
    let transitions = transitions.map(|json| fragments(&json)).unwrap_or_default();
    let metadata = metadata.map(|json| fragments(&json)).unwrap_or_default();
    let acp = acp.map(|json| fragments(&json)).unwrap_or_default();
    let id = scalar(cell("id")?)?;
    let workspace_id = scalar(cell("workspace_id")?)?;
    let title = scalar(cell("title")?)?;
    let provider = scalar(cell("provider")?)?;
    let created_at = scalar(cell("created_at")?)?;
    let updated_at = scalar(cell("updated_at")?)?;
    let archived_at = optional_scalar(cell("archived_at").unwrap_or("null"))?;
    let root_agent_id = optional_scalar(cell("root_agent_id").unwrap_or("null"))?;
    let mut out = String::with_capacity(text.len());
    out.push('{');
    let mut first = true;
    for name in FIELD_ORDER {
        let raw = match *name {
            "details" => details.as_deref(),
            "id" => Some(id),
            "workspaceId" => Some(workspace_id),
            "title" => Some(title),
            "provider" => Some(provider),
            "createdAt" => Some(created_at),
            "updatedAt" => Some(updated_at),
            "archivedAt" => archived_at,
            "imported" => imported.as_deref(),
            "rootAgentId" => root_agent_id,
            "status" => status.as_deref(),
            "capabilities" => capabilities.as_deref(),
            "continuation" => continuation(provider, metadata.get("backend").map(Box::as_ref)),
            _ => client
                .get(*name)
                .filter(|_| CLIENT_KEYS.contains(name))
                .map(Box::as_ref)
                .map(RawValue::get)
                .or_else(|| {
                    transitions
                        .get(*name)
                        .filter(|_| TRANSITION_KEYS.contains(name))
                        .map(Box::as_ref)
                        .map(RawValue::get)
                })
                .or_else(|| {
                    metadata
                        .get(*name)
                        .filter(|_| METADATA_KEYS.contains(name))
                        .map(Box::as_ref)
                        .map(RawValue::get)
                })
                .or_else(|| {
                    acp.get(*name)
                        .filter(|_| ACP_KEYS.contains(name))
                        .map(Box::as_ref)
                        .map(RawValue::get)
                }),
        };
        if let Some(raw) = raw {
            push_field(&mut out, &mut first, name, raw);
        }
    }
    out.push('}');
    Some(out)
}

/// A nullable base column: nothing when null or missing, verbatim otherwise.
fn optional_scalar(text: &str) -> Option<Option<&str>> {
    if text == "null" {
        return Some(None);
    }
    scalar(text).map(Some)
}

/// The continuation for a retired Cursor thread, as `assemble` adds it.
fn continuation(provider: &str, backend: Option<&RawValue>) -> Option<&'static str> {
    let provider: String = serde_json::from_str(provider).ok()?;
    if provider.as_str() != "cursor" {
        return None;
    }
    let sdk = backend
        .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
        .as_deref()
        == Some("cursor-sdk");
    if sdk { None } else { Some(CONTINUATION) }
}
