// SPDX-License-Identifier: Apache-2.0
//! The JSON-RPC peer, ported from `provider-kit/src/jsonrpc.ts` (`JsonRpcPeer`,
//! `:129`–`:365`), `rpc-owner.ts` and `rpc-timers.ts` over the merged halves in
//! [`crate::jsonrpc`] (`RpcIds`, `WriterQueue`, `inspect`, `error_code`). Sans-IO
//! like `PiWire`: one input returns its effects in the order the state changed,
//! and the shell owns the pipe, the clock and the timers.
//!
//! JSON goes through `ace-json`, so a request id keeps its exact type (`"7"` is
//! not `7`) and a lone surrogate survives (`id_to_json` writes it back as
//! `\ud800`). A received frame keeps every unknown field: the shell observes the
//! whole value, and classification only names its shape.
//!
//! One peer owns the pipe's id reservations and write queue (`rpc-owner.ts`), as
//! the TypeScript owner does per stream. A timeout, a rejected reply and a close
//! each settle a pending call exactly once: settling removes it before the
//! effects are built, so a later response or a second close finds nothing.

use std::collections::HashMap;
use std::fmt;

use ace_json::{JsString, Map, Value};

use crate::budget::StreamError;
use crate::jsonrpc::{self, FrameKind, RpcId, RpcIds, WriterQueue};

/// `maxMessageBytes`' default (`jsonrpc.ts:151`).
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// `maxIncomingRequests`' default (`jsonrpc.ts:149`).
const MAX_INCOMING: usize = 128;
/// `maxExplicitIds`' default (`jsonrpc.ts:158`).
const MAX_EXPLICIT_IDS: usize = 4096;
/// The default deadline when a request and its config both leave one unset.
const DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
/// `MethodNotFound`'s code in an answer (`jsonrpc.ts:361`).
pub const METHOD_NOT_FOUND: f64 = -32601.0;
/// Any other handler failure's code (`jsonrpc.ts:361`).
pub const INTERNAL_ERROR: f64 = -32603.0;
/// The default `onRequest`'s message (`jsonrpc.ts:142`).
pub const UNHANDLED_REQUEST: &str = "unhandled request";

/// Which side of the pipe a frame came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Send,
    Recv,
}

/// A refusal or a rejection, by the message the shell shows. A response's
/// `error` is its `JSON.stringify` text, so `error_code` reads it unchanged.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PeerError {
    message: String,
}

