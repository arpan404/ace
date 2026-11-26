// SPDX-License-Identifier: Apache-2.0
//! Answers to the CLI's own control requests, and the host shapes of its three callback-style
//! requests (claude-session.md section 2's mapping). Absent wire fields stay absent; nothing else
//! is added. A mapped field is copied out of the request because the raw `wire` frame is written
//! from the same tree; the received line itself is never cloned (only `classify` moves it).

use ace_json::{Map, Value};

/// The success answer to a control request: `{type, response: {subtype, request_id, response}}`.
pub fn success(request_id: &str, response: Value) -> Value {
    envelope(request_id, "success", ("response", response))
}

/// The error answer: `{type, response: {subtype, request_id, error}}`. An unknown
/// `control_request` subtype is answered with it and kept as a `wire` frame (Q10).
pub fn error(request_id: &str, message: &str) -> Value {
    envelope(request_id, "error", ("error", Value::from(message)))
}

/// The Q10 answer to a `control_request` subtype this crate does not know.
pub fn unsupported(request_id: &str, subtype: &str) -> Value {
    error(
        request_id,
        &format!("Unsupported control request: {subtype}"),
    )
}

fn envelope(request_id: &str, subtype: &str, field: (&str, Value)) -> Value {
    let mut inner = Map::with_capacity(3);
    inner.insert("subtype", Value::from(subtype));
    inner.insert("request_id", Value::from(request_id));
    inner.insert(field.0, field.1);
    let mut outer = Map::with_capacity(2);
    outer.insert("type", Value::from("control_response"));
    outer.insert("response", Value::Object(inner));
    Value::Object(outer)
}

/// A `can_use_tool` request's fields as `CanUseTool`'s `options`, in the `[d.ts]` order, with
/// `requestId` from the envelope. `input`, `toolName` and the signal stay out (the frame carries
/// them separately).
pub fn permission_options(request: &Map, request_id: &str) -> Map {
    let mut options = Map::with_capacity(13);
    copy(
        request,
        &mut options,
        "permission_suggestions",
        "suggestions",
    );
    copy(request, &mut options, "blocked_path", "blockedPath");
    copy(request, &mut options, "mcp_server", "mcpServer");
    copy(request, &mut options, "decision_reason", "decisionReason");
    copy(request, &mut options, "title", "title");
    copy(request, &mut options, "display_name", "displayName");
    copy(request, &mut options, "description", "description");
    copy(request, &mut options, "default_to_no", "defaultToNo");
    copy(
        request,
        &mut options,
        "suppress_always_allow_rule",
        "suppressAlwaysAllowRule",
    );
    copy(request, &mut options, "tool_use_id", "toolUseID");
    copy(request, &mut options, "agent_id", "agentID");
    options.insert("requestId", Value::from(request_id));
    if let Some(rule) = request.get("matched_ask_rule") {
        options.insert("matchedAskRule", ask_rule(rule));
    }
    options
}

/// `matched_ask_rule` with its own snake_case names renamed, in `[d.ts]` order. A value that is
/// not an object is kept as it came, never dropped.
fn ask_rule(rule: &Value) -> Value {
    let Some(raw) = rule.as_object() else {
        return rule.clone();
    };
    let mut map = Map::with_capacity(3);
    copy(raw, &mut map, "source", "source");
    copy(raw, &mut map, "tool_name", "toolName");
    copy(raw, &mut map, "rule_content", "ruleContent");
    Value::Object(map)
}

/// An `elicitation` request as the `ElicitationRequest` the host callback receives, in the
/// `[d.ts]` order (the frame's `native` field).
pub fn elicitation_request(request: &Map) -> Map {
    let mut out = Map::with_capacity(9);
    copy(request, &mut out, "mcp_server_name", "serverName");
    copy(request, &mut out, "message", "message");
    copy(request, &mut out, "mode", "mode");
    copy(request, &mut out, "url", "url");
    copy(request, &mut out, "elicitation_id", "elicitationId");
    copy(request, &mut out, "requested_schema", "requestedSchema");
    copy(request, &mut out, "title", "title");
    copy(request, &mut out, "display_name", "displayName");
    copy(request, &mut out, "description", "description");
    out
}

/// A `request_user_dialog` request as the `UserDialogRequest` the frame and callback carry.
pub fn user_dialog_request(request: &Map) -> Map {
    let mut out = Map::with_capacity(3);
    copy(request, &mut out, "dialog_kind", "dialogKind");
    copy(request, &mut out, "payload", "payload");
    copy(request, &mut out, "tool_use_id", "toolUseID");
    out
}

/// Move one field across under its new name; an absent one stays absent.
fn copy(from: &Map, to: &mut Map, from_key: &str, to_key: &str) {
    // This runs once per interaction, never per line, so the copy costs nothing on the hot path.
    if let Some(value) = from.get(from_key) {
        to.insert(to_key, value.clone());
    }
}
