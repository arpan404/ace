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
use std::sync::atomic::{AtomicU64, Ordering};
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

/// What one stdin owns (`rpc-owner.ts:14`): the id reservations, the bounded
/// write queue and every peer's incoming slots. Write acknowledgement belongs
/// to the queue, not to a peer: whichever peer the I/O shell calls, it releases
/// the one active ticket and the queue hands out the next line.
#[derive(Clone)]
pub struct PeerOwner {
    ids: Arc<Mutex<RpcIds>>,
    inner: Arc<Mutex<OwnerInner>>,
    next_peer: Arc<AtomicU64>,
}

struct OwnerInner {
    writer: WriterQueue,
    /// Live tickets: queued ones carry their wire, active ones only their peer.
    tickets: HashMap<u64, Ticket>,
    /// Each peer's open incoming-request slots, released when its reply lands.
    peers: HashMap<u64, PeerSlots>,
}

struct Ticket {
    peer: u64,
    wire: Option<Vec<u8>>,
}

#[derive(Default)]
struct PeerSlots {
    incoming: usize,
    replies: HashSet<u64>,
    retired: bool,
}

impl PeerOwner {
    /// The first peer on a pipe fixes the queue's byte cap; later peers reuse it.
    pub fn new(max_queued_bytes: usize) -> PeerOwner {
        PeerOwner {
            ids: Arc::new(Mutex::new(RpcIds::new(MAX_EXPLICIT_IDS))),
            inner: Arc::new(Mutex::new(OwnerInner {
                writer: WriterQueue::new(max_queued_bytes),
                tickets: HashMap::new(),
                peers: HashMap::new(),
            })),
            next_peer: Arc::new(AtomicU64::new(0)),
        }
    }

