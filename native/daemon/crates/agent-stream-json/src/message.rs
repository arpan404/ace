// SPDX-License-Identifier: Apache-2.0
//! One received `stdout` line, classified once. The caller parses the line (the one parse) and
//! hands the tree here; classification reads `type`, `request_id` and `request.subtype`, then
//! moves the tree into the line. It never fails and never clones.

use ace_json::Value;

/// A received line, already parsed, in the shape the session needs next.
#[derive(Debug, PartialEq)]
pub enum Line {
    /// One of the eleven message types of claude-session.md section 2. `value` is the line, moved.
    Message { kind: MessageKind, value: Value },
    /// A request the CLI asks the host to answer.
    HostRequest {
        request_id: String,
        request: HostRequest,
        value: Value,
    },
    /// The answer to a control request this side sent.
    ControlResponse {
        request_id: String,
        outcome: Outcome,
        value: Value,
    },
    /// A `control_cancel_request`: the pending interaction with this id is cancelled.
    Cancel { request_id: String, value: Value },
    /// A string `type` this crate does not know, or none: kept whole, never an error.
    Unknown { value: Value },
}

/// The eleven `stdout` message types the engine reads as a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    System,
    Assistant,
    User,
    Result,
    StreamEvent,
    RateLimitEvent,
    KeepAlive,
    ToolProgress,
    ToolUseSummary,
    AuthStatus,
    PromptSuggestion,
}

/// What the CLI asks of the host inside a `control_request`.
#[derive(Debug, PartialEq, Eq)]
pub enum HostRequest {
    CanUseTool,
    Elicitation,
    UserDialog,
    HookCallback {
        callback_id: String,
    },
    /// A `control_request` subtype this crate does not know: answered with an error and kept as a
    /// `wire` frame, never fatal (Q10).
    Other {
        subtype: String,
    },
}

/// What a `control_response` says.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Success,
    Error(String),
}

/// What a line is, from its `type`. Every input yields a [`Line`]: a non-object, a missing or
/// non-string `type`, and an unknown `type` are [`Line::Unknown`].
pub fn classify(value: Value) -> Line {
    let tag = match value.get("type").and_then(Value::as_str) {
        Some("system") => Tag::Message(MessageKind::System),
        Some("assistant") => Tag::Message(MessageKind::Assistant),
        Some("user") => Tag::Message(MessageKind::User),
        Some("result") => Tag::Message(MessageKind::Result),
        Some("stream_event") => Tag::Message(MessageKind::StreamEvent),
        Some("rate_limit_event") => Tag::Message(MessageKind::RateLimitEvent),
        Some("keep_alive") => Tag::Message(MessageKind::KeepAlive),
        Some("tool_progress") => Tag::Message(MessageKind::ToolProgress),
        Some("tool_use_summary") => Tag::Message(MessageKind::ToolUseSummary),
        Some("auth_status") => Tag::Message(MessageKind::AuthStatus),
        Some("prompt_suggestion") => Tag::Message(MessageKind::PromptSuggestion),
        Some("control_request") => Tag::HostRequest,
        Some("control_response") => Tag::ControlResponse,
        Some("control_cancel_request") => Tag::Cancel,
        _ => Tag::Unknown,
    };
    match tag {
        Tag::Message(kind) => Line::Message { kind, value },
        Tag::HostRequest => host_request(value),
        Tag::ControlResponse => control_response(value),
        Tag::Cancel => Line::Cancel {
            request_id: text(&value, "request_id"),
            value,
        },
        Tag::Unknown => Line::Unknown { value },
    }
}

/// The decision, copied out of the tree so the tree itself can then be moved.
enum Tag {
    Message(MessageKind),
    HostRequest,
    ControlResponse,
    Cancel,
    Unknown,
}

fn host_request(value: Value) -> Line {
    let request_id = text(&value, "request_id");
    let inner = value.get("request");
    let subtype = inner.map_or_else(String::new, |request| text(request, "subtype"));
    let request = if subtype == "can_use_tool" {
        HostRequest::CanUseTool
    } else if subtype == "elicitation" {
        HostRequest::Elicitation
    } else if subtype == "request_user_dialog" {
        HostRequest::UserDialog
    } else if subtype == "hook_callback" {
        HostRequest::HookCallback {
            callback_id: inner.map_or_else(String::new, |request| text(request, "callback_id")),
        }
    } else {
        HostRequest::Other { subtype }
    };
    Line::HostRequest {
        request_id,
        request,
        value,
    }
}

fn control_response(value: Value) -> Line {
    let response = value.get("response");
    let request_id = response.map_or_else(String::new, |response| text(response, "request_id"));
    // Any non-success subtype settles as an error: the .d.ts union has only success and error.
    let success = response
        .and_then(|response| response.get("subtype"))
        .and_then(Value::as_str)
        == Some("success");
    let outcome = if success {
        Outcome::Success
    } else {
        Outcome::Error(response.map_or_else(String::new, |response| text(response, "error")))
    };
    Line::ControlResponse {
        request_id,
        outcome,
        value,
    }
}

/// A string field, or `""` when it is missing or not a string (the session skips it, as
/// `string()` returning `""` does today).
fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
