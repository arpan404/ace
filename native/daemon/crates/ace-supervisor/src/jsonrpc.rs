// SPDX-License-Identifier: Apache-2.0
//! The JSON-RPC protocol pieces behind `JsonRpcPeer` (`jsonrpc.ts`, `rpc-ids.ts`,
//! `rpc-writer.ts`): process-lifetime id reservations shared by every peer on one
//! pipe, the bounded write queue, lenient envelope classification and the wire
//! encodings. JSON goes through `ace-json`, so ids, params, results and errors are
//! exactly what `JSON.parse`/`JSON.stringify` produce (key order, numbers, lone
//! surrogates). Promises, timers and the stream writes stay in the shell.

use ace_json::{JsString, Kind, Raw, parse_raw, write_js_string, write_number, write_str};
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

/// What one received line is (`#receive`'s classification).
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

/// The pieces of a received line. Params and results stay as their document text
/// (the shell parses them once); the error is canonical text, as
/// `JSON.stringify(message.error)` would be.
#[derive(Debug, Clone)]
pub struct Inspection {
    pub kind: FrameKind,
    pub id: Option<RpcId>,
    pub method: Option<JsString>,
    pub params: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
}

impl Inspection {
    fn of(kind: FrameKind) -> Inspection {
        Inspection {
            kind,
            id: None,
            method: None,
            params: None,
            result: None,
            error: None,
        }
    }
}

/// Classify one line, leniently: unknown fields stay in the message the shell
/// hands its observer.
pub fn inspect(line: &str) -> Inspection {
    let doc = match parse_raw(line) {
        Ok(doc) => doc,
        Err(_) => return Inspection::of(FrameKind::Unparsable),
    };
    if doc.kind() != Kind::Object {
        return Inspection::of(FrameKind::Malformed);
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
            return Inspection {
                id,
                method,
                params: text_of(&doc, "params"),
                ..Inspection::of(FrameKind::Request)
            };
        }
        if id_value.is_none() {
            return Inspection {
                method,
                params: text_of(&doc, "params"),
                ..Inspection::of(FrameKind::Notification)
            };
        }
    }
    let has_result = doc.get("result").is_some();
    let has_error = doc.get("error").is_some();
    if let Some(id) = id
        && (has_result || has_error)
    {
        return Inspection {
            id: Some(id),
            result: text_of(&doc, "result"),
            error: doc.get("error").map(|value| value.to_raw().into_string()),
            ..Inspection::of(FrameKind::Response)
        };
    }
    Inspection::of(FrameKind::Malformed)
}

fn text_of(doc: &ace_json::RawRef<'_>, key: &str) -> Option<String> {
    doc.get(key).map(|value| value.text().to_owned())
}

/// A message ready for the wire: its text with the newline, and its byte count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoded {
    pub line: String,
    pub bytes: usize,
}

fn finish(mut line: String) -> Encoded {
    line.push('\n');
    let bytes = line.len();
    Encoded { line, bytes }
}

/// The canonical text of a shell-encoded value, refusing anything that is not JSON.
fn canonical(text: &str) -> Result<Raw, StreamError> {
    Raw::from_json(text).map_err(|_| StreamError::refused("Invalid JSON"))
}

fn id_text(id_json: &str) -> Result<String, StreamError> {
    let doc = parse_raw(id_json).map_err(|_| StreamError::refused("Invalid request id"))?;
    let valid = match doc.kind() {
        Kind::String => true,
        Kind::Number => doc.as_f64().is_some_and(f64::is_finite),
        _ => false,
    };
    if !valid {
        return Err(StreamError::refused("Invalid request id"));
    }
    Ok(doc.to_raw().into_string())
}

/// `{jsonrpc:"2.0", id, method, params?}`.
pub fn encode_request(
    id_json: &str,
    method: &JsString,
    params: Option<String>,
) -> Result<Encoded, StreamError> {
    let mut line = String::with_capacity(128);
    line.push_str("{\"jsonrpc\":\"2.0\",\"id\":");
    line.push_str(&id_text(id_json)?);
    line.push_str(",\"method\":");
    write_js_string(&mut line, method);
    if let Some(params) = params {
        line.push_str(",\"params\":");
        line.push_str(canonical(&params)?.get());
    }
    line.push('}');
    Ok(finish(line))
}

/// `{jsonrpc:"2.0", method, params?}`.
pub fn encode_notification(
    method: &JsString,
    params: Option<String>,
) -> Result<Encoded, StreamError> {
    let mut line = String::with_capacity(96);
    line.push_str("{\"jsonrpc\":\"2.0\",\"method\":");
    write_js_string(&mut line, method);
    if let Some(params) = params {
        line.push_str(",\"params\":");
        line.push_str(canonical(&params)?.get());
    }
    line.push('}');
    Ok(finish(line))
}

/// `{jsonrpc:"2.0", id, result}` or `{jsonrpc:"2.0", id, error:{code, message}}`.
/// A result that `JSON.stringify` omits (a function or symbol) arrives as `None`.
pub fn encode_answer(
    id_json: &str,
    result: Option<String>,
    error: Option<(f64, String)>,
) -> Result<Encoded, StreamError> {
    let mut line = String::with_capacity(128);
    line.push_str("{\"jsonrpc\":\"2.0\",\"id\":");
    line.push_str(&id_text(id_json)?);
    match error {
        Some((code, message)) => {
            line.push_str(",\"error\":{\"code\":");
            write_number(&mut line, code);
            line.push_str(",\"message\":");
            write_str(&mut line, &message);
            line.push('}');
        }
        None => {
            if let Some(result) = result {
                line.push_str(",\"result\":");
                line.push_str(canonical(&result)?.get());
            }
        }
    }
    line.push('}');
    Ok(finish(line))
}

/// The JSON-RPC error code a rejected request carries, if its message is one
/// (`rpcErrorCode`). `z.number().int()`: any integer, strict about everything else.
pub fn error_code(message: &str) -> Option<f64> {
    let doc = parse_raw(message).ok()?;
    if doc.kind() != Kind::Object {
        return None;
    }
    let value = doc.get("code")?.as_f64()?;
    (value.is_finite() && value.fract() == 0.0).then_some(value)
}
