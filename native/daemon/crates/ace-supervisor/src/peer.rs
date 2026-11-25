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
//! A `PeerOwner` carries the pipe's id reservations (`rpc-owner.ts`), so a
//! replacement peer on the same stdin keeps every id the retired one reserved;
//! each peer owns its write queue. A timeout, a rejected reply and a close each
//! settle a pending call exactly once: settling removes it before the effects
//! are built, so a later response or a second close finds nothing.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex};

use ace_json::{JsString, Map, Value};

use crate::budget::StreamError;
use crate::jsonrpc::{self, FrameKind, RpcId, RpcIds, WriterQueue};

/// `maxMessageBytes`' default (`jsonrpc.ts:151`).
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// `maxIncomingRequests`' default (`jsonrpc.ts:149`); shared Codex hosts use 512.
const DEFAULT_MAX_INCOMING: usize = 128;
/// `maxQueuedBytes`' default (`jsonrpc.ts:159`).
const DEFAULT_MAX_QUEUED_BYTES: usize = 32 * 1024 * 1024;
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
/// default deadline (`jsonrpc.ts`'s `null`); the default is 30 s.
pub struct PeerConfig {
    pub timeout_ms: Option<f64>,
    pub max_pending: usize,
    pub max_queued_bytes: usize,
    /// `maxIncomingRequests`: 128 for a dedicated pipe, 512 for a shared host.
    pub max_incoming: usize,
}

impl Default for PeerConfig {
    fn default() -> PeerConfig {
        PeerConfig {
            timeout_ms: Some(DEFAULT_TIMEOUT_MS),
            max_pending: 256,
            max_queued_bytes: 32 * 1024 * 1024,
            max_incoming: DEFAULT_MAX_INCOMING,
        }
    }
}

/// `RequestOptions.timeoutMs`: absent, an explicit `null`, or a value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Timeout {
    Default,
    Disabled,
    After(f64),
}

/// What one stdin owns (`rpc-owner.ts:14`): the id reservations and the bounded
/// write queue. A replacement peer shares both, so a retired id is never reused,
/// an old reply cannot claim a new call, and its first write waits for the old
/// in-flight write's `written`.
#[derive(Clone)]
pub struct PeerOwner {
    ids: Arc<Mutex<RpcIds>>,
    writer: Arc<Mutex<WriterQueue>>,
}

impl PeerOwner {
    /// The first peer on a pipe fixes the queue's byte cap; later peers reuse it.
    pub fn new(max_queued_bytes: usize) -> PeerOwner {
        PeerOwner {
            ids: Arc::new(Mutex::new(RpcIds::new(MAX_EXPLICIT_IDS))),
            writer: Arc::new(Mutex::new(WriterQueue::new(max_queued_bytes))),
        }
    }

    fn reserve(&self, id: Option<RpcId>) -> Result<RpcId, StreamError> {
        let mut ids = match self.ids.lock() {
            Ok(ids) => ids,
            Err(poisoned) => poisoned.into_inner(),
        };
        ids.reserve(id)
    }

    fn enqueue(&self, bytes: usize) -> Result<u64, StreamError> {
        match self.writer.lock() {
            Ok(mut writer) => writer.enqueue(bytes),
            Err(poisoned) => poisoned.into_inner().enqueue(bytes),
        }
    }

    fn claim(&self) -> Option<u64> {
        match self.writer.lock() {
            Ok(mut writer) => writer.claim(),
            Err(poisoned) => poisoned.into_inner().claim(),
        }
    }

    fn written(&self, ticket: u64) {
        match self.writer.lock() {
            Ok(mut writer) => writer.written(ticket),
            Err(poisoned) => poisoned.into_inner().written(ticket),
        }
    }

    fn cancel(&self, ticket: u64) -> bool {
        match self.writer.lock() {
            Ok(mut writer) => writer.cancel(ticket),
            Err(poisoned) => poisoned.into_inner().cancel(ticket),
        }
    }
}