    fn join(&self) -> u64 {
        let peer = self.next_peer.fetch_add(1, Ordering::Relaxed);
        self.lock().peers.insert(peer, PeerSlots::default());
        peer
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, OwnerInner> {
        match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn reserve(&self, id: Option<RpcId>) -> Result<RpcId, StreamError> {
        let mut ids = match self.ids.lock() {
            Ok(ids) => ids,
            Err(poisoned) => poisoned.into_inner(),
        };
        ids.reserve(id)
    }

    fn enqueue(&self, peer: u64, wire: Vec<u8>) -> Result<u64, StreamError> {
        let mut inner = self.lock();
        let ticket = inner.writer.enqueue(wire.len())?;
        inner.tickets.insert(
            ticket,
            Ticket {
                peer,
                wire: Some(wire),
            },
        );
        Ok(ticket)
    }

    /// A reply publishes its slot before any peer can claim the write: both
    /// happen under this one lock, so the gap cannot leak the slot.
    fn enqueue_reply(&self, peer: u64, wire: Vec<u8>) -> Result<u64, StreamError> {
        let mut inner = self.lock();
        let ticket = inner.writer.enqueue(wire.len())?;
        inner.tickets.insert(
            ticket,
            Ticket {
                peer,
                wire: Some(wire),
            },
        );
        if let Some(slots) = inner.peers.get_mut(&peer) {
            slots.replies.insert(ticket);
        }
        Ok(ticket)
    }

    /// The next queued line, whichever peer enqueued it: the pipe is shared, so
    /// any peer may hand its bytes to stdin.
    fn claim(&self) -> Option<(u64, Vec<u8>)> {
        let mut inner = self.lock();
        let ticket = inner.writer.claim()?;
        let wire = inner.tickets.get_mut(&ticket)?.wire.take()?;
        Some((ticket, wire))
    }

    /// The active write's callback. A queued or unknown ticket is refused, so
    /// its payload stays for its turn; an active one releases its peer's reply
    /// slot.
    fn written(&self, ticket: u64) -> bool {
        let mut inner = self.lock();
        if inner.writer.active() != Some(ticket) {
            return false;
        }
        inner.writer.written(ticket);
        if let Some(entry) = inner.tickets.remove(&ticket) {
            let mut finished = false;
            if let Some(slots) = inner.peers.get_mut(&entry.peer) {
                if slots.replies.remove(&ticket) {
                    slots.incoming = slots.incoming.saturating_sub(1);
                }
                finished = slots.retired && slots.replies.is_empty();
            }
            if finished {
                inner.peers.remove(&entry.peer);
            }
        }
        true
    }

    /// Cancel one of this peer's queued writes; an active one stays charged.
    fn cancel(&self, peer: u64, ticket: u64) -> bool {
        let mut inner = self.lock();
        if inner.tickets.get(&ticket).map(|entry| entry.peer) != Some(peer) {
            return false;
        }
        if inner.writer.cancel(ticket) {
            inner.tickets.remove(&ticket);
            true
        } else {
            false
        }
    }

    /// Drop this peer's queued writes and leave the shared queue open. A
    /// cancelled reply releases the slot its send would have settled.
    fn cancel_owner(&self, peer: u64) {
        let mut inner = self.lock();
        let mine: Vec<u64> = inner
            .tickets
            .iter()
            .filter(|(_, entry)| entry.peer == peer)
            .map(|(ticket, _)| *ticket)
            .collect();
        for ticket in mine {
            if inner.writer.cancel(ticket) {
                inner.tickets.remove(&ticket);
                if let Some(slots) = inner.peers.get_mut(&peer)
                    && slots.replies.remove(&ticket)
                {
                    slots.incoming = slots.incoming.saturating_sub(1);
                }
            }
        }
    }

    fn incoming(&self, peer: u64) -> usize {
        self.lock()
            .peers
            .get(&peer)
            .map_or(0, |slots| slots.incoming)
    }

    fn receive(&self, peer: u64) {
        if let Some(slots) = self.lock().peers.get_mut(&peer) {
            slots.incoming += 1;
        }
    }

    fn release_request(&self, peer: u64) {
        if let Some(slots) = self.lock().peers.get_mut(&peer) {
            slots.incoming = slots.incoming.saturating_sub(1);
        }
    }

    /// Mark a stopped peer retired. Its queued writes were cancelled and its
    /// pending calls settled; an in-flight reply keeps the record until
    /// `written` releases its slot, then the record goes too.
    fn retire(&self, peer: u64) {
        let mut inner = self.lock();
        let Some(slots) = inner.peers.get_mut(&peer) else {
            return;
        };
        slots.retired = true;
        if slots.replies.is_empty() {
            inner.peers.remove(&peer);
        }
    }

    #[cfg(test)]
    fn peer_records(&self) -> usize {
        self.lock().peers.len()
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
    owner_id: u64,
    pending: Vec<(RpcId, Pending)>,
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
        let owner_id = owner.join();
        RpcPeer {
            config,
            owner,
            owner_id,
            pending: Vec::new(),
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
        self.enqueue_request(method, params, id, timeout, None, None)
    }

    /// `request` under a caller's veto of the frame it would send: the veto
    /// runs on the exact value the emitter sees, before a call slot, a timer or
    /// a write ticket exists, so a refused frame is one settlement and nothing
    /// else. The shell vets its frame bound this way (`session.ts:153`).
    pub fn request_vetoed(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
        veto: FrameVeto<'_>,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        self.enqueue_request(method, params, id, timeout, None, Some(veto))
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
        self.enqueue_request(method, params, id, timeout, Some(wire_id), None)
    }

    fn enqueue_request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
        wire_id: Option<RpcId>,
        veto: Option<FrameVeto<'_>>,
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
        if let Some(message) = veto.and_then(|veto| veto(&value)) {
            return Ok(vec![PeerEffect::Settle {
                id,
                result: Err(PeerError::new(message)),
            }]);
        }
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
        match self.owner.enqueue(self.owner_id, wire) {
            Ok(ticket) => {
                pending.ticket = Some(ticket);
                self.pending.push((request_id, pending));
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
        match self.owner.enqueue(self.owner_id, wire) {
            Ok(_) => self.pump(&mut effects),
            Err(error) => effects.push(PeerEffect::Failed {
                message: error.to_string(),
            }),
        }
        Ok(effects)
    }

    /// `#answer`'s success reply (`jsonrpc.ts:349`): `result ?? null`.
    pub fn answer(&mut self, server_id: &RpcId, result: &Value) -> Vec<PeerEffect> {
        self.send_reply(answer_value(server_id, Ok(result)), None)
    }

    /// `answer` under a caller's veto, before the reply claims a ticket.
    pub fn answer_vetoed(
        &mut self,
        server_id: &RpcId,
        result: &Value,
        veto: FrameVeto<'_>,
    ) -> Vec<PeerEffect> {
        self.send_reply(answer_value(server_id, Ok(result)), Some(veto))
    }

    /// `#answer`'s failure reply: `-32601` for a missing method, `-32603` else.
    pub fn answer_error(&mut self, server_id: &RpcId, code: f64, message: &str) -> Vec<PeerEffect> {
        self.send_reply(answer_value(server_id, Err((code, message))), None)
    }

    /// `answer_error` under a caller's veto.
    pub fn answer_error_vetoed(
        &mut self,
        server_id: &RpcId,
        code: f64,
        message: &str,
        veto: FrameVeto<'_>,
    ) -> Vec<PeerEffect> {
        self.send_reply(answer_value(server_id, Err((code, message))), Some(veto))
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

    /// `#settle` for one facade promise (`jsonrpc.ts:277`–`:284`): a channel's
    /// detach settles only the calls that channel is waiting on, by the promise
    /// it holds, and nothing else on the shared pipe. Empty when that call was
    /// already settled.
    pub fn abort(&mut self, facade: u64, reason: &str) -> Vec<PeerEffect> {
        let at = self
            .pending
            .iter()
            .position(|(_, pending)| pending.facade == facade);
        let Some(at) = at else {
            return Vec::new();
        };
        let pending = self.pending.remove(at).1;
        let mut effects = Vec::new();
        self.settle_pending(pending, Err(PeerError::new(reason)), &mut effects);
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
        if !self.owner.written(ticket) {
            return Vec::new();
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
        self.owner.release_request(self.owner_id);
    }

    fn received_request(&mut self, value: &Value, effects: &mut Vec<PeerEffect>) {
        // `#receive`: after the observer's frame, a stopped peer ignores requests.
        if self.stopped.is_some() {
            return;
        }
        if self.owner.incoming(self.owner_id) >= self.config.max_incoming {
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
        self.owner.receive(self.owner_id);
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
        // Cancel this peer's queued writes (a cancelled reply frees its slot);
        // the shared queue stays open for a replacement peer on the same stdin.
        self.owner.cancel_owner(self.owner_id);
        self.owner.retire(self.owner_id);
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
        if let Some(ticket) = pending.ticket {
            self.owner.cancel(self.owner_id, ticket);
        }
        cancel_timer(pending.timer.as_deref(), effects);
        effects.push(PeerEffect::Settle {
            id: pending.facade,
            result,
        });
    }

    /// A server request's reply holds its incoming slot until `written`, as
    /// `#answer` decrements in its `finally` after the send resolves.
    fn send_reply(&mut self, value: Value, veto: Option<FrameVeto<'_>>) -> Vec<PeerEffect> {
        let mut effects = Vec::new();
        if self.stopped.is_some() {
            self.finish_incoming();
            return effects;
        }
        if let Some(message) = veto.and_then(|veto| veto(&value)) {
            // The reply never claims a ticket: nothing is left to release.
            self.finish_incoming();
            effects.push(PeerEffect::Failed { message });
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
        match self.owner.enqueue_reply(self.owner_id, wire) {
            Ok(_) => self.pump(&mut effects),
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
        if let Some((ticket, wire)) = self.owner.claim() {
            effects.push(PeerEffect::Write { wire, ticket });
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

/// A caller's veto of the frame it would send, by the exact value the emitter
/// sees: `Some(message)` refuses it, with the error the caller gets.
pub type FrameVeto<'a> = &'a dyn Fn(&Value) -> Option<String>;

/// `#answer`'s reply value, success or failure.
fn answer_value(server_id: &RpcId, result: Result<&Value, (f64, &str)>) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("id", id_value(server_id));
    match result {
        Ok(result) => map.insert("result", result.clone()),
        Err((code, message)) => {
            let mut error = Map::with_capacity(2);
            error.insert("code", Value::from(code));
            error.insert("message", Value::from(message));
            map.insert("error", Value::Object(error))
        }
    };
    Value::Object(map)
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
mod tests;
