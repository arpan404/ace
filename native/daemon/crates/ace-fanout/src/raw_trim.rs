// SPDX-License-Identifier: Apache-2.0
//! Raw payloads a client only shows, left out for a client that says it can put them back.
//! Ports `rawShownOnly` and `omitRaw` from `packages/projection/src/wire-trim.ts`, with the
//! readers they ask (`history-visibility.ts`, `provider-notices.ts`, `diagnostic-notice.ts`,
//! `retry-notice.ts`). The encoder keeps a second encoding of an item event without these
//! payloads (`EventEncodings::trimmed_json`).

use ace_json::{Array, JsString, Map, Value};

use crate::js::{field, field_array, field_text, field_truth, js_trim, number, object, string};

/// `ProviderNoticeKind` from `provider-notices.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderNotice {
    BackgroundCompletion,
    SubagentResult,
    ParentAgent,
}

/// `value[key] === expected`, for the string constants the TypeScript compares against.
fn is(value: &Value, key: &str, expected: &str) -> bool {
    field_text(value, key).is_some_and(|seen| seen == expected)
}

/// `providerNotice(item)`: the ace input a provider-injected message stands for.
pub fn provider_notice(item: &Value) -> Option<ProviderNotice> {
    if !is(item, "type", "message") || !field_truth(item, "synthetic") {
        return None;
    }
    match native_source(item) {
        Some("shell") => return Some(ProviderNotice::BackgroundCompletion),
        Some("subagent") => return Some(ProviderNotice::SubagentResult),
        _ => {}
    }
    let raw_text = text_of(item);
    let text = js_trim(&raw_text);
    if shell_like(text) {
        return Some(ProviderNotice::BackgroundCompletion);
    }
    if subagent_like(text) {
        return Some(ProviderNotice::SubagentResult);
    }
    if notification_like(text) {
        return Some(if text.contains("<summary>Agent") {
            ProviderNotice::SubagentResult
        } else {
            ProviderNotice::BackgroundCompletion
        });
    }
    agent_message_body(text).map(|_| ProviderNotice::ParentAgent)
}

/// `nativeSource(item)`: OpenCode's own word for what a synthetic message reports.
fn native_source(item: &Value) -> Option<&str> {
    let first = field_array(item, "raw").first()?;
    if !is(first, "type", "projected.message") {
        return None;
    }
    let metadata = field(field(first, "data")?, "metadata")?;
    field_text(metadata, "source").map(JsString::as_str)
}

/// `textOf(item)`: every text part, joined.
fn text_of(item: &Value) -> String {
    let mut text = String::new();
    for part in field_array(item, "parts") {
        if is(part, "type", "text")
            && let Some(seen) = field_text(part, "text")
        {
            text.push_str(seen.as_str());
        }
    }
    text
}

/// `agentMessageBody(text)`, matching only whether it matched.
fn agent_message_body(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("<agent-message from=\"")?;
    let quote = rest.find('"')?;
    if rest[..quote].contains('\n') {
        return None;
    }
    let after = rest[quote + 1..].strip_prefix('>')?;
    let body = after.strip_suffix("</agent-message>")?;
    let body = body.strip_prefix('\n').unwrap_or(body);
    Some(body.strip_suffix('\n').unwrap_or(body))
}

fn shell_like(text: &str) -> bool {
    wrapped_like(text, "<shell id=\"", "</shell>")
}

fn subagent_like(text: &str) -> bool {
    wrapped_like(text, "<subagent sessionID=\"", "</subagent>")
}

fn notification_like(text: &str) -> bool {
    let Some(body) = text.strip_prefix("<task-notification>") else {
        return false;
    };
    body.ends_with("</task-notification>")
}

/// `^<prefix[^"\n]*"[^>]*>[\s\S]*<suffix>$`.
fn wrapped_like(text: &str, prefix: &str, suffix: &str) -> bool {
    let Some(rest) = text.strip_prefix(prefix) else {
        return false;
    };
    let Some(id_end) = rest.find('"') else {
        return false;
    };
    if rest[..id_end].contains('\n') {
        return false;
    }
    let after = &rest[id_end + 1..];
    let Some(gt) = after.find('>') else {
        return false;
    };
    after[gt + 1..].ends_with(suffix)
}

