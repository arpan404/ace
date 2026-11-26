// SPDX-License-Identifier: Apache-2.0
//! The session's commands: the requests it builds for the host (`session.ts:195`-`:303`), the
//! send the admission admits, and the two refusals a send can be answered with. Every payload
//! keeps the TypeScript literal's key order and drops a key bound to `undefined`, as
//! `boundedJson` does.
//!
//! A host refusal is classified here, not in the caller: `refusedByHost` (`host-refusal.ts:11`)
//! reads the reply's error JSON, and only a refusal proves the input never reached Cursor, so
//! only a refusal is `InputRejected`.

use ace_adapter_api::bridge::queue::{INPUT_REJECTED, STEER_TARGET_LOST};
use ace_adapter_api::session::{CloseReason, Delivery};
use ace_json::{Map, Value};

mod close;
mod send;

pub(crate) use close::{CloseFlight, close, close_stopped, interrupt_close, request_stop};
pub(crate) use send::{Interrupting, SendStage, Sending, interrupt, send};

use super::envelope::CursorLimits;
use super::error::{ACE_CURSOR_RPC, HostErrorWire};

/// The message `assert_steer_target` refuses a lost fenced steer with (`ace-adapter-api`'s
/// `session.rs`), so the caller can rethrow the error it kept under the same text.
pub const STEER_LOST_MESSAGE: &str = "The turn this message was meant to join has ended";
/// `maxInputBytes`' failure code, as the engine sees it (`session.ts:240`).
pub const INPUT_REJECTED_CODE: &str = INPUT_REJECTED;
/// A lost steer's code (`session.ts:248`).
pub const STEER_TARGET_LOST_CODE: &str = STEER_TARGET_LOST;

/// What `open` carries (`session.ts:196`-`:214`). The caller owns these fields; the core builds
/// the request in the literal's order.
pub struct CursorOpen<'a> {
    pub cwd: &'a str,
    pub thread_id: &'a str,
    pub checkpoint_generation: Option<u64>,
    pub model: Option<&'a str>,
    pub model_params: Option<&'a Value>,
    pub native_session_id: Option<&'a str>,
    pub recover: Option<&'a Value>,
    pub permission_mode: Option<&'a str>,
    pub auto_review: bool,
    /// The ace MCP endpoint: `url` and `bearer` (`session.ts:212`).
    pub mcp: Option<(&'a str, &'a str)>,
    pub instructions: Option<&'a str>,
}

/// `host.request("open", {...})` (`session.ts:196`-`:214`).
pub fn open_params(generation: &str, limits: &CursorLimits, open: CursorOpen<'_>) -> Value {
    let mut params = Map::with_capacity(13);
    params.insert("cwd", Value::from(open.cwd));
    params.insert("threadId", Value::from(open.thread_id));
    params.insert("generation", Value::from(generation));
    if let Some(generation) = open.checkpoint_generation {
        params.insert("checkpointGeneration", Value::from(generation));
    }
    if let Some(model) = open.model {
        params.insert("model", Value::from(model));
    }
    if let Some(model_params) = open.model_params {
        params.insert("modelParams", model_params.clone());
    }
    if let Some(native_session_id) = open.native_session_id {
        params.insert("nativeSessionId", Value::from(native_session_id));
    }
    if let Some(recover) = open.recover {
        params.insert("recover", recover.clone());
    }
    if let Some(permission_mode) = open.permission_mode {
        params.insert("permissionMode", Value::from(permission_mode));
    }
    params.insert("autoReviewAvailable", Value::Bool(open.auto_review));
    params.insert("limits", limits.to_value());
    if let Some((url, bearer)) = open.mcp {
        let mut mcp = Map::with_capacity(2);
        mcp.insert("url", Value::from(url));
        mcp.insert("bearer", Value::from(bearer));
        params.insert("mcp", Value::Object(mcp));
    }
    if let Some(instructions) = open.instructions {
        params.insert("instructions", Value::from(instructions));
    }
    Value::Object(params)
}

/// `host.request("configure", { model, modelParams })` (`session.ts:225`-`:228`).
pub fn configure_params(model: &str, model_params: Option<&Value>) -> Value {
    let mut params = Map::with_capacity(2);
    params.insert("model", Value::from(model));
    if let Some(model_params) = model_params {
        params.insert("modelParams", model_params.clone());
    }
    Value::Object(params)
}

/// `host.request("close", { reason })` (`session.ts:186`).
pub fn close_params(reason: CloseReason) -> Value {
    let mut params = Map::with_capacity(1);
    let reason = match reason {
        CloseReason::Idle => "idle",
        CloseReason::User => "user",
        CloseReason::Shutdown => "shutdown",
    };
    params.insert("reason", Value::from(reason));
    Value::Object(params)
}

