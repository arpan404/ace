// SPDX-License-Identifier: Apache-2.0
//! The requests the commands push: a turn's params, a steer, and the identity
//! callback that precedes them.

use ace_adapter_api::session::InputSource;
use ace_json::{Map, Value};

use super::{EXPECTED_ACTIVE, NO_ACTIVE_TURN};
use crate::session::frames::Effect;
use crate::session::input::native_input;

/// `startTurn`'s params when no turn is running: ace's own input carries no
/// parts, and its text rides along as delegation context.
pub(super) fn start_params(
    parts: &[Value],
    origin: Option<InputSource>,
    client_user_message_id: Option<String>,
) -> Result<Map, String> {
    let mut params = Map::new();
    if origin == Some(InputSource::Ace) {
        params.insert("input", Value::Array(Vec::new().into()));
        params.insert("turnTrigger", Value::from("subagent_result"));
        let text = parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect::<Vec<String>>()
            .join("\n");
        let mut delegation = Map::new();
        delegation.insert("kind", Value::from("untrusted"));
        delegation.insert("value", Value::from(text));
        let mut context = Map::new();
        context.insert("ace.delegation", Value::Object(delegation));
        params.insert("additionalContext", Value::Object(context));
    } else {
        params.insert("input", native_input(parts)?);
    }
    if let Some(id) = client_user_message_id {
        params.insert("clientUserMessageId", Value::from(id));
    }
    Ok(params)
}

/// One `turn/steer`, interactive: no deadline of its own.
pub(super) fn steer_request(
    call: u64,
    thread: &str,
    turn: &str,
    input: &Value,
    client_user_message_id: Option<&str>,
) -> Effect {
    let mut params = Map::new();
    params.insert("threadId", Value::from(thread.to_owned()));
    params.insert("expectedTurnId", Value::from(turn.to_owned()));
    params.insert("input", input.clone());
    if let Some(id) = client_user_message_id {
        params.insert("clientUserMessageId", Value::from(id.to_owned()));
    }
    Effect::Request {
        call,
        method: "turn/steer".to_owned(),
        params: Value::Object(params),
        timeout_ms: None,
    }
}

/// The identity a command and its native message share, queued as a callback.
pub(super) fn on_input_message(command_id: &str, native_id: &str) -> Effect {
    let mut message = Map::new();
    message.insert("commandId", Value::from(command_id.to_owned()));
    message.insert("nativeId", Value::from(native_id.to_owned()));
    Effect::Callback {
        name: "onInputMessage",
        json: Value::Array(vec![Value::Object(message)].into()).to_json(),
    }
}

/// `SteerErrorReply`: a `{ message }` object parsed out of an error's text.
pub(super) fn reply_message(message: &str) -> Option<String> {
    let value = ace_json::parse(message).ok()?;
    value
        .get("message")?
        .as_str()
        .map(|message| message.to_owned())
}

/// `/^(?:no active turn to steer|expected active turn id .+ but found .+)$/i`.
pub(super) fn steer_target_lost_text(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    if lower == NO_ACTIVE_TURN {
        return true;
    }
    // JS's `.` matches no line terminator: `\n`, `\r`, `\u{2028}`, `\u{2029}`.
    if message
        .chars()
        .any(|ch| matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
    {
        return false;
    }
    let Some(rest) = lower.strip_prefix(EXPECTED_ACTIVE) else {
        return false;
    };
    let Some((expected, found)) = rest.split_once(" but found ") else {
        return false;
    };
    !expected.is_empty() && !found.is_empty()
}

/// `/^expected active turn id /i`.
pub(super) fn expected_active_text(message: &str) -> bool {
    message.to_ascii_lowercase().starts_with(EXPECTED_ACTIVE)
}
