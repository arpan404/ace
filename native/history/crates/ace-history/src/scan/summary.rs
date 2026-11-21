// SPDX-License-Identifier: Apache-2.0

//! `summary` (`packages/history-import/src/metadata.ts`): a session's catalog row from the
//! records sampled out of its transcript.

use std::path::Path;

use history_text::{js, session_title};
use serde_json::Value;

use super::user::user_prompt;
use crate::json::{field, is_true, object, present, string, timestamp};
use crate::options::{Home, Provider};
use crate::paths::{basename, text};
use crate::session::{Accuracy, Session, Support, source_id};

fn is_uuid(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// A Codex `session_meta` record that `CodexSessionMeta` accepts.
pub struct CodexMeta<'a> {
    pub payload: &'a serde_json::Map<String, Value>,
    pub id: &'a str,
}

/// `CodexSessionMeta.safeParse(r).data`.
pub fn codex_meta(r: &Value) -> Option<CodexMeta<'_>> {
    let r = r.as_object()?;
    if r.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = r.get("payload")?.as_object()?;
    let id = payload.get("id")?.as_str().filter(|id| is_uuid(id))?;
    let uuid_or = |key: &str, nullable: bool| match payload.get(key) {
        None => true,
        Some(Value::Null) => nullable,
        Some(Value::String(s)) => is_uuid(s),
        Some(_) => false,
    };
    let string_or_absent = |key: &str| matches!(payload.get(key), None | Some(Value::String(_)));
    let ok = uuid_or("session_id", false)
        && uuid_or("forked_from_id", true)
        && uuid_or("parent_thread_id", true)
        && string_or_absent("cwd")
        && string_or_absent("history_mode");
    ok.then_some(CodexMeta { payload, id })
}

/// `ClaudeSessionMeta.safeParse(r).data?.sessionId`.
pub fn claude_session_id(r: &Value) -> Option<&str> {
    let r = r.as_object()?;
    let kind = r.get("type")?.as_str()?;
    if !matches!(kind, "user" | "assistant" | "system") {
        return None;
    }
    r.get("sessionId")?
        .as_str()
        .filter(|id| !id.is_empty() && js::length(id) <= 1024)
}

/// `claudeSidechainParent`: a transcript under `<session>/subagents/` belongs to `<session>`.
pub fn claude_sidechain_parent(path: &Path) -> Option<String> {
    let parent = path.parent()?;
    if parent.file_name()? != "subagents" {
        return None;
    }
    Some(basename(parent.parent()?, ""))
}

fn spawned_elsewhere(payload: &serde_json::Map<String, Value>) -> bool {
    let source = field(payload, "source");
    let spawned = object(field(object(source), "subagent"));
    !spawned.is_empty()
        || matches!(source.as_str(), Some("exec" | "mcp"))
        || !object(field(object(source), "internal")).is_empty()
        || matches!(
            field(payload, "thread_source").as_str(),
            Some("subagent" | "guardian_review" | "memory_consolidation")
        )
}

/// `[1, 2, 3].includes(Number(version ?? 1))`: the Pi session formats this reader opens.
fn pi_version(version: Option<&Value>) -> bool {
    let number = match version {
        None | Some(Value::Null) => Some(1.0),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => js_to_number(s),
        // `Number([x])` is `Number(String(x))`; any other array or object is NaN or 0.
        Some(Value::Array(items)) => match items.as_slice() {
            [Value::String(s)] => js_to_number(s),
            [Value::Number(n)] => n.as_f64(),
            [Value::Bool(_)] => None,
            _ => None,
        },
        Some(Value::Object(_)) => None,
    };
    number.is_some_and(|n| n == 1.0 || n == 2.0 || n == 3.0)
}

/// `Number(text)` for the values that can equal a small integer: decimal, signed, exponent or
/// hex, surrounded by whitespace.
fn js_to_number(text: &str) -> Option<f64> {
    let text = js::trim(text);
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    let valid = !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'));
    if valid { text.parse().ok() } else { None }
}

