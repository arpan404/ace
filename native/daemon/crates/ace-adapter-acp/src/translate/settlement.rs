// SPDX-License-Identifier: Apache-2.0
//! Terminal reasons and shell survival (`settlement.ts`).

use crate::translate::data::object;
use ace_json::Value;

const STOP_REASONS: &[&str] = &[
    "end_turn",
    "cancelled",
    "max_tokens",
    "max_turn_requests",
    "refusal",
];

fn is_stop_reason(reason: &str) -> bool {
    STOP_REASONS.contains(&reason)
}

/// Both translation and I/O require a concrete terminal reason.
pub fn prompt_stop(result: &Value) -> Option<String> {
    let reason = object(result).get("stopReason").and_then(Value::as_str)?;
    if is_stop_reason(reason) {
        Some(reason.to_owned())
    } else {
        None
    }
}

/// How a session/prompt reply ended its prompt.
pub fn prompt_end(message: &Value) -> Option<(String, bool)> {
    let map = message.as_object()?;
    if map.contains_key("error") {
        return Some((String::new(), true));
    }
    let result = object(map.get("result").unwrap_or(&Value::Null));
    let reason = result.get("stopReason").and_then(Value::as_str)?;
    if reason.is_empty() {
        return None;
    }
    Some((reason.to_owned(), is_stop_reason(reason)))
}

pub const CANCELLATION_GRACE_MS: i64 = 12_000;

pub fn cancellation_deadline(now: i64) -> i64 {
    now.saturating_add(CANCELLATION_GRACE_MS)
}

/// Whether a shell tool may outlive the prompt that ended with `reason`.
pub fn shell_survives_prompt(provider: &str, reason: &str, status: &str) -> bool {
    if status != "running" || !is_stop_reason(reason) {
        return false;
    }
    reason == "cancelled" || provider == "antigravity"
}

/// Whether a surviving shell stays open across turns.
pub fn shell_carried_across_turns(provider: &str, reason: &str, status: &str) -> bool {
    provider == "antigravity"
        && reason != "cancelled"
        && shell_survives_prompt(provider, reason, status)
}

/// Whether answering a tool's request refuses the tool.
pub fn answer_refuses_tool(
    request_kind: &str,
    request_options: &[Value],
    resolution: Option<&Value>,
    cancelled: bool,
) -> bool {
    if cancelled {
        return true;
    }
    let Some(resolution) = resolution else {
        return false;
    };
    let resolution_obj = object(resolution);
    let kind = resolution_obj
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("");
    if kind == "plan_review" {
        return resolution_obj
            .get("decision")
            .and_then(Value::as_str)
            .is_some_and(|decision| decision == "reject");
    }
    if kind != "approval" || request_kind != "approval" {
        return false;
    }
    let option_id = resolution_obj
        .get("optionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    request_options.iter().any(|option| {
        let option_map = object(option);
        let id = option_map.get("id").and_then(Value::as_str).unwrap_or("");
        let option_kind = option_map.get("kind").and_then(Value::as_str).unwrap_or("");
        id == option_id && (option_kind == "deny" || option_kind == "deny_always")
    })
}

/// Whether an answer picked a neutral native choice.
pub fn answer_is_neutral(
    request_kind: &str,
    request_options: &[Value],
    resolution: Option<&Value>,
) -> bool {
    let Some(resolution) = resolution else {
        return false;
    };
    let resolution_obj = object(resolution);
    if resolution_obj
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        != "approval"
        || request_kind != "approval"
    {
        return false;
    }
    let option_id = resolution_obj
        .get("optionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    request_options.iter().any(|option| {
        let option_map = object(option);
        option_map
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id == option_id)
            && option_map
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "other")
    })
}
