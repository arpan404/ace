// SPDX-License-Identifier: Apache-2.0
//! The core's inputs from the peer: one stdout chunk's lines, the two host callers (`frame`
//! requests and `frame`/`login-url` notifications), `receiveFrame`'s order, the malformed-line
//! rule, the stop causes and the reply the acknowledgement book decides. Each method runs under
//! the core's state and appends its effects in order.

use std::collections::VecDeque;

use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::lines::{FramedLines, restore};
use ace_supervisor::peer::{INTERNAL_ERROR, PeerEffect};

use super::ports::{error_body, login_url, may_hold_rpc_message, port_json};
use super::{
    CursorHostCore, HostEffect, MALFORMED, MAX_STRAYS, PEER_CLOSED, PORT_CONNECTION, PORT_STOP,
    PORT_STRAY,
};
use crate::session::ack::Ack;
use crate::session::bounded::{self, DEFAULT_MAX_BYTES};
use crate::session::envelope;
use crate::session::error::{ACE_CURSOR_RPC, HostErrorWire, SessionError};

/// A batch member's failure is ace's storage failing, as `session.ts:93`-`:98` makes it: the
/// unbatch and each inner frame's bound run inside `onFrame` there (`host.ts:161`-`:164`).
fn stored(error: SessionError) -> SessionError {
    SessionError::Peer(format!(
        "ace could not store a Cursor SDK frame: {}",
        error.message()
    ))
}

impl CursorHostCore {
    pub(super) fn lines(&mut self, framed: &FramedLines, out: &mut Vec<HostEffect>) {
        if framed.count == 0 {
            return;
        }
        for raw in framed.text.split('\n') {
            let line = restore(raw);
            let effects = self.peer.line(&line);
            self.peer_effects(Some(&line), effects, out);
        }
    }

    /// Every peer effect, in order. The peer's RPC envelopes never cross (the TypeScript host
    /// installs no `onFrame` on its peer).
    pub(super) fn peer_effects(
        &mut self,
        line: Option<&str>,
        effects: Vec<PeerEffect>,
        out: &mut Vec<HostEffect>,
    ) {
        let mut pending: VecDeque<PeerEffect> = effects.into();
        // The shared peer carries a notification's `params` once, on the `recv` frame of the
        // same line, which precedes the notification (`ace-supervisor`'s `PeerEffect`).
        let mut frame_params: Option<Value> = None;
        while let Some(effect) = pending.pop_front() {
            let follow = match effect {
                PeerEffect::Frame { value, .. } => {
                    frame_params = value.get("params").cloned();
                    Vec::new()
                }
                PeerEffect::Write { wire, ticket } => {
                    self.emit(out, vec![HostEffect::Write { wire, ticket }]);
                    Vec::new()
                }
                PeerEffect::Settle { id, result } => {
                    let result = match result {
                        Ok(value) => Ok(value.to_json()),
                        Err(error) => Err(HostErrorWire {
                            code: ACE_CURSOR_RPC,
                            message: error.message().to_owned(),
                        }),
                    };
                    self.emit(out, vec![HostEffect::Settle { id, result }]);
                    Vec::new()
                }
                PeerEffect::ServerRequest { id, method, params } => {
                    self.server_request(line, id, method, params, out)
                }
                PeerEffect::Notification { method } => {
                    self.notification(line, method, frame_params.take(), out)
                }
                PeerEffect::Malformed { line } => {
                    self.malformed(&line, out);
                    Vec::new()
                }
                PeerEffect::ArmTimer { key, ms } => {
                    self.emit(out, vec![HostEffect::ArmTimer { key, ms }]);
                    Vec::new()
                }
                PeerEffect::CancelTimer { key } => {
                    self.emit(out, vec![HostEffect::CancelTimer { key }]);
                    Vec::new()
                }
                PeerEffect::Failed { message } => {
                    self.connection(&message, out);
                    Vec::new()
                }
            };
            // The reply an effect decided comes straight after it, in this line's order.
            for effect in follow.into_iter().rev() {
                pending.push_front(effect);
            }
        }
    }

    fn server_request(
        &mut self,
        line: Option<&str>,
        id: RpcId,
        method: JsString,
        params: Option<Value>,
        out: &mut Vec<HostEffect>,
    ) -> Vec<PeerEffect> {
        if method.as_str() != "frame" {
            return self.peer.answer_error(
                &id,
                INTERNAL_ERROR,
                &SessionError::UnknownRequest.message(),
            );
        }
        match self.receive_frame(line, params, out) {
            Ok((first, count)) => {
                self.acks.track(Some(id), first, count);
                Vec::new()
            }
            // The frame was refused before storage: answer it, and keep reading (`host.ts:165`).
            Err(error) => self
                .peer
                .answer_error(&id, INTERNAL_ERROR, &error.message()),
        }
    }

    fn notification(
        &mut self,
        line: Option<&str>,
        method: JsString,
        params: Option<Value>,
        out: &mut Vec<HostEffect>,
    ) -> Vec<PeerEffect> {
        match method.as_str() {
            "login-url" => {
                match login_url(params.as_ref()) {
                    Ok(url) => self.emit(out, vec![HostEffect::LoginUrl(url)]),
                    Err(error) => self.connection(&error.message(), out),
                }
                Vec::new()
            }
            "frame" => {
                match self.receive_frame(line, params, out) {
                    Ok((first, count)) => self.acks.track(None, first, count),
                    // An unacknowledged frame that was not stored leaves the turn incomplete,
                    // so the host stops; the cause says whose fault it was (`host.ts:181`-`:188`).
                    Err(error) => {
                        let message = error.message();
                        let reason = if message.starts_with("ace could not store") {
                            message
                        } else {
                            format!("Cursor SDK host frame was rejected: {message}")
                        };
                        self.stop(&reason, out);
                    }
                }
                Vec::new()
            }
            _ => {
                self.connection(&SessionError::UnknownNotification.message(), out);
                Vec::new()
            }
        }
    }