/// `host.request("send", { operationId, commandId, segment, input })` (`session.ts:267`-`:272`).
pub fn send_params(
    operation: &str,
    command_id: Option<&str>,
    segment: f64,
    input: &Value,
) -> Value {
    let mut params = Map::with_capacity(4);
    params.insert("operationId", Value::from(operation));
    params.insert("commandId", Value::from(command_id.unwrap_or(operation)));
    params.insert("segment", Value::from(segment));
    params.insert("input", input.clone());
    Value::Object(params)
}

/// The `cancel` frame's body (`session.ts:249`, `:291`), in the literal's key order.
/// `commandId` is dropped when it is `None`, as `boundedJson` drops an `undefined` value.
pub fn cancel_body(replacement: bool, command_id: Option<&str>) -> Value {
    let mut body = Map::with_capacity(2);
    body.insert("replacement", Value::Bool(replacement));
    if replacement && let Some(command_id) = command_id {
        body.insert("commandId", Value::from(command_id));
    }
    Value::Object(body)
}

/// `refusedByHost` (`host-refusal.ts:9`-`:15`): the reply's error message says the request never
/// reached Cursor. A message that is not JSON, or not that shape, is not a refusal.
pub fn refused_by_host(message: &str) -> bool {
    let Ok(value) = ace_json::parse(message) else {
        return false;
    };
    matches!(
        value.get("data").and_then(|data| data.get("refused")),
        Some(Value::Bool(true))
    )
}

/// The engine's `InputRejected` (`session.ts:280`): a code the binding maps back to the class.
pub fn input_rejected(message: impl Into<String>) -> HostErrorWire {
    HostErrorWire {
        code: INPUT_REJECTED_CODE,
        message: message.into(),
    }
}

/// The engine's `SteerTargetLost`: the caller rethrows the error `assertSteerTarget` kept.
pub fn steer_target_lost() -> HostErrorWire {
    HostErrorWire {
        code: STEER_TARGET_LOST_CODE,
        message: STEER_LOST_MESSAGE.to_owned(),
    }
}

/// A send the caller asked the core to admit (`session.ts:230`). `operation_id` is the caller's
/// `commandId ?? options.operationId?.()`; `None` lets the core fall back to its own sequence.
pub struct CursorSend<'a> {
    pub command_id: Option<&'a str>,
    pub operation_id: Option<&'a str>,
    pub input: &'a Value,
    pub delivery: Delivery,
    /// `assertSteerTarget(delivery, fence)` failed in the caller's hands (`session.ts:248`).
    pub steer_lost: bool,
}

/// A request the host refused before it was written, as the caller's promise sees it.
pub(super) fn rpc_error(message: String) -> HostErrorWire {
    HostErrorWire {
        code: ACE_CURSOR_RPC,
        message,
    }
}

/// A plain `Error` in the caller, which the bridge maps from a code it does not know.
pub(super) fn plain(message: &str) -> HostErrorWire {
    HostErrorWire {
        code: PLAIN_CODE,
        message: message.to_owned(),
    }
}

/// A code the bridge does not name: the caller throws a plain `Error` with the message.
pub const PLAIN_CODE: &str = "ACE_CURSOR_ERROR";

#[cfg(test)]
mod tests {
    use ace_adapter_api::session::{Delivery, SteerFence, assert_steer_target};
    use ace_json::json;

    use super::{
        CursorOpen, STEER_LOST_MESSAGE, cancel_body, close_params, configure_params, open_params,
        refused_by_host, send_params,
    };
    use crate::session::envelope::CursorLimits;
    use ace_adapter_api::session::CloseReason;

    struct Lost;
    impl SteerFence for Lost {
        fn turn(&self) -> Option<&str> {
            Some("t")
        }
        fn current(&self) -> bool {
            false
        }
    }

