// SPDX-License-Identifier: Apache-2.0
//! The JSON-RPC protocol pieces behind `JsonRpcPeer` (`jsonrpc.ts`, `rpc-ids.ts`,
//! `rpc-writer.ts`): process-lifetime id reservations shared by every peer on one
//! pipe, the bounded write queue, lenient envelope classification and the wire
//! encodings. JSON goes through `ace-json`, so ids, params, results and errors are
//! exactly what `JSON.parse`/`JSON.stringify` produce (key order, numbers, lone
//! surrogates). Promises, timers and the stream writes stay in the shell.

use ace_json::{JsString, Kind, parse_raw, write_js_string, write_number};
use std::collections::{HashSet, VecDeque};
use std::hash::{Hash, Hasher};

use crate::budget::StreamError;

/// Largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A request id: a JavaScript string or a finite number.
#[derive(Debug, Clone)]
pub enum RpcId {
    Text(JsString),
    Number(f64),
}

impl RpcId {
    /// `isRpcId`: a string, or a finite number.
    pub fn is_valid(&self) -> bool {
        match self {
            RpcId::Text(text) => text.as_str().len() <= 1024,
            RpcId::Number(value) => value.is_finite(),
        }
    }

    /// `typeof id === "number" && Number.isInteger(id)`.
    fn is_integer(&self) -> Option<f64> {
        match self {
            RpcId::Number(value) if value.fract() == 0.0 && value.is_finite() => Some(*value),
            _ => None,
        }
    }
}

impl PartialEq for RpcId {
    fn eq(&self, other: &RpcId) -> bool {
        match (self, other) {
            (RpcId::Text(a), RpcId::Text(b)) => a == b,
            // JavaScript's `Set`: -0 and 0 are the same key.
            (RpcId::Number(a), RpcId::Number(b)) => a == b,
            _ => false,
        }
    }
}

impl Eq for RpcId {}

impl Hash for RpcId {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match self {
            RpcId::Text(text) => {
                state.write_u8(0);
                text.hash(state);
            }
            RpcId::Number(value) => {
                state.write_u8(1);
                // Hash -0 as 0, as JavaScript's Set does.
                let normalized = if *value == 0.0 { 0.0 } else { *value };
                state.write_u64(normalized.to_bits());
            }
        }
    }
}

/// Process-lifetime id reservations (`RpcIds`). Generated ids need no history;
/// explicit ids are remembered so a late response cannot claim a reused id.
#[derive(Debug)]
pub struct RpcIds {
    explicit: HashSet<RpcId>,
    max_explicit: usize,
    next: f64,
}

impl RpcIds {
    pub fn new(max_explicit: usize) -> RpcIds {
        RpcIds {
            explicit: HashSet::new(),
            max_explicit,
            next: 1.0,
        }
    }

    /// Reserve an explicit id, or the next generated one.
    pub fn reserve(&mut self, id: Option<RpcId>) -> Result<RpcId, StreamError> {
        match id {
            Some(id) => {
                if !id.is_valid() {
                    return Err(StreamError::refused("Invalid request id"));
                }
                let reused = self.explicit.contains(&id)
                    || id
                        .is_integer()
                        .is_some_and(|value| value > 0.0 && value < self.next);
                if reused {
                    return Err(StreamError::refused("Request id already used"));
                }
                if self.explicit.len() >= self.max_explicit {
                    return Err(StreamError::refused("JSON-RPC explicit id limit"));
                }
                self.explicit.insert(id.clone());
                Ok(id)
            }
            None => {
                while self.explicit.contains(&RpcId::Number(self.next)) {
                    self.next += 1.0;
                }
                if self.next > MAX_SAFE_INTEGER {
                    return Err(StreamError::refused("JSON-RPC id space exhausted"));
                }
                let id = RpcId::Number(self.next);
                self.next += 1.0;
                Ok(id)
            }
        }
    }
}

/// The bounded FIFO in front of stdin (`RpcWriter`). Only one write is active; its
/// bytes stay charged until the write callback, even after a cancellation.
#[derive(Debug)]
pub struct WriterQueue {
    max_queued_bytes: usize,
    bytes: usize,
    next_ticket: u64,
    queue: VecDeque<(u64, usize)>,
    active: Option<(u64, usize)>,
    blocked: bool,
    closed: bool,
}

impl WriterQueue {
    pub fn new(max_queued_bytes: usize) -> WriterQueue {
        WriterQueue {
            max_queued_bytes,
            bytes: 0,
            next_ticket: 0,
            queue: VecDeque::new(),
            active: None,
            blocked: false,
            closed: false,
        }
    }

