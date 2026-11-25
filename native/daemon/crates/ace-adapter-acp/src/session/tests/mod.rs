// SPDX-License-Identifier: Apache-2.0
//! Behavioural tests for the ACP session core and capture (E3-acp.1), split by what
//! they guard: the frame capture and its order, the open handshake, the saved
//! selections, settlement, and the session's own lifecycle.

mod capture;
mod commands;
mod handshake;
mod input;
mod lifecycle;
mod queue;
mod resolve;
mod selections;
mod settlement;

use ace_adapter_api::frame::FrameDirection;
use ace_json::{JsString, Value, json};

use super::core::{AcpCore, AcpCoreConfig, AcpEffect};
use super::input::InputSend;
use super::negotiation::CompatibilityProfile;
use super::quirks::AcpSessionQuirks;

fn ack_writes(core: &mut AcpCore, effects: &mut Vec<AcpEffect>) {
    let mut i = 0;
    while i < effects.len() {
        if let AcpEffect::Write { ticket, .. } = effects[i] {
            let follow = core.written(ticket);
            effects.extend(follow);
        }
        i += 1;
    }
}

fn sent_json_messages(effects: &[AcpEffect]) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Write { wire, .. } => {
                let text = std::str::from_utf8(wire).ok()?.trim();
                ace_json::parse(text).ok()
            }
            _ => None,
        })
        .collect()
}

fn settlements(effects: &[AcpEffect], facade_id: u64) -> Vec<Result<String, (String, String)>> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Settle { id, result } if *id == facade_id => Some(match result {
                Ok(json) => Ok(json.clone()),
                Err(err) => Err((err.code.to_owned(), err.message.clone())),
            }),
            _ => None,
        })
        .collect()
}

fn note_frames(effects: &[AcpEffect], channel: &str) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Frame {
                dir: FrameDirection::Note,
                channel: ch,
                text,
            } if ch == channel => ace_json::parse(text).ok(),
            _ => None,
        })
        .collect()
}

fn gemini_profile() -> CompatibilityProfile {
    CompatibilityProfile {
        id: "gemini-043".to_owned(),
        agent: "gemini".to_owned(),
        version: "0.43.0".to_owned(),
        compatible: None,
        legacy_model: true,
        deny_selectors: false,
        deny_resume: false,
        deny_http_mcp: false,
        subagent_sessions: false,
    }
}

/// One turn's identity, as the engine's fence hands it over.
pub(super) struct Fence {
    pub turn: Option<String>,
    pub current: bool,
}

impl ace_adapter_api::session::SteerFence for Fence {
    fn turn(&self) -> Option<&str> {
        self.turn.as_deref()
    }

    fn current(&self) -> bool {
        self.current
    }
}

pub(super) fn fence(current: bool) -> Fence {
    Fence {
        turn: Some("turn-1".to_owned()),
        current,
    }
}

pub(super) fn text(value: &str) -> Value {
    json!({ "type": "text", "text": value })
}

pub(super) fn session_core(thread: &str) -> AcpCore {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        thread,
        "/work",
        AcpSessionQuirks::generic(),
    ));
    core.native_session_id = JsString::from("sess-1");
    core
}

pub(super) fn send(
    core: &mut AcpCore,
    operation: u64,
    delivery: ace_adapter_api::session::Delivery,
    fence: Option<&dyn ace_adapter_api::session::SteerFence>,
) -> Vec<AcpEffect> {
    let input = vec![text("hello")];
    let mut effects = Vec::new();
    core.send(
        InputSend {
            operation,
            input: &input,
            delivery,
            command_id: None,
            origin: None,
            fence,
        },
        &mut effects,
    );
    ack_writes(core, &mut effects);
    effects
}

/// A core with one prompt in flight, answered by the caller.
pub(super) fn core_with_prompt(thread: &str) -> (AcpCore, Value) {
    let mut core = session_core(thread);
    let sent = send(
        &mut core,
        1,
        ace_adapter_api::session::Delivery::Queue,
        None,
    );
    let id = sent_id(&sent, "session/prompt").unwrap_or_default();
    assert!(core.prompt_id.is_some(), "the prompt is in flight");
    (core, id)
}

/// The id the agent answers, read from the request frame the session just sent.
pub(super) fn sent_id(effects: &[AcpEffect], method: &str) -> Option<Value> {
    sent_json_messages(effects)
        .into_iter()
        .find(|message| message.get("method").and_then(Value::as_str) == Some(method))
        .and_then(|message| message.get("id").cloned())
}

pub(super) fn prompt_reply(id: &Value, reason: &str) -> Vec<u8> {
    format!(
        "{}\n",
        json!({ "jsonrpc": "2.0", "id": id, "result": { "stopReason": reason } }).to_json()
    )
    .into_bytes()
}