    #[test]
    fn the_open_request_keeps_the_literals_key_order_and_drops_absent_keys() {
        let params = open_params(
            "g",
            &CursorLimits::default(),
            CursorOpen {
                cwd: "/w",
                thread_id: "t",
                checkpoint_generation: None,
                model: Some("m"),
                model_params: None,
                native_session_id: None,
                recover: None,
                permission_mode: Some("restricted"),
                auto_review: false,
                mcp: Some(("http://127.0.0.1:1/mcp", "b")),
                instructions: None,
            },
        );
        let text = params.to_json();
        assert!(text.starts_with(
            r#"{"cwd":"/w","threadId":"t","generation":"g","model":"m","permissionMode":"restricted","autoReviewAvailable":false,"limits":{"maxWorkers":8"#
        ));
        assert!(text.ends_with(r#""mcp":{"url":"http://127.0.0.1:1/mcp","bearer":"b"}}"#));
        assert!(!text.contains("checkpointGeneration"));
        assert!(!text.contains("modelParams"));
        assert!(!text.contains("instructions"));
    }

    #[test]
    fn the_open_request_carries_every_optional_key_when_the_session_has_one() {
        let recover = json!({"runs": [{"runId": "r", "through": 3}]});
        let params = open_params(
            "g",
            &CursorLimits::default(),
            CursorOpen {
                cwd: "/w",
                thread_id: "t",
                checkpoint_generation: Some(2),
                model: None,
                model_params: Some(&json!({"reasoning": "high"})),
                native_session_id: Some("native"),
                recover: Some(&recover),
                permission_mode: None,
                auto_review: true,
                mcp: None,
                instructions: Some("be brief"),
            },
        );
        assert_eq!(
            params.to_json(),
            format!(
                r#"{{"cwd":"/w","threadId":"t","generation":"g","checkpointGeneration":2,"modelParams":{{"reasoning":"high"}},"nativeSessionId":"native","recover":{{"runs":[{{"runId":"r","through":3}}]}},"autoReviewAvailable":true,"limits":{},"instructions":"be brief"}}"#,
                CursorLimits::default().to_value().to_json()
            )
        );
    }

    #[test]
    fn the_limits_object_keeps_the_schemas_order() {
        assert_eq!(
            CursorLimits::default().to_value().to_json(),
            r#"{"maxWorkers":8,"maxFrameBytes":1048576,"maxPendingBytes":2097152,"maxCallbacks":32,"maxIdentities":2048,"maxInputBytes":262144,"maxCheckpointBytes":8589934592,"historyPageSize":100,"heapMb":2048,"timeoutMs":30000,"sendTimeoutMs":300000,"ackTimeoutMs":300000,"graceMs":5000}"#
        );
    }

    #[test]
    fn a_replacement_cancel_drops_an_absent_command_id_and_a_plain_cancel_carries_none() {
        // `session.ts:249` writes `{ replacement: true, commandId }`; `boundedJson` drops an
        // `undefined` value, so no key is stored at all.
        assert_eq!(cancel_body(true, None).to_json(), r#"{"replacement":true}"#);
        assert_eq!(
            cancel_body(true, Some("c1")).to_json(),
            r#"{"replacement":true,"commandId":"c1"}"#
        );
        // `session.ts:291` writes no command id, even if one is offered.
        assert_eq!(
            cancel_body(false, Some("c1")).to_json(),
            r#"{"replacement":false}"#
        );
    }

    #[test]
    fn the_remaining_requests_keep_their_keys() {
        assert_eq!(
            configure_params("m", Some(&json!({"effort": "high"}))).to_json(),
            r#"{"model":"m","modelParams":{"effort":"high"}}"#
        );
        assert_eq!(configure_params("m", None).to_json(), r#"{"model":"m"}"#);
        assert_eq!(
            close_params(CloseReason::User).to_json(),
            r#"{"reason":"user"}"#
        );
        assert_eq!(
            close_params(CloseReason::Idle).to_json(),
            r#"{"reason":"idle"}"#
        );
        assert_eq!(
            close_params(CloseReason::Shutdown).to_json(),
            r#"{"reason":"shutdown"}"#
        );
        assert_eq!(
            send_params("op", None, 0.0, &json!([{"type": "text", "text": "hi"}])).to_json(),
            r#"{"operationId":"op","commandId":"op","segment":0,"input":[{"type":"text","text":"hi"}]}"#
        );
    }

    #[test]
    fn a_host_refusal_is_the_shapes_the_message_names() {
        assert!(refused_by_host(r#"{"data":{"refused":true}}"#));
        assert!(refused_by_host(
            r#"{"code":"x","data":{"refused":true},"message":"no"}"#
        ));
        assert!(!refused_by_host(r#"{"data":{"refused":false}}"#));
        assert!(!refused_by_host("not json"));
        assert!(!refused_by_host(r#"{"data":{}}"#));
    }

    #[test]
    fn the_steer_lost_message_is_the_apis_own() {
        let error = assert_steer_target(Delivery::Steer, Some(&Lost)).expect_err("lost");
        assert_eq!(
            error.to_string(),
            format!("steer target lost: {STEER_LOST_MESSAGE}")
        );
        // A queued send is not fenced.
        assert!(assert_steer_target(Delivery::Queue, Some(&Lost)).is_ok());
    }
}