    /// Queue a write of `bytes`; the ticket names it in later calls.
    pub fn enqueue(&mut self, bytes: usize) -> Result<u64, StreamError> {
        if self.closed {
            return Err(StreamError::refused("JSON-RPC stdin closed"));
        }
        if self.bytes.saturating_add(bytes) > self.max_queued_bytes {
            return Err(StreamError::refused("JSON-RPC write queue exceeded limit"));
        }
        let ticket = self.next_ticket;
        self.next_ticket = self.next_ticket.saturating_add(1);
        self.queue.push_back((ticket, bytes));
        self.bytes += bytes;
        Ok(ticket)
    }

    /// The next write the shell may hand to stdin, if any.
    pub fn claim(&mut self) -> Option<u64> {
        if self.closed || self.blocked || self.active.is_some() {
            return None;
        }
        let entry = self.queue.pop_front()?;
        self.active = Some(entry);
        Some(entry.0)
    }

    /// The write callback ran: release its bytes and the one-active slot.
    pub fn written(&mut self, ticket: u64) {
        if let Some((active, bytes)) = self.active
            && active == ticket
        {
            self.active = None;
            self.bytes = self.bytes.saturating_sub(bytes);
        }
    }

    /// Cancel a queued write; false when it was already active (its bytes stay
    /// charged until the callback).
    pub fn cancel(&mut self, ticket: u64) -> bool {
        let Some(position) = self.queue.iter().position(|(queued, _)| *queued == ticket) else {
            return false;
        };
        if let Some((_, bytes)) = self.queue.remove(position) {
            self.bytes = self.bytes.saturating_sub(bytes);
            return true;
        }
        false
    }

    /// stdin's `write` returned false: hold until its `drain`.
    pub fn set_blocked(&mut self, blocked: bool) {
        self.blocked = blocked;
    }

    pub fn active(&self) -> Option<u64> {
        self.active.map(|(ticket, _)| ticket)
    }

    /// Close the queue, refusing every write still waiting. The active write keeps
    /// its charge until its callback, as it did.
    pub fn close(&mut self) -> Vec<u64> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        let mut tickets = Vec::with_capacity(self.queue.len());
        while let Some((ticket, bytes)) = self.queue.pop_front() {
            self.bytes = self.bytes.saturating_sub(bytes);
            tickets.push(ticket);
        }
        tickets
    }
}

/// What one received line is (`#receive`'s classification). The shell parses the
/// line once for the message and its fields; this only names the shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    /// Not JSON at all: `JSON.parse` would throw, so no observer sees it.
    Unparsable,
    /// JSON, but not a JSON-RPC envelope this peer accepts.
    Malformed,
    Request,
    Notification,
    Response,
}

/// `JSON.parse(text)` as a request id, refusing what `isRpcId` refuses.
pub fn id_from_json(text: &str) -> Result<RpcId, StreamError> {
    let doc = parse_raw(text).map_err(|_| StreamError::refused("Invalid request id"))?;
    let id = match doc.kind() {
        Kind::String => doc.as_js_string().map(RpcId::Text),
        Kind::Number => doc
            .as_f64()
            .filter(|number| number.is_finite())
            .map(RpcId::Number),
        _ => None,
    };
    id.ok_or_else(|| StreamError::refused("Invalid request id"))
}

/// `JSON.stringify(id)`, the shell's exact value text (`\ud800` included).
pub fn id_to_json(id: &RpcId) -> String {
    let mut text = String::with_capacity(24);
    match id {
        RpcId::Text(value) => write_js_string(&mut text, value),
        RpcId::Number(value) => write_number(&mut text, *value),
    }
    text
}

/// Classify one line, leniently, by the rules `#receive` applies. Unknown fields
/// are the shell's to keep: it holds the parsed message.
pub fn inspect(line: &str) -> FrameKind {
    let doc = match parse_raw(line) {
        Ok(doc) => doc,
        Err(_) => return FrameKind::Unparsable,
    };
    if doc.kind() != Kind::Object {
        return FrameKind::Malformed;
    }
    let id_value = doc.get("id");
    let id = id_value.as_ref().and_then(|value| match value.kind() {
        Kind::String => value.as_js_string().map(RpcId::Text),
        Kind::Number => value
            .as_f64()
            .filter(|number| number.is_finite())
            .map(RpcId::Number),
        _ => None,
    });
    let method = doc
        .get("method")
        .filter(|value| value.kind() == Kind::String)
        .and_then(|value| value.as_js_string());
    if method.is_some() {
        if id.is_some() {
            return FrameKind::Request;
        }
        if id_value.is_none() {
            return FrameKind::Notification;
        }
    }
    if id.is_some() && (doc.get("result").is_some() || doc.get("error").is_some()) {
        return FrameKind::Response;
    }
    FrameKind::Malformed
}

/// The JSON-RPC error code a rejected request carries, if its message is one
/// (`rpcErrorCode`): `z.number().int()`, which admits only a safe integer.
pub fn error_code(message: &str) -> Option<f64> {
    let doc = parse_raw(message).ok()?;
    if doc.kind() != Kind::Object {
        return None;
    }
    let value = doc.get("code")?.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER).then_some(value)
}