/// The fields `retry-notice.ts` reads: Codex's `error` frame while it retries.
fn codex_retry(raw: &Value) -> bool {
    if !is(raw, "type", "error") {
        return false;
    }
    let Some(data) = field(raw, "data") else {
        return false;
    };
    if !is(data, "method", "error") {
        return false;
    }
    field(data, "params").is_some_and(|params| field_truth(params, "willRetry"))
}

/// `isProviderRetryNotice(item)`.
pub fn is_provider_retry_notice(item: &Value) -> bool {
    if !is(item, "type", "notice") {
        return false;
    }
    if is(item, "code", "provider.retry") {
        return true;
    }
    field_array(item, "raw").iter().any(codex_retry)
}

/// `isDiagnosticNotice(item)`.
pub fn is_diagnostic_notice(item: &Value) -> bool {
    field_truth(item, "diagnostic")
        || field_array(item, "raw")
            .iter()
            .any(|raw| is(raw, "type", "cursor.sdk.v1"))
}

/// `diagnosticNoticeText(item)`: the user-facing wording for a diagnostic's code.
pub fn diagnostic_notice_text(item: &Value) -> Option<&'static str> {
    let code = match field_text(item, "code") {
        Some(code) => code.as_str(),
        None => {
            let host_exit = field_array(item, "raw")
                .iter()
                .any(|raw| is(raw, "type", "cursor.sdk.v1"));
            let text = field_text(item, "text").map_or("", JsString::as_str);
            if host_exit && text.starts_with("SDK host exited;") {
                "cursor.work-stopped"
            } else {
                return None;
            }
        }
    };
    match code {
        "cursor.work-stopped" => {
            Some("Cursor stopped; some work may not have finished. Send a message to continue.")
        }
        "cursor.run-failed" => Some("Cursor couldn't finish the request. Try again."),
        _ => None,
    }
}

/// `isRawHistoryItem(item)`: bookkeeping and retry notices stay raw history, without a row.
pub fn is_raw_history_item(item: &Value) -> bool {
    let Some(kind) = field_text(item, "type") else {
        return false;
    };
    if kind == "notice" {
        if is_provider_retry_notice(item) {
            return true;
        }
        if is_diagnostic_notice(item) && diagnostic_notice_text(item).is_none() {
            return true;
        }
        if is(item, "code", "history.raw-only") {
            return true;
        }
        let text = field_text(item, "text").map_or("", JsString::as_str);
        if native_history_record(text)
            || text == "Native content block: input_image"
            || text == "Native message"
            || text == "Native reasoning record"
            || native_session_line(text)
        {
            return true;
        }
        return field_array(item, "raw")
            .iter()
            .any(|raw| is(raw, "type", "native-notice") || is(raw, "type", "stderr"));
    }
    kind == "message"
        && field_array(item, "raw").iter().any(|raw| {
            is(raw, "type", "projected.message")
                && field(raw, "data")
                    .and_then(native_message)
                    .is_some_and(|message| message.type_ == Some("system"))
        })
}

fn native_history_record(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("Native history record: ") else {
        return false;
    };
    matches!(
        rest,
        "event_msg" | "turn_context" | "session_meta" | "message" | "world_state"
    )
}

fn native_session_line(text: &str) -> bool {
    matches!(text, "session.permissions" | "session.instructions.updated")
}

/// The optional fields `nativeMessage` reads, once `safeParse` accepts the object.
struct NativeMessage<'a> {
    type_: Option<&'a str>,
    id: Option<&'a str>,
    assistant_message_id: Option<&'a str>,
    ordinal: Option<f64>,
}

/// `nativeMessage.safeParse(data).data`: `None` when the value is not an object, or a known
/// field has the wrong type (unknown fields are stripped, as zod does).
fn native_message(data: &Value) -> Option<NativeMessage<'_>> {
    object(data)?;
    Some(NativeMessage {
        type_: optional_str(data, "type")?,
        id: optional_str(data, "id")?,
        assistant_message_id: optional_str(data, "assistantMessageID")?,
        ordinal: optional_number(data, "ordinal")?,
    })
}