impl Default for PeerOwner {
    fn default() -> PeerOwner {
        PeerOwner::new(DEFAULT_MAX_QUEUED_BYTES)
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
    owner: PeerOwner,
    pending: Vec<(RpcId, Pending)>,
    incoming: usize,
    /// Reply writes still holding an incoming slot until `written`.
    replies: HashSet<u64>,
    /// The wire for every ticket the queue has not handed out yet.
    writes: HashMap<u64, Vec<u8>>,
    /// The first error that stopped requests; inputs still observe frames.
    stopped: Option<PeerError>,
    /// `close` ran: no later line reaches the state.
    closed: bool,
}

impl RpcPeer {
    pub fn new(config: PeerConfig) -> RpcPeer {
        let owner = PeerOwner::new(config.max_queued_bytes);
        RpcPeer::with_owner(config, owner)
    }

    /// A peer over an existing pipe's owner: a replacement keeps the ids and the
    /// write queue (in-flight bytes and the one active write) the retired peer
    /// left. The first peer's `max_queued_bytes` fixed the queue's cap.
    pub fn with_owner(config: PeerConfig, owner: PeerOwner) -> RpcPeer {
        RpcPeer {
            config,
            owner,
            pending: Vec::new(),
            incoming: 0,
            replies: HashSet::new(),
            writes: HashMap::new(),
            stopped: None,
            closed: false,
        }
    }

    /// `request` (`jsonrpc.ts:180`–`:238`): validate, reserve, then write.
    /// `params: None` omits the field, as `undefined` does; a `Value::Null`
    /// inside `Some` is the explicit `params: null`.
    pub fn request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        self.enqueue_request(method, params, id, timeout, None)
    }

    /// `request` with `options.id`: the wire id is exact (`"7"` stays a string).
    pub fn request_with_id(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
        wire_id: RpcId,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        self.enqueue_request(method, params, id, timeout, Some(wire_id))
    }