    /// `receiveFrame` (`host.ts:146`-`:189`), in its order: the bound, the envelope, the
    /// generation, the commit, then the error frame. Returns the frame numbers it emitted.
    fn receive_frame(
        &mut self,
        line: Option<&str>,
        params: Option<Value>,
        out: &mut Vec<HostEffect>,
    ) -> Result<(u64, u64), SessionError> {
        let value = params.unwrap_or(Value::Null);
        // The bound runs first, on the parsed value (`host.ts:147`). A frame that is not a batch
        // crosses with the host's own span when it wrote one canonically (it does: `host-wire.ts`
        // writes every line with `boundedJson`), so nothing is serialised twice. `parse_raw` is a
        // validating scan of a line the peer already parsed, kept because it is how the span is
        // found at all; it allocates nothing (`pi/wire.rs:748` admits the same way).
        let raw = line.and_then(|line| ace_json::parse_raw(line).ok());
        let span = raw
            .as_ref()
            .and_then(|raw| raw.get("params"))
            .filter(|span| span.is_canonical())
            .map(|span| span.text());
        bounded::bounded_check(&value, self.limits.max_frame_bytes)?;
        let envelope = envelope::parse(&value)?;
        if envelope.generation != &self.generation {
            return Err(SessionError::GenerationMismatch);
        }
        let error = if !envelope.is_batch() && envelope.kind.as_str() == "error" {
            error_body(envelope.body)
        } else {
            None
        };
        let mut frames: Vec<(Value, String)> = Vec::new();
        if envelope.is_batch() {
            // A batch's inner frames are the session's work in TypeScript (`session.ts:93`-`:98`),
            // so their failures are ace's storage failing, not the host's protocol (`host.ts:161`).
            let inner = envelope::unbatch(&value).map_err(stored)?;
            for frame in inner {
                let text = bounded::bounded_json(&frame, DEFAULT_MAX_BYTES)
                    .map_err(SessionError::from)
                    .map_err(stored)?;
                frames.push((frame, text));
            }
        } else {
            // One copy, the event's own: the queue outlives the line the span borrows.
            let text = match span {
                Some(span) => span.to_owned(),
                None => bounded::bounded_json(&value, self.limits.max_frame_bytes)?,
            };
            frames.push((value, text));
        }
        let first = self.next_frame + 1;
        let mut effects = Vec::with_capacity(frames.len());
        for (data, text) in frames {
            self.next_frame += 1;
            effects.push(HostEffect::Frame {
                seq: self.next_frame,
                data,
                text,
            });
        }
        let count = effects.len() as u64;
        self.emit(out, effects);
        if let Some(message) = error {
            self.errors.push((first, message));
        }
        Ok((first, count))
    }

    /// `onMalformed` (`host.ts:137`-`:144`): JSON, or text that may hold a JSON-RPC message, is
    /// ace's own protocol breaking; anything else is stray output, at most 64 lines.
    fn malformed(&mut self, line: &str, out: &mut Vec<HostEffect>) {
        if ace_json::parse(line).is_ok() || may_hold_rpc_message(line) {
            self.stop(MALFORMED, out);
            return;
        }
        let index = self.strays;
        self.strays += 1;
        if index >= MAX_STRAYS {
            return;
        }
        // The note frame takes its place in line order, so later events wait for it.
        self.emit(
            out,
            vec![HostEffect::Port {
                name: PORT_STRAY,
                json: port_json("line", line),
            }],
        );
        self.notes += 1;
    }

    /// `fail(reason)` for a cause the core already named: stop the host, reason final.
    pub(super) fn stop(&mut self, reason: &str, out: &mut Vec<HostEffect>) {
        if self.closed {
            return;
        }
        self.emit(
            out,
            vec![HostEffect::Port {
                name: PORT_STOP,
                json: port_json("reason", reason),
            }],
        );
        let effects = self.peer.close(PEER_CLOSED);
        self.closed = true;
        self.peer_effects(None, effects, out);
    }

    /// `onError`: the caller wraps the host's words and fails the host (`host.ts:152`-`:154`).
    fn connection(&mut self, message: &str, out: &mut Vec<HostEffect>) {
        if self.closed {
            return;
        }
        self.emit(
            out,
            vec![HostEffect::Port {
                name: PORT_CONNECTION,
                json: port_json("message", message),
            }],
        );
        let effects = self.peer.close(PEER_CLOSED);
        self.closed = true;
        self.peer_effects(None, effects, out);
    }

    pub(super) fn apply(&mut self, ack: Ack, out: &mut Vec<HostEffect>) {
        match ack {
            Ack::Committed(id) => {
                let mut result = Map::with_capacity(1);
                result.insert("committed", Value::Bool(true));
                let effects = self.peer.answer(&id, &Value::Object(result));
                self.peer_effects(None, effects, out);
            }
            Ack::Refused { id, reason } => {
                let effects = self.peer.answer_error(&id, INTERNAL_ERROR, &reason);
                self.peer_effects(None, effects, out);
            }
            Ack::Stop(reason) => self.stop(&reason, out),
        }
    }

    /// Route one input's effects: past an unanswered stray port they wait in the hold.
    pub(super) fn emit(&mut self, out: &mut Vec<HostEffect>, effects: Vec<HostEffect>) {
        for effect in effects {
            if self.notes > 0 {
                self.held.push_back(effect);
            } else {
                out.push(effect);
            }
        }
    }
}
