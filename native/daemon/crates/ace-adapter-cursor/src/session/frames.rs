// SPDX-License-Identifier: Apache-2.0
//! The frames the session builds and the replies it reads (`session.ts:58`-`:83`, `:105`-`:139`,
//! `:31`-`:41`). A built frame is the envelope in the literal's key order, through the same bound
//! walk the host's values take, and it crosses with `channel: "sdk"`.
//!
//! `unexpectedStopMessage` keeps rule 17's arithmetic: `.slice(0, 300)` counts UTF-16 units, so a
//! detail cut through a surrogate pair keeps the lone surrogate, exactly as JavaScript does.

use ace_json::{JsString, Map, Value};

use super::bounded::{DEFAULT_MAX_BYTES, bounded_json};
use super::error::SessionError;

/// The channel every Cursor frame crosses on (`session.ts:79`).
pub const CHANNEL: &str = "sdk";
/// The comment the host-output note carries (`session.ts:60`).
pub const KIND_CANCEL: &str = "cancel";
pub const KIND_HOST_EXIT: &str = "host-exit";
pub const KIND_HOST_OUTPUT: &str = "host-output";
pub const KIND_SNAPSHOT: &str = "snapshot";
/// `unexpectedStopMessage`'s cutoff (`session.ts:38`).
const STOP_DETAIL_UNITS: usize = 300;
const STOP_PREFIX: &str = "Cursor stopped unexpectedly: ";
const STOP_SUFFIX: &str = ". Unfinished work needs your attention.";
const STOP_FALLBACK: &str = "Cursor stopped unexpectedly. Unfinished work needs your attention.";

/// One frame the session builds: the envelope in `session.ts:66`-`:73`'s order.
pub fn session_frame(
    generation: &str,
    operation: &str,
    segment: f64,
    kind: &str,
    body: &Value,
) -> Result<String, SessionError> {
    let mut envelope = Map::with_capacity(6);
    envelope.insert("schemaVersion", Value::from(1));
    envelope.insert("generation", Value::from(generation));
    envelope.insert("operationId", Value::from(operation));
    envelope.insert("segment", Value::from(segment));
    envelope.insert("kind", Value::from(kind));
    envelope.insert("body", body.clone());
    bounded_json(&Value::Object(envelope), DEFAULT_MAX_BYTES).map_err(SessionError::Bound)
}

/// `unexpectedStopMessage` (`session.ts:31`-`:41`): whitespace collapsed, a trailing run of dots
/// and spaces dropped, then at most 300 UTF-16 units before an ellipsis.
pub fn unexpected_stop_message(detail: Option<&str>) -> JsString {
    let reason = detail.map(collapse_stop_detail).unwrap_or_default();
    if reason.is_empty() {
        return JsString::from(STOP_FALLBACK);
    }
    let units: Vec<u16> = reason.encode_utf16().collect();
    if units.len() <= STOP_DETAIL_UNITS {
        let mut message = String::from(STOP_PREFIX);
        message.push_str(&reason);
        message.push_str(STOP_SUFFIX);
        return JsString::from(message.as_str());
    }
    let mut message: Vec<u16> = STOP_PREFIX.encode_utf16().collect();
    message.extend_from_slice(&units[..STOP_DETAIL_UNITS]);
    message.extend("…".encode_utf16());
    message.extend(STOP_SUFFIX.encode_utf16());
    JsString::from_units(&message)
}

fn collapse_stop_detail(detail: &str) -> String {
    let mut collapsed = String::with_capacity(detail.len());
    let mut space = false;
    for character in detail.chars() {
        if is_js_space(character) {
            if !space {
                collapsed.push(' ');
                space = true;
            }
        } else {
            collapsed.push(character);
            space = false;
        }
    }
    collapsed
        .trim_matches(is_js_space)
        .trim_end_matches(|character| character == '.' || is_js_space(character))
        .to_owned()
}