    fn enqueue_request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
        wire_id: Option<RpcId>,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        if let Some(error) = &self.stopped {
            return Err(error.clone());
        }
        if self.pending.len() >= self.config.max_pending {
            return Err(PeerError::new("JSON-RPC pending request limit"));
        }
        let deadline = match timeout {
            Timeout::Default => self.config.timeout_ms,
            Timeout::Disabled => None,
            Timeout::After(ms) => Some(ms),
        };
        if let Some(ms) = deadline
            && (!ms.is_finite() || ms < 0.0)
        {
            return Err(PeerError::new("Invalid timeoutMs"));
        }
        let request_id = self.owner.reserve(wire_id)?;
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
        match self.owner.enqueue(wire.len()) {
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
    pub fn notify(
        &mut self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Vec<PeerEffect>, PeerError> {
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
        match self.owner.enqueue(wire.len()) {
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
        let mut map = Map::with_capacity(3);
        map.insert("jsonrpc", Value::from("2.0"));
        map.insert("id", id_value(server_id));
        map.insert("result", result.clone());
        self.send_reply(Value::Object(map))
    }

    /// `#answer`'s failure reply: `-32601` for a missing method, `-32603` else.
    pub fn answer_error(&mut self, server_id: &RpcId, code: f64, message: &str) -> Vec<PeerEffect> {
        let mut error = Map::with_capacity(2);
        error.insert("code", Value::from(code));
        error.insert("message", Value::from(message));
        let mut map = Map::with_capacity(3);
        map.insert("jsonrpc", Value::from("2.0"));
        map.insert("id", id_value(server_id));
        map.insert("error", Value::Object(error));
        self.send_reply(Value::Object(map))
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
        self.owner.written(ticket);
        if self.replies.remove(&ticket) {
            self.finish_incoming();
        }
        let mut effects = Vec::new();
        self.pump(&mut effects);
        effects
    }

    /// An armed deadline fired (`rpc-timers.ts`): settle its call as timed out.
    pub fn timer(&mut self, key: &str) -> Vec<PeerEffect> {
        // Only an armed key settles a call: a disabled deadline has no timer.
        let at = self
            .pending
            .iter()
            .position(|(_, pending)| pending.timer.as_deref() == Some(key));
        let Some(at) = at else {
            return Vec::new();
        };
        let pending = self.pending.remove(at).1;
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
        if self.incoming >= self.config.max_incoming {
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
        // A cancelled reply's send rejects, so its `finally` releases the slot.
        let replies = self.replies.len();
        self.replies.clear();
        self.incoming = self.incoming.saturating_sub(replies);
        let pending = std::mem::take(&mut self.pending);
        let mut effects = Vec::new();
        for (_, pending) in pending {
            self.settle_pending(pending, Err(error.clone()), &mut effects);
        }
        // Cancel this peer's queued writes; the shared queue stays open for a
        // replacement peer on the same stdin.
        let queued: Vec<u64> = self.writes.keys().copied().collect();
        for ticket in queued {
            self.owner.cancel(ticket);
        }
        self.writes.clear();
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
            && self.owner.cancel(ticket)
        {
            self.writes.remove(&ticket);
        }
        cancel_timer(pending.timer.as_deref(), effects);
        effects.push(PeerEffect::Settle {
            id: pending.facade,
            result,
        });
    }

    /// A server request's reply holds its incoming slot until `written`, as
    /// `#answer` decrements in its `finally` after the send resolves.
    fn send_reply(&mut self, value: Value) -> Vec<PeerEffect> {
        let mut effects = Vec::new();
        if self.stopped.is_some() {
            self.finish_incoming();
            return effects;
        }
        let wire = wire_bytes(&value);
        if wire.len() > MAX_MESSAGE_BYTES {
            self.finish_incoming();
            effects.push(PeerEffect::Failed {
                message: "JSON-RPC message exceeded limit".to_owned(),
            });
            return effects;
        }
        effects.push(PeerEffect::Frame {
            dir: Direction::Send,
            value,
        });
        match self.owner.enqueue(wire.len()) {
            Ok(ticket) => {
                self.writes.insert(ticket, wire);
                self.replies.insert(ticket);
                self.pump(&mut effects);
            }
            Err(error) => {
                self.finish_incoming();
                effects.push(PeerEffect::Failed {
                    message: error.to_string(),
                });
            }
        }
        effects
    }

    fn pump(&mut self, effects: &mut Vec<PeerEffect>) {
        while let Some(ticket) = self.owner.claim() {
            let Some(wire) = self.writes.remove(&ticket) else {
                // Nothing left to write for it: release the slot and go on.
                self.owner.written(ticket);
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
fn request_value(id: &RpcId, method: &str, params: Option<&Value>) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("id", id_value(id));
    map.insert("method", Value::from(method));
    if let Some(params) = params {
        map.insert("params", params.clone());
    }
    Value::Object(map)
}

fn notification_value(method: &str, params: Option<&Value>) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("method", Value::from(method));
    if let Some(params) = params {
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
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
    ) -> Vec<PeerEffect> {
        match peer.request(method, params, id, timeout) {
            Ok(effects) => effects,
            Err(error) => panic!("request refused: {error}"),
        }
    }

    fn order(effects: &[PeerEffect]) -> Vec<String> {
        effects
            .iter()
            .map(|effect| match effect {
                PeerEffect::Frame { dir, .. } => match dir {
                    Direction::Send => "frame:send".to_owned(),
                    Direction::Recv => "frame:recv".to_owned(),
                },
                PeerEffect::Write { ticket, .. } => format!("write:{ticket}"),
                PeerEffect::Settle { id, .. } => format!("settle:{id}"),
                PeerEffect::ServerRequest { id, .. } => {
                    format!("server:{}", jsonrpc::id_to_json(id))
                }
                PeerEffect::Notification { method, .. } => {
                    format!("notify:{}", method.as_str())
                }
                PeerEffect::Malformed { .. } => "malformed".to_owned(),
                PeerEffect::ArmTimer { key, .. } => format!("arm:{key}"),
                PeerEffect::CancelTimer { key } => format!("cancel:{key}"),
                PeerEffect::Failed { .. } => "failed".to_owned(),
            })
            .collect()
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

    fn server_id(effects: &[PeerEffect]) -> RpcId {
        match effects.iter().find_map(|effect| match effect {
            PeerEffect::ServerRequest { id, .. } => Some(id.clone()),
            _ => None,
        }) {
            Some(id) => id,
            None => panic!("no server request"),
        }
    }

    #[test]
    fn a_request_writes_javascripts_exact_line_after_its_frame() {
        let mut peer = new_peer();
        let params = object(&[("threadId", Value::from("t"))]);
        let effects = call(
            &mut peer,
            "thread/read",
            Some(&params),
            7,
            Timeout::After(1_000.0),
        );
        assert_eq!(
            order(&effects),
            vec!["arm:request:1", "frame:send", "write:0"]
        );
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
        call(&mut peer, "thread/read", None, 7, Timeout::After(1_000.0));
        let line = r#"{"id":1,"result":{"ok":true},"extra":{"x":1}}"#;
        let effects = peer.line(line);
        assert_eq!(
            order(&effects),
            vec!["frame:recv", "cancel:request:1", "settle:7"]
        );
        assert_eq!(frames(&effects), vec![(Direction::Recv, line.to_owned())]);
        assert_eq!(
            settles(&effects),
            vec![(7, Ok(r#"{"ok":true}"#.to_owned()))]
        );

        let again = peer.line(line);
        assert_eq!(order(&again), vec!["frame:recv"]);
        assert!(settles(&again).is_empty());
    }

    #[test]
    fn an_error_response_settles_with_its_json_text() {
        let mut peer = new_peer();
        call(&mut peer, "x", None, 4, Timeout::Disabled);
        let effects = peer.line(r#"{"id":1,"error":{"code":-32000,"message":"boom"}}"#);
        assert_eq!(order(&effects), vec!["frame:recv", "settle:4"]);
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
            let id = server_id(&effects);
            let answered = peer.answer(&id, &Value::Null);
            assert_eq!(order(&answered), vec!["frame:send", "write:0"]);
            let expected = format!(r#"{{"jsonrpc":"2.0","id":{expected},"result":null}}"#);
            assert_eq!(writes(&answered), vec![(0, expected)]);
        }
    }

    #[test]
    fn unknown_methods_and_fields_are_kept_raw() {
        let mut peer = new_peer();
        let note = r#"{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"t"},"zeta":1},"extra":{"kept":[1,2]}}"#;
        let effects = peer.line(note);
        assert_eq!(order(&effects), vec!["frame:recv", "notify:thread/started"]);
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
        assert_eq!(order(&effects), vec!["frame:recv", "server:\"s1\""]);
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
    fn absent_params_and_explicit_null_are_different() {
        let cases = [
            (
                None,
                r#"{"jsonrpc":"2.0","id":1,"method":"ready"}"#.to_owned(),
            ),
            (
                Some(Value::Null),
                r#"{"jsonrpc":"2.0","id":1,"method":"ready","params":null}"#.to_owned(),
            ),
        ];
        for (params, expected) in cases {
            let mut peer = new_peer();
            let effects = call(&mut peer, "ready", params.as_ref(), 1, Timeout::Disabled);
            assert_eq!(order(&effects), vec!["frame:send", "write:0"]);
            assert_eq!(writes(&effects), vec![(0, expected)]);
        }

        let mut peer = new_peer();
        let effects = peer.line(r#"{"id":"s2","method":"no/params"}"#);
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
            assert!(peer.request("x", None, 1, Timeout::Disabled).is_ok());
        }
    }

    #[test]
    fn a_timeout_settles_once_with_jsonrpc_ts_message() {
        let mut peer = new_peer();
        let effects = call(&mut peer, "slow", None, 3, Timeout::After(5.0));
        assert_eq!(
            order(&effects),
            vec!["arm:request:1", "frame:send", "write:0"]
        );
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
        assert_eq!(order(&late), vec!["frame:recv"]);
    }

    #[test]
    fn the_pending_bound_refuses_before_reserving_a_write() {
        let mut peer = RpcPeer::new(PeerConfig {
            max_pending: 1,
            ..PeerConfig::default()
        });
        call(&mut peer, "first", None, 1, Timeout::Disabled);
        match peer.request("second", None, 2, Timeout::Disabled) {
            Err(error) => assert_eq!(error.message(), "JSON-RPC pending request limit"),
            Ok(_) => panic!("the second request was admitted"),
        }
        let settled = peer.line(r#"{"id":1,"result":null}"#);
        assert_eq!(settles(&settled).len(), 1);
        call(&mut peer, "second", None, 2, Timeout::Disabled);
    }

    #[test]
    fn a_rejected_reply_settles_only_that_call() {
        let mut peer = new_peer();
        call(&mut peer, "one", None, 10, Timeout::Disabled);
        call(&mut peer, "two", None, 11, Timeout::Disabled);
        let rejected =
            peer.reject_request(&RpcId::Number(1.0), PeerError::new("JSON-RPC reply lost"));
        assert_eq!(order(&rejected), vec!["settle:10"]);
        let other = peer.line(r#"{"id":2,"result":"kept"}"#);
        assert_eq!(order(&other), vec!["frame:recv", "settle:11"]);
        assert!(
            peer.reject_request(&RpcId::Number(1.0), PeerError::new("again"))
                .is_empty()
        );
    }

    #[test]
    fn a_settled_call_withdraws_its_queued_write() {
        let mut peer = new_peer();
        call(&mut peer, "one", None, 1, Timeout::Disabled);
        let armed = call(&mut peer, "two", None, 2, Timeout::After(5.0));
        let key = match &armed[0] {
            PeerEffect::ArmTimer { key, .. } => key.clone(),
            other => panic!("expected a timer, got {other:?}"),
        };
        let timed = peer.timer(&key);
        assert_eq!(order(&timed), vec!["cancel:request:2", "settle:2"]);
        assert_eq!(
            settles(&timed),
            vec![(2, Err("JSON-RPC request timed out: two".to_owned()))]
        );
        assert!(writes(&peer.written(0)).is_empty());
    }

    #[test]
    fn a_disabled_call_ignores_a_timer_key() {
        let mut peer = new_peer();
        call(&mut peer, "free", None, 1, Timeout::Disabled);
        assert!(peer.timer("request:1").is_empty());
        let reply = peer.line(r#"{"id":1,"result":null}"#);
        assert_eq!(order(&reply), vec!["frame:recv", "settle:1"]);
    }

    #[test]
    fn stop_requests_keeps_observing_final_frames() {
        let mut peer = new_peer();
        call(&mut peer, "mine", None, 1, Timeout::After(1_000.0));
        let stopped = peer.stop_requests("process exited");
        assert_eq!(order(&stopped), vec!["cancel:request:1", "settle:1"]);
        let note = peer.line(r#"{"method":"final","params":{"x":1}}"#);
        assert_eq!(order(&note), vec!["frame:recv", "notify:final"]);
        assert_eq!(
            order(&peer.line(r#"{"id":9,"method":"still"}"#)),
            vec!["frame:recv"]
        );
        match peer.request("after", None, 2, Timeout::Disabled) {
            Err(error) => assert_eq!(error.message(), "process exited"),
            Ok(_) => panic!("a stopped peer admitted a request"),
        }
        assert!(peer.close("process exited").is_empty());
        assert!(peer.line(r#"{"method":"too/late"}"#).is_empty());
    }

    #[test]
    fn close_settles_every_pending_call_once_and_refuses_later_input() {
        let mut peer = new_peer();
        call(&mut peer, "one", None, 1, Timeout::After(1_000.0));
        call(&mut peer, "two", None, 2, Timeout::After(1_000.0));
        let closed = peer.close("process exited");
        assert_eq!(
            order(&closed),
            vec![
                "cancel:request:1",
                "settle:1",
                "cancel:request:2",
                "settle:2"
            ]
        );
        assert!(peer.close("again").is_empty());
        assert!(peer.line(r#"{"id":1,"result":1}"#).is_empty());
        match peer.request("after", None, 3, Timeout::Disabled) {
            Err(error) => assert_eq!(error.message(), "process exited"),
            Ok(_) => panic!("a closed peer admitted a request"),
        }
    }

    #[test]
    fn an_incoming_slot_is_held_until_the_reply_is_written() {
        let config = PeerConfig {
            max_incoming: 1,
            ..PeerConfig::default()
        };
        let mut held = RpcPeer::new(PeerConfig {
            max_incoming: 1,
            ..PeerConfig::default()
        });
        let first = held.line(r#"{"id":1,"method":"server"}"#);
        held.answer_error(&server_id(&first), INTERNAL_ERROR, "boom");
        let over = held.line(r#"{"id":2,"method":"server"}"#);
        assert_eq!(order(&over), vec!["frame:recv", "failed"]);
        assert!(matches!(
            over.last(),
            Some(PeerEffect::Failed { message }) if message == "JSON-RPC incoming request limit"
        ));

        let mut released = RpcPeer::new(config);
        let first = released.line(r#"{"id":1,"method":"server"}"#);
        released.answer(&server_id(&first), &Value::Null);
        released.written(0);
        let next = released.line(r#"{"id":2,"method":"server"}"#);
        assert_eq!(order(&next), vec!["frame:recv", "server:2"]);
    }

    #[test]
    fn method_not_found_answers_with_jsonrpc_ts_strings() {
        let mut peer = new_peer();
        let request = peer.line(r#"{"id":"s9","method":"missing","params":{}}"#);
        let id = server_id(&request);
        let answered = peer.answer_not_found(&id);
        assert_eq!(order(&answered), vec!["frame:send", "write:0"]);
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
        let params = object(&[("blob", Value::from("x".repeat(16 * 1024 * 1024)))]);
        let effects = call(&mut peer, "x", Some(&params), 1, Timeout::After(1_000.0));
        assert_eq!(
            order(&effects),
            vec!["arm:request:1", "cancel:request:1", "settle:1"]
        );
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
        let effects = call(&mut peer, "x", None, 1, Timeout::Disabled);
        assert_eq!(order(&effects), vec!["frame:send", "settle:1"]);
        assert_eq!(
            settles(&effects),
            vec![(1, Err("JSON-RPC write queue exceeded limit".to_owned()))]
        );
    }

    #[test]
    fn only_one_write_is_in_flight_until_the_pipe_acknowledges_it() {
        let mut peer = new_peer();
        let first = match peer.notify("initialized", None) {
            Ok(effects) => effects,
            Err(error) => panic!("{error}"),
        };
        let second = match peer.notify("second", Some(&Value::Null)) {
            Ok(effects) => effects,
            Err(error) => panic!("{error}"),
        };
        assert_eq!(order(&first), vec!["frame:send", "write:0"]);
        assert_eq!(order(&second), vec!["frame:send"]);
        let released = peer.written(0);
        assert_eq!(
            writes(&released),
            vec![(
                1,
                r#"{"jsonrpc":"2.0","method":"second","params":null}"#.to_owned()
            )]
        );
    }

    #[test]
    fn explicit_ids_keep_their_type_and_reject_reuse() {
        let cases = [
            (
                RpcId::Text(JsString::from("abc")),
                r#"{"jsonrpc":"2.0","id":"abc","method":"x"}"#,
            ),
            (
                RpcId::Number(7.0),
                r#"{"jsonrpc":"2.0","id":7,"method":"x"}"#,
            ),
        ];
        for (wire_id, expected) in cases {
            let mut peer = new_peer();
            let effects = match peer.request_with_id("x", None, 1, Timeout::Disabled, wire_id) {
                Ok(effects) => effects,
                Err(error) => panic!("{error}"),
            };
            assert_eq!(writes(&effects), vec![(0, expected.to_owned())]);
        }

        let mut peer = new_peer();
        call(&mut peer, "generated", None, 1, Timeout::Disabled);
        match peer.request_with_id("x", None, 2, Timeout::Disabled, RpcId::Number(1.0)) {
            Err(error) => assert_eq!(error.message(), "Request id already used"),
            Ok(_) => panic!("a generated id was reused"),
        }
        match peer.request_with_id(
            "x",
            None,
            3,
            Timeout::Disabled,
            RpcId::Text(JsString::from("5")),
        ) {
            Ok(_) => {}
            Err(error) => panic!("{error}"),
        }
        match peer.request_with_id(
            "x",
            None,
            4,
            Timeout::Disabled,
            RpcId::Text(JsString::from("5")),
        ) {
            Err(error) => assert_eq!(error.message(), "Request id already used"),
            Ok(_) => panic!("an explicit id was reused"),
        }
    }

    #[test]
    fn an_explicit_id_above_1024_bytes_is_refused() {
        let mut peer = new_peer();
        match peer.request_with_id(
            "x",
            None,
            1,
            Timeout::Disabled,
            RpcId::Text(JsString::from("a".repeat(1025))),
        ) {
            Err(error) => assert_eq!(error.message(), "Invalid request id"),
            Ok(_) => panic!("a 1025-byte id was admitted"),
        }
    }

    #[test]
    fn the_explicit_id_cap_is_4096() {
        let mut peer = new_peer();
        for at in 1..=4096u64 {
            let effects = match peer.request_with_id(
                "x",
                None,
                at,
                Timeout::Disabled,
                RpcId::Number(at as f64),
            ) {
                Ok(effects) => effects,
                Err(error) => panic!("id {at} refused: {error}"),
            };
            assert!(matches!(
                effects.first(),
                Some(PeerEffect::Frame {
                    dir: Direction::Send,
                    ..
                })
            ));
            let reply = peer.line(&format!(r#"{{"id":{at},"result":null}}"#));
            assert_eq!(settles(&reply).len(), 1);
        }
        match peer.request_with_id("x", None, 4097, Timeout::Disabled, RpcId::Number(4097.0)) {
            Err(error) => assert_eq!(error.message(), "JSON-RPC explicit id limit"),
            Ok(_) => panic!("the 4097th explicit id was admitted"),
        }
    }

    #[test]
    fn a_replacement_shares_the_byte_cap() {
        let owner = PeerOwner::new(60);
        let mut retired = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
        let old = call(&mut retired, "old", None, 1, Timeout::Disabled);
        assert_eq!(writes(&old).len(), 1);
        retired.close("retired");

        let mut replacement = RpcPeer::with_owner(PeerConfig::default(), owner);
        let new = call(&mut replacement, "new", None, 2, Timeout::Disabled);
        assert_eq!(order(&new), vec!["frame:send", "settle:2"]);
        assert_eq!(
            settles(&new),
            vec![(2, Err("JSON-RPC write queue exceeded limit".to_owned()))]
        );
    }

    #[test]
    fn a_replacement_peer_keeps_the_pipes_id_reservations() {
        let owner = PeerOwner::new(32 * 1024 * 1024);
        let mut retired = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
        let old = call(&mut retired, "old", None, 1, Timeout::Disabled);
        assert_eq!(writes(&old)[0].0, 0);
        assert!(writes(&old)[0].1.contains(r#""id":1,"#));
        retired.close("retired");

        let mut replacement = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
        let new = call(&mut replacement, "new", None, 2, Timeout::Disabled);
        assert!(writes(&new).is_empty());
        let released = replacement.written(0);
        assert!(writes(&released)[0].1.contains(r#""id":2,"#));
        let late = replacement.line(r#"{"id":1,"result":"old"}"#);
        assert_eq!(order(&late), vec!["frame:recv"]);
        let fresh = replacement.line(r#"{"id":2,"result":"new"}"#);
        assert_eq!(order(&fresh), vec!["frame:recv", "settle:2"]);

        let mut retired = RpcPeer::with_owner(PeerConfig::default(), owner.clone());
        let id = RpcId::Text(JsString::from("kept"));
        match retired.request_with_id("x", None, 3, Timeout::Disabled, id.clone()) {
            Ok(_) => {}
            Err(error) => panic!("{error}"),
        }
        retired.close("retired");
        let mut replacement = RpcPeer::with_owner(PeerConfig::default(), owner);
        match replacement.request_with_id("x", None, 4, Timeout::Disabled, id) {
            Err(error) => assert_eq!(error.message(), "Request id already used"),
            Ok(_) => panic!("the replacement reused a retired id"),
        }
    }
}