impl PeerError {
    pub fn new(message: impl Into<String>) -> PeerError {
        PeerError {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl From<StreamError> for PeerError {
    fn from(error: StreamError) -> PeerError {
        PeerError::new(error.to_string())
    }
}

/// The effects of one input, in the order the state changed. A `recv` frame
/// precedes the effect it causes, as `onFrame` precedes dispatch today.
pub enum PeerEffect {
    /// The whole parsed frame, unredacted: the session redacts it.
    Frame {
        dir: Direction,
        value: Value,
    },
    /// One line for stdin, and the ticket `written` names when the pipe took it.
    Write {
        wire: Vec<u8>,
        ticket: u64,
    },
    /// Settles the facade's promise `id`, once.
    Settle {
        id: u64,
        result: Result<Value, PeerError>,
    },
    ServerRequest {
        id: RpcId,
        method: JsString,
        /// Absent when the line had no `params`, as `undefined` is today.
        params: Option<Value>,
    },
    Notification {
        method: JsString,
        params: Option<Value>,
    },
    /// The line was not a JSON-RPC envelope, or not JSON at all.
    Malformed {
        line: String,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// `onError`: reported, never a settlement.
    Failed {
        message: String,
    },
}

impl fmt::Debug for PeerEffect {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PeerEffect::Frame { dir, value } => formatter
                .debug_struct("Frame")
                .field("dir", dir)
                .field("value", &value.to_json())
                .finish(),
            PeerEffect::Write { wire, ticket } => formatter
                .debug_struct("Write")
                .field("ticket", ticket)
                .field("wire", &String::from_utf8_lossy(wire))
                .finish(),
            PeerEffect::Settle { id, result } => formatter
                .debug_struct("Settle")
                .field("id", id)
                .field("result", result)
                .finish(),
            PeerEffect::ServerRequest { id, method, params } => formatter
                .debug_struct("ServerRequest")
                .field("id", id)
                .field("method", method)
                .field("params", &params.as_ref().map(Value::to_json))
                .finish(),
            PeerEffect::Notification { method, params } => formatter
                .debug_struct("Notification")
                .field("method", method)
                .field("params", &params.as_ref().map(Value::to_json))
                .finish(),
            PeerEffect::Malformed { line } => formatter
                .debug_struct("Malformed")
                .field("line", line)
                .finish(),
            PeerEffect::ArmTimer { key, ms } => formatter
                .debug_struct("ArmTimer")
                .field("key", key)
                .field("ms", ms)
                .finish(),
            PeerEffect::CancelTimer { key } => formatter
                .debug_struct("CancelTimer")
                .field("key", key)
                .finish(),
            PeerEffect::Failed { message } => formatter
                .debug_struct("Failed")
                .field("message", message)
                .finish(),
        }
    }
}

/// What `RpcPeer::new` needs. `timeout_ms: None` leaves requests without a
/// deadline unless they pass one (`jsonrpc.ts`'s `null`); the default is 30 s.
pub struct PeerConfig {
    pub timeout_ms: Option<f64>,
    pub max_pending: usize,
    pub max_queued_bytes: usize,
}

impl Default for PeerConfig {
    fn default() -> PeerConfig {
        PeerConfig {
            timeout_ms: Some(DEFAULT_TIMEOUT_MS),
            max_pending: 256,
            max_queued_bytes: 32 * 1024 * 1024,
        }
    }
}

/// One request waiting for its answer.
struct Pending {
    facade: u64,
    method: String,
    timer: Option<String>,
    /// Its write's ticket while the queue still holds it.
    ticket: Option<u64>,
}

pub struct RpcPeer {
    config: PeerConfig,
    ids: RpcIds,
    writer: WriterQueue,
    pending: Vec<(RpcId, Pending)>,
    incoming: usize,
    /// The wire for every ticket the queue has not handed out yet.
    writes: HashMap<u64, Vec<u8>>,
    /// The first error that stopped requests; inputs still observe frames.
    stopped: Option<PeerError>,
    /// `close` ran: no later line reaches the state.
    closed: bool,
}

impl RpcPeer {
    pub fn new(config: PeerConfig) -> RpcPeer {
        RpcPeer {
            writer: WriterQueue::new(config.max_queued_bytes),
            config,
            ids: RpcIds::new(MAX_EXPLICIT_IDS),
            pending: Vec::new(),
            incoming: 0,
            writes: HashMap::new(),
            stopped: None,
            closed: false,
        }
    }

    /// `request` (`jsonrpc.ts:180`–`:238`): validate, reserve, then write.
    /// `timeout` overrides the config; both `None` means no deadline.
    pub fn request(
        &mut self,
        method: &str,
        params: &Value,
        id: u64,
        timeout: Option<f64>,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        if let Some(error) = &self.stopped {
            return Err(error.clone());
        }
        if self.pending.len() >= self.config.max_pending {
            return Err(PeerError::new("JSON-RPC pending request limit"));
        }
        let deadline = timeout.or(self.config.timeout_ms);
        if let Some(ms) = deadline
            && (!ms.is_finite() || ms < 0.0)
        {
            return Err(PeerError::new("Invalid timeoutMs"));
        }
        let request_id = self.ids.reserve(None)?;
        let value = request_value(&request_id, method, params);
        let wire = wire_bytes(&value);
        let mut effects = Vec::new();
        let timer = deadline.map(|ms| {
            let key = timer_key(&request_id);
            effects.push(PeerEffect::ArmTimer {
                key: key.clone(),
                ms,
            });
            key
        });
        if wire.len() > MAX_MESSAGE_BYTES {
            cancel_timer(timer.as_deref(), &mut effects);
            effects.push(PeerEffect::Settle {
                id,
                result: Err(PeerError::new("JSON-RPC message exceeded limit")),
            });
            return Ok(effects);
        }
        let mut pending = Pending {
            facade: id,
            method: method.to_owned(),
            timer: timer.clone(),
            ticket: None,
        };
        effects.push(PeerEffect::Frame {
            dir: Direction::Send,
            value,
        });
        match self.writer.enqueue(wire.len()) {
            Ok(ticket) => {
                pending.ticket = Some(ticket);
                self.pending.push((request_id, pending));
                self.writes.insert(ticket, wire);
                self.pump(&mut effects);
            }
            Err(error) => {
                cancel_timer(timer.as_deref(), &mut effects);
                effects.push(PeerEffect::Settle {
                    id,
                    result: Err(error.into()),
                });
            }
        }
        Ok(effects)
    }

    /// `notify` (`jsonrpc.ts:241`–`:247`): no correlation, write failures report.
    pub fn notify(&mut self, method: &str, params: &Value) -> Result<Vec<PeerEffect>, PeerError> {
        if let Some(error) = &self.stopped {
            return Err(error.clone());
        }
        let value = notification_value(method, params);
        let wire = wire_bytes(&value);
        let mut effects = Vec::new();
        if wire.len() > MAX_MESSAGE_BYTES {
            effects.push(PeerEffect::Failed {
                message: "JSON-RPC message exceeded limit".to_owned(),
            });
            return Ok(effects);
        }
        effects.push(PeerEffect::Frame {
            dir: Direction::Send,
            value,
        });
        match self.writer.enqueue(wire.len()) {
            Ok(ticket) => {
                self.writes.insert(ticket, wire);
                self.pump(&mut effects);
            }
            Err(error) => effects.push(PeerEffect::Failed {
                message: error.to_string(),
            }),
        }
        Ok(effects)
    }

    /// `#answer`'s success reply (`jsonrpc.ts:349`): `result ?? null`.
    pub fn answer(&mut self, server_id: &RpcId, result: &Value) -> Vec<PeerEffect> {
        self.finish_incoming();
        let mut map = Map::with_capacity(3);
        map.insert("jsonrpc", Value::from("2.0"));
        map.insert("id", id_value(server_id));
        map.insert("result", result.clone());
        self.send(Value::Object(map))
    }

    /// `#answer`'s failure reply: `-32601` for a missing method, `-32603` else.
    pub fn answer_error(&mut self, server_id: &RpcId, code: f64, message: &str) -> Vec<PeerEffect> {
        self.finish_incoming();
        let mut error = Map::with_capacity(2);
        error.insert("code", Value::from(code));
        error.insert("message", Value::from(message));
        let mut map = Map::with_capacity(3);
        map.insert("jsonrpc", Value::from("2.0"));
        map.insert("id", id_value(server_id));
        map.insert("error", Value::Object(error));
        self.send(Value::Object(map))
    }

    /// The default `onRequest`'s answer: `MethodNotFound("unhandled request")`.
    pub fn answer_not_found(&mut self, server_id: &RpcId) -> Vec<PeerEffect> {
        self.answer_error(server_id, METHOD_NOT_FOUND, UNHANDLED_REQUEST)
    }

    /// `rejectRequest` (`jsonrpc.ts:250`–`:254`): a lost reply settles only its
    /// own call. Empty when that call was already settled.
    pub fn reject_request(&mut self, id: &RpcId, error: PeerError) -> Vec<PeerEffect> {
        let mut effects = Vec::new();
        if let Some(pending) = self.take_pending(id) {
            self.settle_pending(pending, Err(error), &mut effects);
        }
        effects
    }

    /// One received line (`#receive`, `jsonrpc.ts:315`–`:347`).
    pub fn line(&mut self, line: &str) -> Vec<PeerEffect> {
        if self.closed {
            return Vec::new();
        }
        let Ok(value) = ace_json::parse(line) else {
            return vec![PeerEffect::Malformed {
                line: line.to_owned(),
            }];
        };
        let kind = jsonrpc::inspect(line);
        let mut effects = Vec::new();
        match kind {
            FrameKind::Unparsable => {
                return vec![PeerEffect::Malformed {
                    line: line.to_owned(),
                }];
            }
            FrameKind::Malformed => effects.push(PeerEffect::Malformed {
                line: line.to_owned(),
            }),
            FrameKind::Request => self.received_request(&value, &mut effects),
            FrameKind::Notification => {
                if let Some(method) = method_of(&value) {
                    effects.push(PeerEffect::Notification {
                        method,
                        params: params_of(&value),
                    });
                }
            }
            FrameKind::Response => self.received_response(&value, &mut effects),
        }
        effects.insert(
            0,
            PeerEffect::Frame {
                dir: Direction::Recv,
                value,
            },
        );
        effects
    }

    /// The write callback ran: release its bytes and hand out the next queued
    /// write, so at most one line is in flight (`rpc-writer.ts`).
    pub fn written(&mut self, ticket: u64) -> Vec<PeerEffect> {
        self.writer.written(ticket);
        let mut effects = Vec::new();
        self.pump(&mut effects);
        effects
    }

    /// An armed deadline fired (`rpc-timers.ts`): settle its call as timed out.
    pub fn timer(&mut self, key: &str) -> Vec<PeerEffect> {
        let Some(text) = key.strip_prefix("request:") else {
            return Vec::new();
        };
        let Ok(id) = jsonrpc::id_from_json(text) else {
            return Vec::new();
        };
        let Some(pending) = self.take_pending(&id) else {
            return Vec::new();
        };
        let message = format!("JSON-RPC request timed out: {}", pending.method);
        let mut effects = Vec::new();
        self.settle_pending(pending, Err(PeerError::new(message)), &mut effects);
        effects
    }

    /// `stopRequests` (`jsonrpc.ts:256`–`:263`): refuse work and settle every
    /// call, but keep observing final stdout frames until `close`.
    pub fn stop_requests(&mut self, reason: &str) -> Vec<PeerEffect> {
        self.stop(PeerError::new(reason))
    }

    /// Dispose the peer (`close`, `jsonrpc.ts:270`–`:278`): settle every pending
    /// call once and refuse later input.
    pub fn close(&mut self, reason: &str) -> Vec<PeerEffect> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        self.stop(PeerError::new(reason))
    }

    fn finish_incoming(&mut self) {
        self.incoming = self.incoming.saturating_sub(1);
    }

    fn received_request(&mut self, value: &Value, effects: &mut Vec<PeerEffect>) {
        // `#receive`: after the observer's frame, a stopped peer ignores requests.
        if self.stopped.is_some() {
            return;
        }
        if self.incoming >= MAX_INCOMING {
            let error = PeerError::new("JSON-RPC incoming request limit");
            let mut failed = self.stop(error);
            failed.push(PeerEffect::Failed {
                message: "JSON-RPC incoming request limit".to_owned(),
            });
            effects.append(&mut failed);
            return;
        }
        let (Some(id), Some(method)) = (id_of(value), method_of(value)) else {
            return;
        };
        self.incoming += 1;
        effects.push(PeerEffect::ServerRequest {
            id,
            method,
            params: params_of(value),
        });
    }

    fn received_response(&mut self, value: &Value, effects: &mut Vec<PeerEffect>) {
        let Some(id) = id_of(value) else {
            return;
        };
        let result = match value.get("error") {
            // `rpcErrorMessage`: the raw frame already reached the observer. Its
            // fallback is unreachable: ace-json writes any parsed value.
            Some(error) => Err(PeerError::new(error.to_json())),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        if let Some(pending) = self.take_pending(&id) {
            self.settle_pending(pending, result, effects);
        }
    }

    fn stop(&mut self, error: PeerError) -> Vec<PeerEffect> {
        self.stopped.get_or_insert_with(|| error.clone());
        let pending = std::mem::take(&mut self.pending);
        let mut effects = Vec::new();
        for (_, pending) in pending {
            self.settle_pending(pending, Err(error.clone()), &mut effects);
        }
        for ticket in self.writer.close() {
            self.writes.remove(&ticket);
        }
        effects
    }

    fn take_pending(&mut self, id: &RpcId) -> Option<Pending> {
        let at = self.pending.iter().position(|(key, _)| key == id)?;
        Some(self.pending.remove(at).1)
    }

    fn settle_pending(
        &mut self,
        pending: Pending,
        result: Result<Value, PeerError>,
        effects: &mut Vec<PeerEffect>,
    ) {
        if let Some(ticket) = pending.ticket
            && self.writer.cancel(ticket)
        {
            self.writes.remove(&ticket);
        }
        cancel_timer(pending.timer.as_deref(), effects);
        effects.push(PeerEffect::Settle {
            id: pending.facade,
            result,
        });
    }

    fn send(&mut self, value: Value) -> Vec<PeerEffect> {
        let mut effects = Vec::new();
        if self.stopped.is_some() {
            return effects;
        }
        let wire = wire_bytes(&value);
        if wire.len() > MAX_MESSAGE_BYTES {
            effects.push(PeerEffect::Failed {
                message: "JSON-RPC message exceeded limit".to_owned(),
            });
            return effects;
        }
        effects.push(PeerEffect::Frame {
            dir: Direction::Send,
            value,
        });
        match self.writer.enqueue(wire.len()) {
            Ok(ticket) => {
                self.writes.insert(ticket, wire);
                self.pump(&mut effects);
            }
            Err(error) => effects.push(PeerEffect::Failed {
                message: error.to_string(),
            }),
        }
        effects
    }

    fn pump(&mut self, effects: &mut Vec<PeerEffect>) {
        while let Some(ticket) = self.writer.claim() {
            let Some(wire) = self.writes.remove(&ticket) else {
                // Nothing left to write for it: release the slot and go on.
                self.writer.written(ticket);
                continue;
            };
            effects.push(PeerEffect::Write { wire, ticket });
            break;
        }
    }
}

fn cancel_timer(timer: Option<&str>, effects: &mut Vec<PeerEffect>) {
    if let Some(key) = timer {
        effects.push(PeerEffect::CancelTimer {
            key: key.to_owned(),
        });
    }
}

fn timer_key(id: &RpcId) -> String {
    format!("request:{}", jsonrpc::id_to_json(id))
}

fn id_of(value: &Value) -> Option<RpcId> {
    match value.get("id") {
        Some(Value::String(text)) => Some(RpcId::Text(text.clone())),
        Some(Value::Number(number)) => number.as_f64().map(RpcId::Number),
        _ => None,
    }
}

fn method_of(value: &Value) -> Option<JsString> {
    match value.get("method") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

fn params_of(value: &Value) -> Option<Value> {
    value.get("params").cloned()
}

fn id_value(id: &RpcId) -> Value {
    match id {
        RpcId::Text(text) => Value::String(text.clone()),
        RpcId::Number(number) => Value::from(*number),
    }
}

/// `JSON.stringify({jsonrpc, id, method, ...(params === undefined ? {} : {params})})`.
fn request_value(id: &RpcId, method: &str, params: &Value) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("id", id_value(id));
    map.insert("method", Value::from(method));
    if !params.is_null() {
        map.insert("params", params.clone());
    }
    Value::Object(map)
}

fn notification_value(method: &str, params: &Value) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("method", Value::from(method));
    if !params.is_null() {
        map.insert("params", params.clone());
    }
    Value::Object(map)
}

/// The line's UTF-8 bytes plus the newline, exactly what `#send` charges.
fn wire_bytes(value: &Value) -> Vec<u8> {
    let mut wire = value.to_json().into_bytes();
    wire.push(b'\n');
    wire
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_peer() -> RpcPeer {
        RpcPeer::new(PeerConfig::default())
    }

    fn object(entries: &[(&str, Value)]) -> Value {
        Value::from(
            entries
                .iter()
                .map(|(key, value)| (JsString::from(*key), value.clone()))
                .collect::<Vec<_>>(),
        )
    }

    fn call(
        peer: &mut RpcPeer,
        method: &str,
        params: &Value,
        id: u64,
        timeout: Option<f64>,
    ) -> Vec<PeerEffect> {
        match peer.request(method, params, id, timeout) {
            Ok(effects) => effects,
            Err(error) => panic!("request refused: {error}"),
        }
    }

    fn frames(effects: &[PeerEffect]) -> Vec<(Direction, String)> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                PeerEffect::Frame { dir, value } => Some((*dir, value.to_json())),
                _ => None,
            })
            .collect()
    }

    fn writes(effects: &[PeerEffect]) -> Vec<(u64, String)> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                PeerEffect::Write { wire, ticket } => {
                    Some((*ticket, String::from_utf8_lossy(wire).trim_end().to_owned()))
                }
                _ => None,
            })
            .collect()
    }

    fn timers(effects: &[PeerEffect]) -> Vec<String> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                PeerEffect::ArmTimer { key, .. } => Some(format!("arm:{key}")),
                PeerEffect::CancelTimer { key } => Some(format!("cancel:{key}")),
                _ => None,
            })
            .collect()
    }

    fn settles(effects: &[PeerEffect]) -> Vec<(u64, Result<String, String>)> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                PeerEffect::Settle { id, result } => Some((
                    *id,
                    match result {
                        Ok(value) => Ok(value.to_json()),
                        Err(error) => Err(error.message().to_owned()),
                    },
                )),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_request_writes_javascripts_exact_line_after_its_frame() {
        let mut peer = new_peer();
        let params = object(&[("threadId", Value::from("t"))]);
        let effects = call(&mut peer, "thread/read", &params, 7, Some(1_000.0));
        assert_eq!(
            frames(&effects),
            vec![(
                Direction::Send,
                r#"{"jsonrpc":"2.0","id":1,"method":"thread/read","params":{"threadId":"t"}}"#
                    .to_owned()
            )]
        );
        assert_eq!(timers(&effects), vec!["arm:request:1"]);
        assert_eq!(
            writes(&effects),
            vec![(
                0,
                r#"{"jsonrpc":"2.0","id":1,"method":"thread/read","params":{"threadId":"t"}}"#
                    .to_owned()
            )]
        );
    }

    #[test]
    fn a_response_settles_its_call_once_and_keeps_unknown_fields() {
        let mut peer = new_peer();
        call(&mut peer, "thread/read", &Value::Null, 7, Some(1_000.0));
        let line = r#"{"id":1,"result":{"ok":true},"extra":{"x":1}}"#;
        let effects = peer.line(line);
        assert_eq!(frames(&effects), vec![(Direction::Recv, line.to_owned())]);
        assert_eq!(timers(&effects), vec!["cancel:request:1"]);
        assert_eq!(
            settles(&effects),
            vec![(7, Ok(r#"{"ok":true}"#.to_owned()))]
        );
        assert_eq!(effects.len(), 3);

        let again = peer.line(line);
        assert_eq!(frames(&again), vec![(Direction::Recv, line.to_owned())]);
        assert!(settles(&again).is_empty());
    }

    #[test]
    fn an_error_response_settles_with_its_json_text() {
        let mut peer = new_peer();
        call(&mut peer, "x", &Value::Null, 4, None);
        let effects = peer.line(r#"{"id":1,"error":{"code":-32000,"message":"boom"}}"#);
        assert_eq!(
            settles(&effects),
            vec![(4, Err(r#"{"code":-32000,"message":"boom"}"#.to_owned()))]
        );
    }

    #[test]
    fn a_server_answer_keeps_the_id_type_and_lone_surrogates() {
        let cases = [
            ("7", "7"),
            (r#""7""#, r#""7""#),
            ("-0", "0"),
            (r#""a\ud800""#, r#""a\ud800""#),
        ];
        for (input, expected) in cases {
            let mut peer = new_peer();
            let line = format!(r#"{{"jsonrpc":"2.0","id":{input},"method":"x"}}"#);
            let effects = peer.line(&line);
            let id = match effects.iter().find_map(|effect| match effect {
                PeerEffect::ServerRequest { id, .. } => Some(id.clone()),
                _ => None,
            }) {
                Some(id) => id,
                None => panic!("no server request for {input}"),
            };
            let answered = peer.answer(&id, &Value::Null);
            let expected = format!(r#"{{"jsonrpc":"2.0","id":{expected},"result":null}}"#);
            assert_eq!(writes(&answered), vec![(0, expected)]);
        }
    }

    #[test]
    fn unknown_methods_and_fields_are_kept_raw() {
        let mut peer = new_peer();
        let note = r#"{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"t"},"zeta":1},"extra":{"kept":[1,2]}}"#;
        let effects = peer.line(note);
        assert_eq!(frames(&effects), vec![(Direction::Recv, note.to_owned())]);
        match &effects[1] {
            PeerEffect::Notification { method, params } => {
                assert_eq!(method.as_str(), "thread/started");
                assert_eq!(
                    params.as_ref().map(Value::to_json).as_deref(),
                    Some(r#"{"thread":{"id":"t"},"zeta":1}"#)
                );
            }
            _ => panic!("expected a notification"),
        }

        let request = r#"{"id":"s1","method":"future/method","params":{"a":1},"future":{"b":2}}"#;
        let effects = peer.line(request);
        assert_eq!(
            frames(&effects),
            vec![(Direction::Recv, request.to_owned())]
        );
        match &effects[1] {
            PeerEffect::ServerRequest { method, params, .. } => {
                assert_eq!(method.as_str(), "future/method");
                assert_eq!(
                    params.as_ref().map(Value::to_json).as_deref(),
                    Some(r#"{"a":1}"#)
                );
            }
            _ => panic!("expected a server request"),
        }
    }

    #[test]
    fn absent_params_stay_absent_on_the_wire_and_in_effects() {
        let mut peer = new_peer();
        let request = call(&mut peer, "initialized", &Value::Null, 1, None);
        assert_eq!(
            writes(&request),
            vec![(
                0,
                r#"{"jsonrpc":"2.0","id":1,"method":"initialized"}"#.to_owned()
            )]
        );
        let note = match peer.notify("ready", &Value::Null) {
            Ok(effects) => effects,
            Err(error) => panic!("{error}"),
        };
        assert!(writes(&note).is_empty());
        let released = peer.written(0);
        assert_eq!(
            writes(&released),
            vec![(1, r#"{"jsonrpc":"2.0","method":"ready"}"#.to_owned())]
        );

        let line = r#"{"id":"s2","method":"no/params"}"#;
        let effects = peer.line(line);
        match &effects[1] {
            PeerEffect::ServerRequest { params, .. } => assert!(params.is_none()),
            _ => panic!("expected a server request"),
        }
    }

    #[test]
    fn unparsable_and_non_envelope_lines_are_malformed_never_fatal() {
        for (line, expected_frames) in [
            ("not json", 0),
            ("[1,2]", 1),
            (r#"{"id":1}"#, 1),
            (r#"{"id":1,"method":2}"#, 1),
        ] {
            let mut peer = new_peer();
            let effects = peer.line(line);
            assert_eq!(frames(&effects).len(), expected_frames, "{line}");
            assert!(matches!(
                effects.last(),
                Some(PeerEffect::Malformed { line: kept }) if kept == line
            ));
            assert!(peer.request("x", &Value::Null, 1, None).is_ok());
        }
    }

    #[test]
    fn a_timeout_settles_once_with_jsonrpc_ts_message() {
        let mut peer = new_peer();
        let effects = call(&mut peer, "slow", &Value::Null, 3, Some(5.0));
        let key = match &effects[0] {
            PeerEffect::ArmTimer { key, .. } => key.clone(),
            other => panic!("expected a timer, got {other:?}"),
        };
        let timed = peer.timer(&key);
        assert_eq!(
            settles(&timed),
            vec![(3, Err("JSON-RPC request timed out: slow".to_owned()))]
        );
        assert!(peer.timer(&key).is_empty());
        let late = peer.line(r#"{"id":1,"result":1}"#);
        assert_eq!(frames(&late).len(), 1);
        assert!(settles(&late).is_empty());
    }

    #[test]
    fn the_pending_bound_refuses_before_reserving_a_write() {
        let mut peer = RpcPeer::new(PeerConfig {
            max_pending: 1,
            ..PeerConfig::default()
        });
        call(&mut peer, "first", &Value::Null, 1, None);
        match peer.request("second", &Value::Null, 2, None) {
            Err(error) => assert_eq!(error.message(), "JSON-RPC pending request limit"),
            Ok(_) => panic!("the second request was admitted"),
        }
        let settled = peer.line(r#"{"id":1,"result":null}"#);
        assert_eq!(settles(&settled).len(), 1);
        call(&mut peer, "second", &Value::Null, 2, None);
    }

    #[test]
    fn a_rejected_reply_settles_only_that_call() {
        let mut peer = new_peer();
        call(&mut peer, "one", &Value::Null, 10, None);
        call(&mut peer, "two", &Value::Null, 11, None);
        let rejected =
            peer.reject_request(&RpcId::Number(1.0), PeerError::new("JSON-RPC reply lost"));
        assert_eq!(
            settles(&rejected),
            vec![(10, Err("JSON-RPC reply lost".to_owned()))]
        );
        let other = peer.line(r#"{"id":2,"result":"kept"}"#);
        assert_eq!(settles(&other), vec![(11, Ok(r#""kept""#.to_owned()))]);
        assert!(
            peer.reject_request(&RpcId::Number(1.0), PeerError::new("again"))
                .is_empty()
        );
    }

    #[test]
    fn a_settled_call_withdraws_its_queued_write() {
        let mut peer = new_peer();
        call(&mut peer, "one", &Value::Null, 1, None);
        call(&mut peer, "two", &Value::Null, 2, None);
        let timed = peer.timer("request:2");
        assert_eq!(
            settles(&timed),
            vec![(2, Err("JSON-RPC request timed out: two".to_owned()))]
        );
        assert!(writes(&peer.written(0)).is_empty());
    }

    #[test]
    fn stop_requests_keeps_observing_final_frames() {
        let mut peer = new_peer();
        call(&mut peer, "mine", &Value::Null, 1, Some(1_000.0));
        let stopped = peer.stop_requests("process exited");
        assert_eq!(
            settles(&stopped),
            vec![(1, Err("process exited".to_owned()))]
        );
        let note = peer.line(r#"{"method":"final","params":{"x":1}}"#);
        assert_eq!(frames(&note).len(), 1);
        assert!(matches!(note.last(), Some(PeerEffect::Notification { .. })));
        assert_eq!(peer.line(r#"{"id":9,"method":"still"}"#).len(), 1);
        match peer.request("after", &Value::Null, 2, None) {
            Err(error) => assert_eq!(error.message(), "process exited"),
            Ok(_) => panic!("a stopped peer admitted a request"),
        }
        assert!(peer.close("process exited").is_empty());
        assert!(peer.line(r#"{"method":"too/late"}"#).is_empty());
    }

    #[test]
    fn close_settles_every_pending_call_once_and_refuses_later_input() {
        let mut peer = new_peer();
        call(&mut peer, "one", &Value::Null, 1, Some(1_000.0));
        call(&mut peer, "two", &Value::Null, 2, Some(1_000.0));
        let closed = peer.close("process exited");
        assert_eq!(
            settles(&closed),
            vec![
                (1, Err("process exited".to_owned())),
                (2, Err("process exited".to_owned())),
            ]
        );
        assert_eq!(
            timers(&closed),
            vec!["cancel:request:1", "cancel:request:2"]
        );
        assert!(peer.close("again").is_empty());
        let late = peer.line(r#"{"id":1,"result":1}"#);
        assert!(late.is_empty());
        match peer.request("after", &Value::Null, 3, None) {
            Err(error) => assert_eq!(error.message(), "process exited"),
            Ok(_) => panic!("a closed peer admitted a request"),
        }
    }

    #[test]
    fn the_incoming_bound_stops_requests_and_reports() {
        let mut peer = new_peer();
        call(&mut peer, "mine", &Value::Null, 9, Some(1_000.0));
        for at in 1..=MAX_INCOMING {
            let line = format!(r#"{{"id":{at},"method":"server"}}"#);
            assert_eq!(peer.line(&line).len(), 2);
        }
        let over = peer.line(r#"{"id":999,"method":"server"}"#);
        assert_eq!(frames(&over).len(), 1);
        assert_eq!(
            settles(&over),
            vec![(9, Err("JSON-RPC incoming request limit".to_owned()))]
        );
        assert!(matches!(
            over.last(),
            Some(PeerEffect::Failed { message }) if message == "JSON-RPC incoming request limit"
        ));
        assert_eq!(peer.line(r#"{"id":1000,"method":"server"}"#).len(), 1);
    }

    #[test]
    fn method_not_found_answers_with_jsonrpc_ts_strings() {
        let mut peer = new_peer();
        let request = peer.line(r#"{"id":"s9","method":"missing","params":{}}"#);
        let id = match request.iter().find_map(|effect| match effect {
            PeerEffect::ServerRequest { id, .. } => Some(id.clone()),
            _ => None,
        }) {
            Some(id) => id,
            None => panic!("no server request"),
        };
        let answered = peer.answer_not_found(&id);
        assert_eq!(
            writes(&answered),
            vec![(
                0,
                r#"{"jsonrpc":"2.0","id":"s9","error":{"code":-32601,"message":"unhandled request"}}"#
                    .to_owned()
            )]
        );
    }

    #[test]
    fn an_oversized_message_settles_with_the_message_limit() {
        let mut peer = new_peer();
        let params = object(&[("blob", Value::from("x".repeat(MAX_MESSAGE_BYTES)))]);
        let effects = call(&mut peer, "x", &params, 1, Some(1_000.0));
        assert!(writes(&effects).is_empty());
        assert_eq!(timers(&effects), vec!["arm:request:1", "cancel:request:1"]);
        assert_eq!(
            settles(&effects),
            vec![(1, Err("JSON-RPC message exceeded limit".to_owned()))]
        );
    }

    #[test]
    fn the_queue_bound_refuses_with_rpc_writers_message() {
        let mut peer = RpcPeer::new(PeerConfig {
            max_queued_bytes: 8,
            ..PeerConfig::default()
        });
        let effects = call(&mut peer, "x", &Value::Null, 1, Some(1_000.0));
        assert_eq!(frames(&effects).len(), 1);
        assert!(writes(&effects).is_empty());
        assert_eq!(
            settles(&effects),
            vec![(1, Err("JSON-RPC write queue exceeded limit".to_owned()))]
        );
    }

    #[test]
    fn only_one_write_is_in_flight_until_the_pipe_acknowledges_it() {
        let mut peer = new_peer();
        let first = match peer.notify("initialized", &Value::Null) {
            Ok(effects) => effects,
            Err(error) => panic!("{error}"),
        };
        let second = match peer.notify("second", &Value::Null) {
            Ok(effects) => effects,
            Err(error) => panic!("{error}"),
        };
        assert_eq!(writes(&first).len(), 1);
        assert_eq!(writes(&first)[0].0, 0);
        assert!(writes(&second).is_empty());
        let released = peer.written(0);
        assert_eq!(
            writes(&released),
            vec![(1, r#"{"jsonrpc":"2.0","method":"second"}"#.to_owned())]
        );
    }
}