/// `\s` in JavaScript: WhiteSpace and LineTerminator, which is not Rust's `is_whitespace` (NEL is
/// not one, U+FEFF is).
pub(crate) fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// The `host-exit` note's body (`session.ts:164`-`:170`), in the literal's key order.
pub fn host_exit_body(
    deliberate: bool,
    code: Option<i64>,
    signal: Option<&str>,
    reason: &str,
    detail: Option<&str>,
) -> Value {
    let mut body = Map::with_capacity(5);
    body.insert("deliberate", Value::Bool(deliberate));
    body.insert("code", code.map_or(Value::Null, Value::from));
    body.insert("signal", signal.map_or(Value::Null, Value::from));
    body.insert("reason", Value::from(reason));
    if let Some(detail) = detail {
        body.insert("detail", Value::from(detail));
    }
    Value::Object(body)
}

/// `onExit`'s argument (`session.ts:174`-`:177`): the message only when the stop was not asked for.
pub fn exit_args(deliberate: bool, stop_cause: Option<&str>) -> String {
    let mut args = Map::with_capacity(2);
    args.insert("deliberate", Value::Bool(deliberate));
    if !deliberate {
        args.insert(
            "message",
            Value::String(unexpected_stop_message(stop_cause)),
        );
    }
    format!("[{}]", Value::Object(args).to_json())
}

/// `onSessionIdentity`'s argument (`session.ts:113`-`:117`), in the literal's key order.
pub fn identity_args(instance_id: &str, native_session_id: &JsString) -> String {
    let mut identity = Map::with_capacity(3);
    identity.insert("backend", Value::from("cursor-sdk"));
    identity.insert("instanceId", Value::from(instance_id));
    identity.insert("nativeSessionId", Value::String(native_session_id.clone()));
    format!("[{}]", Value::Object(identity).to_json())
}

/// `onInputMessage`'s argument (`session.ts:266`), in the literal's key order.
pub fn input_message_args(command_id: &str) -> String {
    let mut identity = Map::with_capacity(2);
    identity.insert("commandId", Value::from(command_id));
    identity.insert("nativeId", Value::from(command_id));
    format!("[{}]", Value::Object(identity).to_json())
}

/// `OpenReply.safeParse`: the agent id the host opened with (`session.ts:259`, `:32`).
pub fn open_agent_id(reply: &Value) -> Result<JsString, SessionError> {
    match reply.get("agentId") {
        Some(Value::String(agent_id)) if !agent_id.is_empty() && code_points(agent_id) <= 512 => {
            Ok(agent_id.clone())
        }
        _ => Err(SessionError::Envelope("open reply has no agentId")),
    }
}

/// `SandboxSupport.safeParse`'s success and value (`session.ts:33`, `:107`-`:110`).
pub fn sandbox_supported(body: &Value) -> bool {
    matches!(body.get("sandboxSupported"), Some(Value::Bool(true)))
}

/// `SettledError.safeParse` (`session.ts:44`): an error frame that ends the turn.
pub fn settled_error(body: &Value) -> bool {
    matches!(body.get("settled"), Some(Value::Bool(true)))
}

/// `ResultStatus.safeParse`'s status (`session.ts:35`, `:123`): one of the settled three.
pub fn result_status(body: &Value) -> Option<&str> {
    match body.get("status") {
        Some(Value::String(status)) => Some(status.as_str()),
        _ => None,
    }
}

