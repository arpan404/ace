// SPDX-License-Identifier: Apache-2.0
//! The session core's behaviour: the helpers every table uses, the frame it hands over and the
//! turn it reads (`receive`), the send's admission and steer orders (`send`), and the interrupt
//! and close machines (`close`).

mod close;
mod receive;
mod send;

use super::*;
use ace_adapter_api::bridge::ReadGate;
use ace_adapter_api::bridge::queue::{EventQueue, SessionEvent};
use ace_adapter_api::frame::FrameDirection;

use ace_adapter_api::session::Delivery;

use crate::session::envelope::CursorLimits;

/// A core over a queue that starts at 1, as the session's queue does.
pub(super) fn session_core() -> CursorSessionCore {
    CursorSessionCore::new(
        CursorSessionConfig {
            generation: String::from("g"),
            instance_id: String::from("i"),
            root_key: String::from("root"),
            limits: CursorLimits::default(),
            capabilities: String::from(r#"{"steer":true}"#),
        },
        EventQueue::starting_at(ReadGate::new(), 1),
    )
}

pub(super) fn envelope(kind: &str, operation: &str, segment: f64, body: &str) -> String {
    format!(
        r#"{{"schemaVersion":1,"operationId":"{operation}","generation":"g","segment":{segment},"kind":"{kind}","body":{body}}}"#
    )
}

pub(super) fn frame_line(params: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":"h","method":"frame","params":{params}}}"#)
}

/// The requests a set of effects wrote, as `(internal id, method, params)`.
pub(super) fn requests(effects: &[CoreEffect]) -> Vec<(u64, String, Value)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            CoreEffect::Write { wire, .. } => {
                let text = std::str::from_utf8(wire).ok()?.trim().to_owned();
                let value = ace_json::parse(&text).ok()?;
                let id = value.get("id").and_then(Value::as_f64)? as u64;
                let method = value.get("method").and_then(Value::as_str)?.to_owned();
                let params = value.get("params").cloned().unwrap_or(Value::Null);
                Some((id, method, params))
            }
            _ => None,
        })
        .collect()
}

/// The frames a set of effects published, as `(seq, dir, kind)`.
pub(super) fn frames(effects: &[CoreEffect]) -> Vec<(u64, FrameDirection, String)> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            CoreEffect::Event(SessionEvent::Frame { seq, dir, text, .. }) => {
                let value = ace_json::parse(text).ok()?;
                let kind = value.get("kind").and_then(Value::as_str)?.to_owned();
                Some((*seq, *dir, kind))
            }
            _ => None,
        })
        .collect()
}

pub(super) fn settled(effects: &[CoreEffect]) -> Vec<Result<String, String>> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            CoreEffect::Event(SessionEvent::Settle { result, .. }) => Some(match result {
                Ok(json) => Ok(json.clone()),
                Err(error) => Err(error.code.to_owned()),
            }),
            _ => None,
        })
        .collect()
}

pub(super) fn ports(effects: &[CoreEffect]) -> Vec<String> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            CoreEffect::Event(SessionEvent::Port { name, .. }) => Some((*name).to_owned()),
            _ => None,
        })
        .collect()
}

/// The pipe took every line the peer handed out.
pub(super) fn ack(core: &mut CursorSessionCore, mut effects: Vec<CoreEffect>) -> Vec<CoreEffect> {
    let mut at = 0;
    while at < effects.len() {
        if let CoreEffect::Write { ticket, .. } = effects[at] {
            let follow = core.written(ticket);
            effects.splice(at + 1..at + 1, follow);
        }
        at += 1;
    }
    effects
}

/// One line from the host child.
pub(super) fn feed(core: &mut CursorSessionCore, line: &str) -> Vec<CoreEffect> {
    core.stdout_bytes(format!("{line}\n").as_bytes())
}

pub(super) fn reply(core: &mut CursorSessionCore, id: u64, result: &str) -> Vec<CoreEffect> {
    feed(
        core,
        &format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#),
    )
}

/// Opens the session: the open request, the host's reply, and the facade's settlement.
pub(super) fn opened(core: &mut CursorSessionCore) {
    let effects = core
        .start_open(1, &ace_json::json!({"cwd": "/w", "threadId": "t"}), None)
        .expect("an open request");
    let effects = ack(core, effects);
    let (id, method, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the open request");
    assert_eq!(method, "open");
    let effects = reply(core, id, r#"{"agentId":"a"}"#);
    assert_eq!(
        settled(&effects),
        vec![Ok(r#"{"nativeSessionId":"a"}"#.to_owned())]
    );
}

pub(super) fn send(
    core: &mut CursorSessionCore,
    facade_id: u64,
    command_id: Option<&str>,
    delivery: Delivery,
    steer_lost: bool,
) -> Result<Vec<CoreEffect>, HostErrorWire> {
    core.send(
        facade_id,
        CursorSend {
            command_id,
            operation_id: None,
            input: &ace_json::json!([{"type": "text", "text": "hi"}]),
            delivery,
            steer_lost,
        },
    )
}