fn optional_str<'a>(value: &'a Value, key: &str) -> Option<Option<&'a str>> {
    match field(value, key) {
        None => Some(None),
        Some(seen) => string(seen).map(|text| Some(text.as_str())),
    }
}

fn optional_number(value: &Value, key: &str) -> Option<Option<f64>> {
    match field(value, key) {
        None => Some(None),
        Some(seen) => number(seen).map(Some),
    }
}

/// `historyMessageIdentity(item)`: native identity, never prose.
pub fn history_message_identity(item: &Value) -> Option<String> {
    if !is(item, "type", "message") {
        return None;
    }
    let agent = field_text(item, "agentId").map_or("", JsString::as_str);
    if let Some(command) = field(item, "origin").and_then(|origin| field_text(origin, "commandId"))
    {
        return Some(format!("{agent}:input:{}", command.as_str()));
    }
    if let Some(native) = field_text(item, "nativeId") {
        let role = field_text(item, "role").map_or("", JsString::as_str);
        return Some(format!("{agent}:{role}:{}", native.as_str()));
    }
    let role = field_text(item, "role").map_or("", JsString::as_str);
    for raw in field_array(item, "raw") {
        let Some(data) = field(raw, "data") else {
            continue;
        };
        let Some(message) = native_message(data) else {
            continue;
        };
        if is(raw, "type", "projected.message")
            && let Some(id) = message.id
        {
            return Some(if role == "assistant" {
                format!("{agent}:assistant:{id}:0")
            } else {
                format!("{agent}:{role}:{id}")
            });
        }
        if let (Some(assistant), Some(ordinal)) = (message.assistant_message_id, message.ordinal) {
            let mut printed = String::new();
            ace_json::write_number(&mut printed, ordinal);
            return Some(format!("{agent}:assistant:{assistant}:{printed}"));
        }
    }
    None
}

/// `messageRawRead(item)`: whether a reader of what a message is would answer differently
/// without its raw payloads.
fn message_raw_read(item: &Value) -> bool {
    if field_array(item, "raw").is_empty() {
        return false;
    }
    let mut bare = object(item).cloned().unwrap_or_else(Map::new);
    bare.insert("raw", Value::Array(Array::new()));
    let bare = Value::Object(bare);
    is_raw_history_item(item) != is_raw_history_item(&bare)
        || history_message_identity(item) != history_message_identity(&bare)
        || provider_notice(item) != provider_notice(&bare)
}

/// `rawShownOnly(item)`: clients only ever show this item's raw payloads.
pub fn raw_shown_only(item: &Value) -> bool {
    let Some(kind) = field_text(item, "type").map(JsString::as_str) else {
        return false;
    };
    match kind {
        "notice" | "artifact" => false,
        "message" => !message_raw_read(item),
        "tool_call" => {
            let Some(call) = field(item, "call") else {
                return false;
            };
            let custom = is(call, "kind", "custom");
            let detail = field(call, "detail")
                .and_then(|detail| field_text(detail, "kind"))
                .map(JsString::as_str);
            !custom && detail != Some("mcp") && detail != Some("custom")
        }
        _ => true,
    }
}

/// `omitRaw(item)`: the item without raw payloads clients only show, marked `rawOmitted`,
/// or `None` when it changes nothing.
pub fn omit_raw(item: &Value) -> Option<Value> {
    if !raw_shown_only(item) {
        return None;
    }
    if is(item, "type", "tool_call") {
        let call = field(item, "call")?;
        if field_array(call, "raw").is_empty() {
            return None;
        }
        let mut item = object(item)?.clone();
        let mut call = object(call)?.clone();
        call.insert("raw", Value::Array(Array::new()));
        // `{ ...item, rawOmitted: true, call: { ...call, raw: [] } }`: `call` keeps its place,
        // `rawOmitted` is appended.
        item.insert("rawOmitted", Value::Bool(true));
        item.insert("call", Value::Object(call));
        return Some(Value::Object(item));
    }
    if field_array(item, "raw").is_empty() {
        return None;
    }
    let mut item = object(item)?.clone();
    item.insert("raw", Value::Array(Array::new()));
    item.insert("rawOmitted", Value::Bool(true));
    Some(Value::Object(item))
}