/// JavaScript's character count, as the envelope's zod bounds use it.
fn code_points(text: &JsString) -> usize {
    let mut count = 0;
    let mut high = false;
    for unit in text.units() {
        if high && (0xdc00..0xe000).contains(&unit) {
            high = false;
            continue;
        }
        high = (0xd800..0xdc00).contains(&unit);
        count += 1;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::{
        exit_args, host_exit_body, identity_args, result_status, sandbox_supported, session_frame,
        settled_error, unexpected_stop_message,
    };
    use ace_json::{Value, json};

    #[test]
    fn a_built_frame_is_the_envelope_in_the_literals_key_order() {
        let text = session_frame("g", "op", 2.0, "cancel", &json!({"replacement": true}))
            .expect("a frame");
        assert_eq!(
            text,
            r#"{"schemaVersion":1,"generation":"g","operationId":"op","segment":2,"kind":"cancel","body":{"replacement":true}}"#
        );
    }

    #[test]
    fn a_stop_detail_collapses_whitespace_and_drops_a_trailing_dot_run() {
        assert_eq!(
            unexpected_stop_message(Some("  host\t died \n\n twice. .  ")).as_str(),
            "Cursor stopped unexpectedly: host died twice. Unfinished work needs your attention."
        );
        assert_eq!(
            unexpected_stop_message(None).as_str(),
            "Cursor stopped unexpectedly. Unfinished work needs your attention."
        );
        assert_eq!(
            unexpected_stop_message(Some("   \n ")).as_str(),
            "Cursor stopped unexpectedly. Unfinished work needs your attention."
        );
    }

    #[test]
    fn the_stop_detail_is_cut_at_300_utf16_units_and_may_split_a_pair() {
        let short = "a".repeat(300);
        let message = unexpected_stop_message(Some(&short))
            .to_string_lossy()
            .into_owned();
        assert!(message.starts_with(&format!("Cursor stopped unexpectedly: {short}.")));
        // One unit more cuts at 300 with an ellipsis.
        let long = "b".repeat(400);
        let message = unexpected_stop_message(Some(&long))
            .to_string_lossy()
            .into_owned();
        assert!(message.starts_with(&format!(
            "Cursor stopped unexpectedly: {}…",
            "b".repeat(300)
        )));
        // An emoji straddling unit 300: 299 ASCII, then a pair at 299..301. `slice(0, 300)`
        // keeps the high surrogate alone, which survives as a lone surrogate.
        let straddling = format!("{}😀", "c".repeat(299));
        let message = unexpected_stop_message(Some(&straddling));
        let units: Vec<u16> = message.units().collect();
        let prefix: Vec<u16> = "Cursor stopped unexpectedly: ".encode_utf16().collect();
        assert_eq!(
            &units[prefix.len()..prefix.len() + 300],
            &{
                let mut expected: Vec<u16> = "c".repeat(299).encode_utf16().collect();
                expected.push(0xd83d);
                expected
            }[..]
        );
        assert!(!message.is_well_formed());
    }

    #[test]
    fn the_exit_frame_and_callback_keep_their_keys_and_detail_rule() {
        let body = host_exit_body(false, Some(1), None, "exit", Some("boom"));
        assert_eq!(
            body.to_json(),
            r#"{"deliberate":false,"code":1,"signal":null,"reason":"exit","detail":"boom"}"#
        );
        assert_eq!(
            host_exit_body(true, None, Some("SIGTERM"), "signal", None).to_json(),
            r#"{"deliberate":true,"code":null,"signal":"SIGTERM","reason":"signal"}"#
        );
        assert_eq!(exit_args(true, Some("ignored")), r#"[{"deliberate":true}]"#);
        assert_eq!(
            exit_args(false, Some("boom.")),
            r#"[{"deliberate":false,"message":"Cursor stopped unexpectedly: boom. Unfinished work needs your attention."}]"#
        );
    }

    #[test]
    fn identity_and_input_message_arguments_keep_their_key_order() {
        assert_eq!(
            identity_args("i", &ace_json::JsString::from("a")),
            r#"[{"backend":"cursor-sdk","instanceId":"i","nativeSessionId":"a"}]"#
        );
        assert_eq!(
            super::input_message_args("c"),
            r#"[{"commandId":"c","nativeId":"c"}]"#
        );
    }

    #[test]
    fn the_reply_readers_apply_the_schemas_they_port() {
        assert_eq!(
            super::open_agent_id(&json!({"agentId": "a"}))
                .map(|id| id.to_string_lossy().into_owned()),
            Ok("a".to_owned())
        );
        assert!(super::open_agent_id(&json!({"agentId": ""})).is_err());
        assert!(super::open_agent_id(&json!({"agentId": "😀".repeat(513)})).is_err());
        assert!(sandbox_supported(&json!({"sandboxSupported": true})));
        assert!(!sandbox_supported(&json!({"sandboxSupported": "yes"})));
        assert!(settled_error(&json!({"settled": true})));
        assert!(!settled_error(&json!({"settled": 1})));
        assert_eq!(
            result_status(&json!({"status": "finished"})),
            Some("finished")
        );
        assert_eq!(result_status(&json!({"status": 3})), None);
        let _: Value = json!(null);
    }
}
