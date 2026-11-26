// SPDX-License-Identifier: Apache-2.0
//! What one peer effect does (`jsonrpc.ts`): the frame is captured and published first,
//! then its settlement runs, in frame order, before the next effect in the same chunk.

use super::super::frames::{capture_frame, capture_text_frame};
use super::super::open::OPEN_STALL_MS;
use super::super::protocol::agent_methods;
use super::{AcpEffect, AcpErrorWire, INTERNAL_CALL_BIT};
use crate::translate::data::{js_string, object, string};
use crate::translate::settlement::{CANCELLATION_GRACE_MS, prompt_end};
use ace_adapter_api::frame::FrameDirection;
use ace_json::{JsString, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::{Direction, PeerEffect, PeerError};
use std::collections::HashSet;

impl super::AcpCore {
    pub(crate) fn apply_peer_effects(
        &mut self,
        peer_effects: Vec<PeerEffect>,
        effects: &mut Vec<AcpEffect>,
    ) {
        // Set once a frame of this input failed to capture, with the direction it had.
        // TS acts on no part of such a line (`jsonrpc.ts:285`, `:299`): it stops before
        // the write or the dispatch.
        let mut capture_failed: Option<(String, bool)> = None;
        // The frame the next notification's `params` come from: the peer emits both, and
        // only the frame owns the tree, so this borrows instead of copying it.
        let mut recv_frame: Option<Value> = None;
        for effect in peer_effects {
            if let Some((message, sent)) = capture_failed.clone() {
                match effect {
                    // The received line's call is already out of the peer, so nothing
                    // else settles it; it ends as the capture failure, as TS's close ends it.
                    PeerEffect::Settle { id, .. } if !sent => {
                        self.settle_call(id, Err(message), effects);
                    }
                    // The sent line never reached the pipe: release the charge its write
                    // took, so the queue hands out the next one (`jsonrpc.ts:285`).
                    PeerEffect::Write { ticket, .. } if sent => {
                        let released = self.written(ticket);
                        effects.extend(released);
                    }
                    _ => {}
                }
                continue;
            }
            match effect {
                PeerEffect::Frame { dir, value, text } => {
                    // The frame is captured first, so a capture that throws applies none of
                    // the step's effects and no reply it causes is captured before it.
                    let frame_dir = match dir {
                        Direction::Send => FrameDirection::Send,
                        Direction::Recv => FrameDirection::Recv,
                    };
                    match capture_frame(&value, text, &self.secrets) {
                        Ok(captured) => effects.push(AcpEffect::Frame {
                            dir: frame_dir,
                            channel: "stdio".to_owned(),
                            text: captured.json,
                        }),
                        Err(err) => {
                            let message = self.redact_message(&err.to_string());
                            if dir == Direction::Recv {
                                // The observer closes the peer before it reports, so no
                                // line still draining after this one is acted on
                                // (`jsonrpc.ts:300`-`:305`).
                                let closing = self.peer.close(&message);
                                self.fail_capture(&message, effects);
                                self.apply_peer_effects(closing, effects);
                            } else {
                                self.fail_send_capture(&value, &message, effects);
                            }
                            capture_failed = Some((message, dir == Direction::Send));
                            continue;
                        }
                    }
                    // Settlement happens here, in frame order, before any subsequent
                    // notification or reply in the same stdout chunk (`session.ts:201`–`:211`).
                    match dir {
                        Direction::Send => self.sending(&value),
                        Direction::Recv => {
                            if self.open_stalled {
                                self.arm_deadline("open", OPEN_STALL_MS, effects);
                            }
                            if value.as_object().is_some_and(|m| !m.contains_key("method")) {
                                self.replied(&value, effects);
                            }
                        }
                    }
                    recv_frame = Some(value);
                }
                PeerEffect::Write { wire, ticket } => {
                    self.active_write_ticket = Some(ticket);
                    effects.push(AcpEffect::Write { wire, ticket });
                }
                PeerEffect::Settle { id, result } => {
                    let mapped = result.map_err(|e| e.to_string());
                    self.settle_call(id, mapped, effects);
                }
                PeerEffect::ServerRequest { id, method, params } => {
                    self.handle_server_request(id, method, params, effects);
                }
                PeerEffect::Notification { method } => {
                    let params = recv_frame.as_ref().and_then(|value| value.get("params"));
                    self.handle_notification(&method, params, effects);
                    recv_frame = None;
                }
                PeerEffect::Malformed { line } => {
                    self.emit_text_frame(FrameDirection::Recv, "stdio-text", &line, effects);
                }
                PeerEffect::ArmTimer { key, ms } => {
                    effects.push(AcpEffect::ArmTimer { key, ms });
                }
                PeerEffect::CancelTimer { key } => {
                    effects.push(AcpEffect::CancelTimer { key });
                }
                PeerEffect::Failed { message } => {
                    self.fail(&message, effects);
                }
            }
        }
    }

    /// Settle one facade call, routing the open's internal ids first (`session.ts:290`).
    fn settle_call(
        &mut self,
        id: u64,
        mapped: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) {
        if self.on_open_rpc_settled(id, mapped.clone(), effects) {
            return;
        }
        if id & INTERNAL_CALL_BIT != 0 {
            // Internal calls: a steer's reply, a selection's reply, or an open call whose
            // state already settled (a stall timeout, say).
            if self.finish_steer(id, mapped.clone(), effects)
                || self.finish_selection(id, mapped.clone(), effects)
            {
                return;
            }
            return;
        }
        let settled = match mapped {
            Ok(val) => Ok(val.to_json()),
            Err(msg) => Err(AcpErrorWire::rpc_error(self.redact_message(&msg))),
        };
        effects.push(AcpEffect::Settle {
            id,
            result: settled,
        });
    }

    /// Track outbound `session/prompt` and `session/new|load|resume` (`session.ts:277`–`:289`).
    fn sending(&mut self, value: &Value) {
        let message = object(value);
        let method = string(message.get("method").unwrap_or(&Value::Null));
        if method == agent_methods::SESSION_PROMPT {
            self.prompt_frames = self.prompt_frames.saturating_add(1);
            self.prompt_id = value_rpc_id(message.get("id"));
            self.shells.prompt_started();
        }
        if matches!(
            method,
            agent_methods::SESSION_NEW
                | agent_methods::SESSION_LOAD
                | agent_methods::SESSION_RESUME
        ) {
            self.open_id = value_rpc_id(message.get("id"));
            self.loading = method == agent_methods::SESSION_LOAD;
        }
    }

    /// Settle inbound open or prompt replies in frame order (`session.ts:290`–`:312`).
    fn replied(&mut self, value: &Value, effects: &mut Vec<AcpEffect>) {
        let message = object(value);
        let Some(id) = value_rpc_id(message.get("id")) else {
            return;
        };
        if self.open_id.as_ref() == Some(&id) {
            self.open_id = None;
            self.loading = false;
            if !message.contains_key("error") {
                let result_id = object(message.get("result").unwrap_or(&Value::Null))
                    .get("sessionId")
                    .and_then(js_string)
                    .filter(|s| !s.is_empty())
                    .cloned();
                let resume_id = self
                    .resume
                    .as_ref()
                    .map(|r| JsString::from(r.native_session_id.as_str()))
                    .filter(|s| !s.is_empty());
                let resolved = result_id
                    .or(resume_id)
                    .unwrap_or_else(|| self.opening_session.clone());
                self.native_session_id = resolved.clone();
                self.routing.bind_root(resolved.clone());
                self.shells.set_root(resolved);
            }
            return;
        }
        if self.prompt_id.as_ref() != Some(&id) {
            return;
        }
        if let Some(error) = message.get("error") {
            // `promptEnd` reads an error reply as the empty reason (`settlement.ts:18`), so
            // `replied` ends the turn first: the root's grace is cleared, its questions
            // answered and its implicit children ended (`session.ts:305`). Then the send
            // rejects with the agent's error (`:771`), and ace's guidance is not spent.
            let reported = error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_json());
            self.prompt_id = None;
            self.prompt_ended("", effects);
            self.prompt_refused(reported, effects);
            return;
        }
        let Some((reason, _)) = prompt_end(value) else {
            // No stop reason: completion is unconfirmed (`session.ts:774`-`:778`).
            self.fail("ACP prompt completion is unconfirmed", effects);
            return;
        };
        self.prompt_id = None;
        self.prompt_ended(&reason, effects);
        self.prompt_replied(effects);
    }

    /// Close prompt-scoped work immediately when the prompt reply frame arrives (`session.ts:314`–`:333`).
    fn prompt_ended(&mut self, reason: &str, effects: &mut Vec<AcpEffect>) {
        let root = self.native_session_id.clone();
        self.clear_deadline("root", effects);
        if reason == "cancelled" {
            self.cancel_questions(None, None, effects);
        } else {
            let mut owners = HashSet::with_capacity(1);
            owners.insert(root.clone());
            self.cancel_questions(Some(&owners), None, effects);
        }
        self.shells.prompt_ended(&root, reason);
        self.routing.prompt_ended();
        if reason != "cancelled" {
            return;
        }
        if self.routing.has_live_children() {
            self.arm_deadline("children", CANCELLATION_GRACE_MS as f64, effects);
        }
        if self.shells.blocked() {
            self.arm_deadline("shells", CANCELLATION_GRACE_MS as f64, effects);
        }
    }

    /// Handle incoming `session/update` notifications (`session.ts:217`–`:251`).
    pub(crate) fn emit_note(&mut self, channel: &str, data: Value, effects: &mut Vec<AcpEffect>) {
        self.emit_value_frame(FrameDirection::Note, channel, &data, effects);
    }

    fn emit_value_frame(
        &mut self,
        dir: FrameDirection,
        channel: &str,
        data: &Value,
        effects: &mut Vec<AcpEffect>,
    ) {
        match capture_frame(data, None, &self.secrets) {
            Ok(captured) => effects.push(AcpEffect::Frame {
                dir,
                channel: channel.to_owned(),
                text: captured.json,
            }),
            Err(err) => {
                let message = err.to_string();
                self.fail_capture(&message, effects);
            }
        }
    }

    pub(crate) fn emit_text_frame(
        &mut self,
        dir: FrameDirection,
        channel: &str,
        line: &str,
        effects: &mut Vec<AcpEffect>,
    ) {
        match capture_text_frame(line, &self.secrets) {
            Ok(captured) => effects.push(AcpEffect::Frame {
                dir,
                channel: channel.to_owned(),
                text: captured.json,
            }),
            Err(err) => {
                let message = err.to_string();
                self.fail_capture(&message, effects);
            }
        }
    }

    /// An outbound *request* that cannot be captured ends only the call it carried: `#send`
    /// throws before the write (`jsonrpc.ts:285`), and its rejection settles that promise
    /// (`:229`). A notification has no promise (`:244`), and a reply answers an agent's
    /// request (`:344`-`:369`), so both failures reach `onError` and fail the session. A
    /// reply carries an `id` too, which is why `method` decides.
    fn fail_send_capture(&mut self, value: &Value, message: &str, effects: &mut Vec<AcpEffect>) {
        let message_frame = object(value);
        match value_rpc_id(message_frame.get("id")) {
            Some(id) if message_frame.contains_key("method") => {
                let rejection = self.peer.reject_request(&id, PeerError::new(message));
                self.apply_peer_effects(rejection, effects);
            }
            _ => self.fail_capture(message, effects),
        }
    }

    /// A frame that cannot be captured ends the session (`session.ts:373`–`:381`):
    /// `fail` once, then only the failure is left to report.
    fn fail_capture(&mut self, message: &str, effects: &mut Vec<AcpEffect>) {
        if self.closed {
            effects.push(AcpEffect::Fatal {
                message: message.to_owned(),
            });
        } else {
            self.fail(message, effects);
        }
    }
}

fn value_rpc_id(value: Option<&Value>) -> Option<RpcId> {
    match value {
        Some(Value::String(text)) => Some(RpcId::Text(text.clone())),
        Some(Value::Number(num)) => num.as_f64().map(RpcId::Number),
        _ => None,
    }
}