/// The catalog summary of one transcript, from its sampled records.
pub fn summary(
    home: &Home,
    path: &Path,
    records: &[Value],
    exact: bool,
    mtime: i64,
    first_prompt: Option<&str>,
) -> Session {
    let mut native_id = basename(path, ".jsonl");
    let mut cwd = String::new();
    let mut title = String::new();
    let mut prompt = first_prompt.unwrap_or("").to_owned();
    let mut model: Option<String> = None;
    let mut parent: Option<String> = None;
    let mut count = 0;
    let mut last_activity = mtime;
    let mut reason: Option<String> = None;
    let mut codex_meta_seen = false;
    for value in records {
        let r = object(value);
        let payload = object(field(r, "payload"));
        let message = object(field(r, "message"));
        if let Some(found) = string(r, "cwd")
            .or_else(|| string(payload, "cwd"))
            .or_else(|| string(r, "directory"))
        {
            cwd = found.to_owned();
        }
        if let Some(found) = string(message, "model")
            .or_else(|| string(r, "model"))
            .or_else(|| string(payload, "model"))
        {
            model = Some(found.to_owned());
        }
        match home.provider {
            Provider::Codex => {
                if let Some(meta) = codex_meta(value) {
                    codex_meta_seen = true;
                    native_id = meta.id.to_owned();
                    let spawn = object(field(
                        object(field(object(field(meta.payload, "source")), "subagent")),
                        "thread_spawn",
                    ));
                    parent = string(meta.payload, "parent_thread_id")
                        .or_else(|| string(spawn, "parent_thread_id"))
                        .map(str::to_owned);
                    if spawned_elsewhere(meta.payload) {
                        parent.get_or_insert_with(|| "non-interactive".to_owned());
                    }
                    let mode = string(meta.payload, "history_mode").unwrap_or("");
                    let base = present(meta.payload.get("history_base"));
                    if (!mode.is_empty() && !matches!(mode, "legacy" | "paginated"))
                        || base.is_some()
                    {
                        reason = Some(
                            "This session refers to history in another file. Export it from Codex to open the complete conversation."
                                .to_owned(),
                        );
                    }
                }
            }
            Provider::Claude => {
                if let Some(id) = claude_session_id(value) {
                    native_id = id.to_owned();
                }
                if is_true(r, "isSidechain") {
                    parent.get_or_insert_with(|| "sidechain".to_owned());
                }
            }
            Provider::Pi => {
                let kind = field(r, "type").as_str();
                if kind == Some("session") {
                    if let Some(id) = string(r, "id") {
                        native_id = id.to_owned();
                    }
                    if !pi_version(r.get("version")) {
                        reason = Some(
                            "This Pi history format cannot be opened. Update ace and try again."
                                .to_owned(),
                        );
                    }
                }
                if kind == Some("session_info")
                    && let Some(name) = string(r, "name")
                {
                    title = name.to_owned();
                }
                if kind == Some("model_change")
                    && let Some(id) = string(r, "modelId")
                {
                    model = Some(id.to_owned());
                }
                if kind == Some("message")
                    && matches!(field(message, "role").as_str(), Some("user" | "assistant"))
                {
                    count += 1;
                }
            }
            _ => {}
        }
        let kind = field(r, "type").as_str();
        if kind == Some("ai-title")
            && let Some(found) = string(r, "aiTitle").or_else(|| string(r, "title"))
        {
            title = found.to_owned();
        }
        if let Some(custom) = string(r, "customTitle") {
            title = custom.to_owned();
        }
        if kind == Some("summary")
            && let Some(found) = string(r, "summary")
        {
            title = found.to_owned();
        }
        if kind == Some("response_item")
            && field(payload, "type").as_str() == Some("message")
            && matches!(field(payload, "role").as_str(), Some("user" | "assistant"))
        {
            count += 1;
        }
        if matches!(kind, Some("user" | "assistant")) {
            count += 1;
        }
        if first_prompt.is_none() && prompt.is_empty() {
            prompt = user_prompt(value);
        }
        last_activity = last_activity.max(timestamp(field(r, "timestamp")).unwrap_or(0));
    }
    if home.provider == Provider::Codex && !codex_meta_seen {
        reason = Some("Unrecognized Codex rollout metadata".to_owned());
    }
    if cwd.is_empty() {
        reason.get_or_insert_with(|| {
            "Workspace metadata was not available in the bounded sample".to_owned()
        });
    }
    if home.provider == Provider::Claude
        && let Some(sidechain) = claude_sidechain_parent(path)
    {
        native_id = basename(path, ".jsonl");
        parent = Some(sidechain);
    }
    let shown = if title == native_id { "" } else { &title };
    Session {
        id: source_id(&home.id, &text(path), &native_id),
        instance_id: home.id.clone(),
        provider: home.provider.as_str().to_owned(),
        title: session_title(shown, &prompt, last_activity),
        native_id,
        cwd,
        model: model.map(|m| js::prefix(&m, 512).to_owned()),
        last_activity,
        message_count: count,
        count_accuracy: if exact {
            Accuracy::Exact
        } else {
            Accuracy::Sampled
        },
        parent_native_id: parent,
        continuation: None,
        support: reason.map_or(Support::Supported, Support::unsupported),
    }
}
