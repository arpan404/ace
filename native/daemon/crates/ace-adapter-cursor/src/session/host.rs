// SPDX-License-Identifier: Apache-2.0
//! The Cursor host's wire core (`host.ts:85`–`:206`), sans-IO over the JSON-RPC peer
//! (`ace-supervisor/src/peer.rs`). This is everything `CursorHost`'s daemon side does with the
//! host child's bytes: the peer's limits, the malformed-line rule, `receiveFrame` (the bound, the
//! envelope, the generation, the commit, the error frame), the login URL, the acknowledgement
//! that waits for every frame of a batch, and the stray-line hold.
//!
//! **What stays the shell's, on purpose.** Host prose is never redacted or classified here
//! (brief point 3): stderr lines, stray stdout lines, the peer's connection failure and an error
//! frame's message cross as ports, and the facade keeps `CursorHost`'s diagnostic fields with
//! `@ace/redaction`. The process, its stop plan and its timers are the facade's too.
//!
//! **One parse per line.** The peer parses the line; this core walks that value once for the
//! bound, and borrows the frame's text from the line when the host wrote it canonically (it does:
//! `host-wire.ts:85` writes every line with `boundedJson`), so a received frame costs no second
//! serialisation. A batch recomposes each inner frame once, in `Envelope`'s key order, because
//! zod's parse is what produced its text.
//!
//! **The stray-line hold** (`host.ts:143`). A stray line's `host-output` note frame takes its
//! place in line order, before the next line is read. The core cannot push that frame itself —
//! its text needs the facade's redaction — so it publishes `Port { name: "stray" }` and holds
//! every later event until the facade answers [`CursorHostCore::note`] with `"host-output"`.
//! The facade answers synchronously inside the same delivery, so a hold lasts one batch; while it
//! lasts the io shell pauses the read gate, which is how held events stay inside the queue's
//! bound (a held event never outlives what the pipe already delivered).

use std::collections::VecDeque;

use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::lines::{FramedLines, LineFramer, restore};
use ace_supervisor::peer::{INTERNAL_ERROR, PeerConfig, PeerEffect, RpcPeer, Timeout};

use super::ack::{Ack, AckBook};
use super::bounded::{self, DEFAULT_MAX_BYTES};
use super::envelope::{self, CursorLimits};
use super::error::{ACE_CURSOR_RPC, HostErrorWire, SessionError};

/// The peer's pending-request bound (`host.ts:133`): one session's host, not a shared one.
const MAX_PENDING_REQUESTS: usize = 16;
/// The peer's incoming-request bound (`jsonrpc.ts:149`, the default the host leaves alone).
const MAX_INCOMING_REQUESTS: usize = 128;
/// `request`'s own bound leaves room for the JSON-RPC envelope around `params`
/// (`host.ts:208`: `maxFrameBytes - 1024`).
const REQUEST_MARGIN: usize = 1024;
/// Stray stdout lines kept as diagnostics (`host.ts:143`).
const MAX_STRAYS: usize = 64;
/// The login URL bound counts UTF-16 units (`host.ts:174`: `url.length > 8192`).
const MAX_LOGIN_URL: usize = 8_192;
/// `host.ts:140`: a line from ace's own host that is not a JSON-RPC message.
pub const MALFORMED: &str = "Cursor SDK host sent a malformed message";
/// `jsonrpc.ts`'s close reason, which the peer settles pending calls with.
pub const PEER_CLOSED: &str = "JSON-RPC peer closed";
/// The pipe's end (`jsonrpc.ts:263`).
pub const PROCESS_EXITED: &str = "process exited";

/// The diagnostics the facade runs itself; the payload is the raw host text (never redacted
/// here, brief point 3).
pub const PORT_STDERR: &str = "stderr";
pub const PORT_STRAY: &str = "stray";
pub const PORT_CONNECTION: &str = "connection";
pub const PORT_ERROR_FRAME: &str = "errorFrame";
pub const PORT_STOP: &str = "stop";

/// What one input decided, in the order the state changed.
#[derive(Debug, Clone, PartialEq)]
pub enum HostEffect {
    /// One frame crossing to the session: its number, its parsed value, and the exact text it
    /// crosses with. `data` is `parse(text)`; a non-batch frame's is the host's params as it
    /// arrived, an inner batch frame's is the envelope zod would have produced.
    Frame {
        seq: u64,
        data: Value,
        text: String,
    },
    /// One line for the child's stdin, and the ticket `written` names when the pipe took it.
    Write {
        wire: Vec<u8>,
        ticket: u64,
    },
    /// Settles the facade's promise `id` with JSON, or with the peer's failure.
    Settle {
        id: u64,
        result: Result<String, HostErrorWire>,
    },
    /// A host login URL that passed the check (`host.ts:174`).
    LoginUrl(String),
    /// A diagnostic the facade owns; `json` is a one-field object.
    Port {
        name: &'static str,
        json: String,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// Last event: the pipes are closed and every frame they produced is before it.
    Drained,
}

/// What [`CursorHostCore::new`] needs.
pub struct CursorHostConfig {
    /// The generation this host's frames must carry (`host.ts:150`).
    pub generation: String,
    pub limits: CursorLimits,
}

/// One host child's wire core.
pub struct CursorHostCore {
    peer: RpcPeer,
    generation: JsString,
    limits: CursorLimits,
    stdout: LineFramer,
    stderr: DroppingStderr,
    acks: AckBook,
    /// An error frame's message, kept until its frame is stored (`host.ts:180`–`:186`).
    errors: Vec<(u64, String)>,
    strays: usize,
    next_frame: u64,
    held: VecDeque<HostEffect>,
    /// Stray ports the facade has not answered.
    notes: usize,
    closed: bool,
}

impl CursorHostCore {
    pub fn new(config: CursorHostConfig) -> CursorHostCore {
        let limits = config.limits;
        let peer = RpcPeer::new(PeerConfig {
            timeout_ms: Some(limits.timeout_ms),
            max_pending: MAX_PENDING_REQUESTS,
            max_queued_bytes: limits.max_pending_bytes,
            max_incoming: MAX_INCOMING_REQUESTS,
        });
        CursorHostCore {
            peer,
            generation: JsString::from(config.generation.as_str()),
            limits,
            stdout: LineFramer::new(limits.max_frame_bytes),
            stderr: DroppingStderr::new(limits.max_frame_bytes),
            acks: AckBook::new(),
            errors: Vec::new(),
            strays: 0,
            next_frame: 0,
            held: VecDeque::new(),
            notes: 0,
            closed: false,
        }
    }

    /// Whether events are waiting for the facade's `note("host-output")`.
    pub fn holding(&self) -> bool {
        self.notes > 0
    }

    /// Feed raw bytes from the child's stdout.
    pub fn stdout_bytes(&mut self, chunk: &[u8]) -> Vec<HostEffect> {
        let mut out = Vec::new();
        match self.stdout.push(chunk) {
            // An oversized stdout line ends the host, as `onOutputLimit` does today.
            Ok(framed) => self.lines(&framed, &mut out),
            Err(message) => self.stop(&message, &mut out),
        }
        out
    }

    /// Feed raw bytes from the child's stderr: diagnostics only, so an oversized line is
    /// dropped and framing goes on (`onStderrLineDropped`, `host.ts:115`).
    pub fn stderr_bytes(&mut self, chunk: &[u8]) -> Vec<HostEffect> {
        let framed = self.stderr.push(chunk);
        let mut out = Vec::new();
        if framed.count > 0 {
            for raw in framed.text.split('\n') {
                let line = restore(raw);
                self.emit(
                    &mut out,
                    vec![HostEffect::Port {
                        name: PORT_STDERR,
                        json: port_json("line", &line),
                    }],
                );
            }
        }
        out
    }

    /// One facade call: `host.request` (`host.ts:207`–`:244`), minus the prose.
    pub fn request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Option<f64>,
    ) -> Result<Vec<HostEffect>, SessionError> {
        if let Some(params) = params {
            let budget = self.limits.max_frame_bytes.saturating_sub(REQUEST_MARGIN);
            bounded::bounded_check(params, budget)?;
        }
        let ms = timeout.unwrap_or(if method == "send" {
            self.limits.send_timeout_ms
        } else {
            self.limits.timeout_ms
        });
        let effects = self.peer.request(method, params, id, Timeout::After(ms))?;
        let mut out = Vec::new();
        self.peer_effects(None, effects, &mut out);
        Ok(out)
    }

    /// The frame `seq` was stored (`onFrame` resolved).
    pub fn committed(&mut self, seq: u64) -> Vec<HostEffect> {
        let mut out = Vec::new();
        if let Some(at) = self.errors.iter().position(|(frame, _)| *frame == seq) {
            let (_, message) = self.errors.remove(at);
            self.emit(
                &mut out,
                vec![HostEffect::Port {
                    name: PORT_ERROR_FRAME,
                    json: port_json("message", &message),
                }],
            );
        }
        if let Some(ack) = self.acks.committed(seq) {
            self.apply(ack, &mut out);
        }
        out
    }

    /// The frame `seq` could not be stored (`onFrame` rejected); `reason` is the facade's
    /// already-redacted `ace could not store a Cursor SDK frame: …`.
    pub fn refused(&mut self, seq: u64, reason: &str) -> Vec<HostEffect> {
        self.errors.retain(|(frame, _)| *frame != seq);
        let mut out = Vec::new();
        if let Some(ack) = self.acks.refused(seq, reason) {
            self.apply(ack, &mut out);
        }
        out
    }

    /// The pipe took the line of write `ticket` (`rpc-writer.ts`).
    pub fn written(&mut self, ticket: u64) -> Vec<HostEffect> {
        let effects = self.peer.written(ticket);
        let mut out = Vec::new();
        self.peer_effects(None, effects, &mut out);
        out
    }

    /// An armed deadline fired.
    pub fn timer(&mut self, key: &str) -> Vec<HostEffect> {
        let effects = self.peer.timer(key);
        let mut out = Vec::new();
        self.peer_effects(None, effects, &mut out);
        out
    }

    /// The facade's `stop()`: the RPC is disposed, which settles every call still pending.
    pub fn close(&mut self, reason: &str) -> Vec<HostEffect> {
        let effects = self.peer.close(reason);
        self.closed = true;
        let mut out = Vec::new();
        self.peer_effects(None, effects, &mut out);
        out
    }

    /// The facade answered a port. `"host-output"` releases the stray hold; anything else is
    /// ignored.
    pub fn note(&mut self, name: &str) -> Vec<HostEffect> {
        if name != "host-output" || self.notes == 0 {
            return Vec::new();
        }
        self.notes -= 1;
        let take = if self.notes == 0 {
            self.held.len()
        } else {
            // Up to and including the next stray port: the facade answers one port per batch.
            self.held
                .iter()
                .position(
                    |effect| matches!(effect, HostEffect::Port { name, .. } if *name == PORT_STRAY),
                )
                .map_or(self.held.len(), |at| at + 1)
        };
        self.held.drain(..take).collect()
    }

    /// The last input: the pipes are closed. Flush both framers, dispose the peer and drain.
    /// Anything a hold still kept crosses before `Drained`, so nothing is dropped.
    pub fn finish(&mut self) -> Vec<HostEffect> {
        let mut out = Vec::new();
        let tail = self.stdout.finish();
        self.lines(&tail, &mut out);
        let tail = self.stderr.finish();
        if tail.count > 0 {
            for raw in tail.text.split('\n') {
                let line = restore(raw);
                self.emit(
                    &mut out,
                    vec![HostEffect::Port {
                        name: PORT_STDERR,
                        json: port_json("line", &line),
                    }],
                );
            }
        }
        let effects = self.peer.close(PROCESS_EXITED);
        self.closed = true;
        self.peer_effects(None, effects, &mut out);
        self.notes = 0;
        out.extend(self.held.drain(..));
        out.push(HostEffect::Drained);
        out
    }

    fn lines(&mut self, framed: &FramedLines, out: &mut Vec<HostEffect>) {
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
    fn peer_effects(
        &mut self,
        line: Option<&str>,
        effects: Vec<PeerEffect>,
        out: &mut Vec<HostEffect>,
    ) {
        let mut pending: VecDeque<PeerEffect> = effects.into();
        while let Some(effect) = pending.pop_front() {
            let follow = match effect {
                PeerEffect::Frame { .. } => Vec::new(),
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
                PeerEffect::Notification { method, params } => {
                    self.notification(line, method, params, out)
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
        match self.receive_frame(line, params.as_ref(), out) {
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
                match self.receive_frame(line, params.as_ref(), out) {
                    Ok((first, count)) => self.acks.track(None, first, count),
                    // An unacknowledged frame that was not stored leaves the turn incomplete,
                    // so the host stops; the cause says whose fault it was (`host.ts:181`–`:188`).
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

    /// `receiveFrame` (`host.ts:146`–`:189`), in its order: the bound, the envelope, the
    /// generation, the commit, then the error frame. Returns the frame numbers it emitted.
    fn receive_frame(
        &mut self,
        line: Option<&str>,
        params: Option<&Value>,
        out: &mut Vec<HostEffect>,
    ) -> Result<(u64, u64), SessionError> {
        let null = Value::Null;
        let value = params.unwrap_or(&null);
        // The text of a frame that is not a batch is the host's own span when it wrote one
        // canonically; the bound runs first either way, so a broken one is refused before the
        // envelope is read (`host.ts:147`).
        let raw = line.and_then(|line| ace_json::parse_raw(line).ok());
        let span = raw.as_ref().and_then(|raw| raw.get("params"));
        let span = span
            .filter(|span| span.is_canonical())
            .map(|span| span.text());
        let serialized = match span {
            Some(_) => {
                bounded::bounded_check(value, self.limits.max_frame_bytes)?;
                None
            }
            None => Some(bounded::bounded_json(value, self.limits.max_frame_bytes)?),
        };
        let envelope = envelope::parse(value)?;
        if envelope.generation != &self.generation {
            return Err(SessionError::GenerationMismatch);
        }
        let batch = envelope.is_batch();
        let error = if !batch && envelope.kind.as_str() == "error" {
            error_body(envelope.body)
        } else {
            None
        };
        let frames: Vec<(Value, String)> = if batch {
            let mut frames = Vec::new();
            for inner in envelope::unbatch(value)? {
                let text = bounded::bounded_json(&inner, DEFAULT_MAX_BYTES)?;
                frames.push((inner, text));
            }
            frames
        } else {
            let text = match span {
                Some(span) => span.to_owned(),
                None => serialized.unwrap_or_default(),
            };
            vec![(value.clone(), text)]
        };
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

    /// `onMalformed` (`host.ts:137`–`:144`): JSON, or text that may hold a JSON-RPC message, is
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
    fn stop(&mut self, reason: &str, out: &mut Vec<HostEffect>) {
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

    /// `onError`: the facade wraps the host's words and fails the host (`host.ts:152`–`:154`).
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

    fn apply(&mut self, ack: Ack, out: &mut Vec<HostEffect>) {
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
    fn emit(&mut self, out: &mut Vec<HostEffect>, effects: Vec<HostEffect>) {
        for effect in effects {
            if self.notes > 0 {
                self.held.push_back(effect);
            } else {
                out.push(effect);
            }
        }
    }
}

/// A one-field object, as a port's payload.
fn port_json(field: &str, text: &str) -> String {
    let mut object = Map::with_capacity(1);
    object.insert(field, Value::String(JsString::from(text)));
    Value::Object(object).to_json()
}

/// `HostErrorBody.safeParse(frame.body)`: the message an error frame carries.
fn error_body(body: &Value) -> Option<String> {
    match body.get("message") {
        Some(Value::String(message)) => Some(message.as_str().to_owned()),
        _ => None,
    }
}

/// `login-url` (`host.ts:172`–`:177`): https, at most 8,192 UTF-16 units.
fn login_url(params: Option<&Value>) -> Result<String, SessionError> {
    let Some(Value::String(url)) = params.and_then(|params| params.get("url")) else {
        return Err(SessionError::UnsafeLoginUrl);
    };
    if url.len_utf16() > MAX_LOGIN_URL || !url.as_str().starts_with("https://") {
        return Err(SessionError::UnsafeLoginUrl);
    }
    Ok(url.as_str().to_owned())
}

/// `/"jsonrpc"\s*:/`: text that may hold a JSON-RPC message, which an unterminated native write
/// can join (`host.ts:19`).
fn may_hold_rpc_message(line: &str) -> bool {
    fn is_js_space(text: char) -> bool {
        matches!(
            text,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    }
    const NEEDLE: &str = "\"jsonrpc\"";
    let mut rest = line;
    while let Some(at) = rest.find(NEEDLE) {
        let after = rest.get(at + NEEDLE.len()..).unwrap_or("");
        if after.trim_start_matches(is_js_space).starts_with(':') {
            return true;
        }
        rest = after;
    }
    false
}

/// `lineReader`'s dropping gate for stderr (`output-line-drop.ts`): an oversized line is dropped
/// up to its terminator, and every line after it still arrives. Only an admissible line's bytes
/// are held (at most `max_bytes`), and each complete line is framed on its own.
struct DroppingStderr {
    max_bytes: usize,
    /// The current line's bytes, without its terminator.
    pending: Vec<u8>,
    /// The current line is already over the limit: skip to its terminator.
    dropping: bool,
    /// The last line ended at CR; an LF opening the next chunk closes that CRLF.
    skip_lf: bool,
}

impl DroppingStderr {
    fn new(max_bytes: usize) -> DroppingStderr {
        DroppingStderr {
            max_bytes,
            pending: Vec::new(),
            dropping: false,
            skip_lf: false,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> FramedLines {
        let mut framed = FramedLines::default();
        let mut chunk = chunk;
        if self.skip_lf {
            self.skip_lf = false;
            if chunk.first() == Some(&b'\n') {
                chunk = chunk.get(1..).unwrap_or_default();
            }
        }
        let mut at = 0usize;
        while at < chunk.len() {
            let rest = chunk.get(at..).unwrap_or_default();
            let terminator = rest
                .iter()
                .position(|byte| *byte == b'\n' || *byte == b'\r')
                .map(|offset| at + offset);
            let content_end = terminator.unwrap_or(chunk.len());
            let content = chunk.get(at..content_end).unwrap_or_default();
            if self.dropping {
                if terminator.is_none() {
                    return framed;
                }
                self.dropping = false;
                self.skip_lf = chunk.get(content_end) == Some(&b'\r');
                at = after_terminator(chunk, content_end);
                continue;
            }
            if self.pending.len() + content.len() > self.max_bytes {
                self.pending.clear();
                self.dropping = true;
                if terminator.is_none() {
                    return framed;
                }
                self.dropping = false;
                self.skip_lf = chunk.get(content_end) == Some(&b'\r');
                at = after_terminator(chunk, content_end);
                continue;
            }
            self.pending.extend_from_slice(content);
            let Some(_) = terminator else {
                return framed;
            };
            // One complete line, decoded on its own: a terminator never splits a UTF-8 sequence.
            let mut framer = LineFramer::new(self.max_bytes);
            let end = after_terminator(chunk, content_end);
            if let Ok(lines) = framer.push(chunk.get(at..end).unwrap_or_default())
                && lines.count > 0
            {
                for line in lines.text.split('\n') {
                    framed.push(line);
                }
            }
            self.pending.clear();
            at = end;
        }
        framed
    }

    fn finish(&mut self) -> FramedLines {
        let mut framed = FramedLines::default();
        if self.dropping || self.pending.is_empty() {
            self.pending.clear();
            return framed;
        }
        let mut framer = LineFramer::new(self.max_bytes);
        let pending = std::mem::take(&mut self.pending);
        if let Ok(lines) = framer.push(&pending) {
            let tail = framer.finish();
            for text in [lines, tail] {
                if text.count > 0 {
                    for line in text.text.split('\n') {
                        framed.push(line);
                    }
                }
            }
        }
        framed
    }
}

/// The byte after the terminator at `at`, taking an LF that closes a CR.
fn after_terminator(chunk: &[u8], at: usize) -> usize {
    let mut end = at + 1;
    if chunk.get(at) == Some(&b'\r') && chunk.get(end) == Some(&b'\n') {
        end += 1;
    }
    end
}

#[cfg(test)]
mod tests {
    use ace_json::Value;

    use super::{
        CursorHostConfig, CursorHostCore, HostEffect, MALFORMED, PORT_CONNECTION, PORT_ERROR_FRAME,
        PORT_STDERR, PORT_STOP, PORT_STRAY,
    };
    use crate::session::envelope::CursorLimits;

    /// The envelope `frame-batch.test.ts` writes, in schema order.
    const DELTA: &str = r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"delta","body":{"type":"text-delta","text":"hi"}}"#;

    fn core() -> CursorHostCore {
        CursorHostCore::new(CursorHostConfig {
            generation: "g".into(),
            limits: CursorLimits::default(),
        })
    }

    fn request_line(id: &str, params: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":"{id}","method":"frame","params":{params}}}"#)
    }

    fn notification_line(params: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","method":"frame","params":{params}}}"#)
    }

    fn feed(host: &mut CursorHostCore, lines: &[&str]) -> Vec<HostEffect> {
        let mut text = lines.join("\n");
        text.push('\n');
        host.stdout_bytes(text.as_bytes())
    }

    fn frames(effects: &[HostEffect]) -> Vec<(u64, Value, String)> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                HostEffect::Frame { seq, data, text } => Some((*seq, data.clone(), text.clone())),
                _ => None,
            })
            .collect()
    }

    fn port(effects: &[HostEffect], name: &str) -> Option<String> {
        effects.iter().find_map(|effect| match effect {
            HostEffect::Port { name: found, json } if *found == name => Some(json.clone()),
            _ => None,
        })
    }

    /// The pipe takes every line the peer handed out, so the next one can go.
    fn ack(host: &mut CursorHostCore, mut effects: Vec<HostEffect>) -> Vec<HostEffect> {
        let mut at = 0;
        while at < effects.len() {
            if let HostEffect::Write { ticket, .. } = effects[at] {
                let follow = host.written(ticket);
                effects.splice(at + 1..at + 1, follow);
            }
            at += 1;
        }
        effects
    }

    fn writes(effects: &[HostEffect]) -> Vec<String> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                HostEffect::Write { wire, .. } => {
                    Some(String::from_utf8_lossy(wire).trim_end().to_owned())
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_frame_request_crosses_with_its_own_text_and_is_answered_once_after_its_commit() {
        let mut host = core();
        let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
        let crossed = frames(&effects);
        assert_eq!(crossed.len(), 1);
        assert_eq!(crossed[0].0, 1);
        assert_eq!(crossed[0].2, DELTA);
        // Nothing is answered before the store.
        assert_eq!(writes(&effects), Vec::<String>::new());
        let answered = host.committed(1);
        assert_eq!(
            writes(&answered),
            vec![r#"{"jsonrpc":"2.0","id":"host:1","result":{"committed":true}}"#.to_owned()]
        );
        // A second report for the same frame answers nothing.
        assert!(writes(&host.committed(1)).is_empty());
    }

    #[test]
    fn a_batch_crosses_one_frame_per_member_in_the_schema_order_and_answers_after_the_last() {
        let mut host = core();
        // The members' keys arrive in an order the schema does not use.
        let first = r#"{"schemaVersion":1,"generation":"g","operationId":"op","segment":0,"kind":"delta","body":{"text":"1","type":"text-delta"}}"#;
        let second = r#"{"generation":"g","schemaVersion":1,"segment":0,"operationId":"op","kind":"result","body":{"status":"finished"}}"#;
        let batch = format!(
            r#"{{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"batch","body":{{"frames":[{first},{second}]}}}}"#
        );
        let effects = feed(&mut host, &[&request_line("host:2", &batch)]);
        let crossed = frames(&effects);
        assert_eq!(crossed.len(), 2);
        assert_eq!(
            crossed[0].2,
            r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"delta","body":{"text":"1","type":"text-delta"}}"#
        );
        assert_eq!(
            crossed[1].2,
            r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"result","body":{"status":"finished"}}"#
        );
        assert_eq!((crossed[0].0, crossed[1].0), (1, 2));
        assert!(writes(&effects).is_empty());
        assert!(writes(&host.committed(1)).is_empty());
        assert_eq!(
            writes(&host.committed(2)),
            vec![r#"{"jsonrpc":"2.0","id":"host:2","result":{"committed":true}}"#.to_owned()]
        );
    }

    #[test]
    fn the_bound_runs_before_the_envelope_and_the_envelope_before_the_generation() {
        // Deeper than 64, so the bound fails although the text is short.
        let mut body = String::from("null");
        for _ in 0..70 {
            body = format!("[{body}]");
        }
        let deep = format!(
            r#"{{"schemaVersion":8,"operationId":"op","generation":"other","segment":0,"kind":"delta","body":{body}}}"#
        );
        let mut host = core();
        let lines = feed(&mut host, &[&request_line("host:1", &deep)]);
        let effects = ack(&mut host, lines);
        assert!(frames(&effects).is_empty());
        assert_eq!(
            writes(&effects),
            vec![
                r#"{"jsonrpc":"2.0","id":"host:1","error":{"code":-32603,"message":"SDK payload exceeds structure budget"}}"#
                    .to_owned()
            ]
        );

        // A broken envelope is refused before its generation is compared.
        let bad_version = DELTA.replace(r#""schemaVersion":1"#, r#""schemaVersion":8"#);
        let lines = feed(&mut host, &[&request_line("host:2", &bad_version)]);
        let effects = ack(&mut host, lines);
        assert_eq!(
            writes(&effects),
            vec![
                r#"{"jsonrpc":"2.0","id":"host:2","error":{"code":-32603,"message":"Invalid Cursor SDK frame: schemaVersion is not 1"}}"#
                    .to_owned()
            ]
        );

        // A valid envelope from another generation is refused, and the host keeps reading.
        let other = DELTA.replace(r#""generation":"g""#, r#""generation":"other""#);
        let lines = feed(&mut host, &[&request_line("host:3", &other)]);
        let effects = ack(&mut host, lines);
        assert_eq!(
            writes(&effects),
            vec![
                r#"{"jsonrpc":"2.0","id":"host:3","error":{"code":-32603,"message":"SDK generation mismatch"}}"#
                    .to_owned()
            ]
        );
        // Still reading: the next good frame crosses.
        let effects = feed(&mut host, &[&request_line("host:4", DELTA)]);
        assert_eq!(frames(&effects).len(), 1);
    }

    #[test]
    fn a_frame_that_was_not_written_canonically_crosses_as_json_stringify_writes_it() {
        let mut host = core();
        // `1.0` and a space after the colon are what the host never writes, but a hand-written
        // line is parsed, then re-encoded exactly as `boundedJson` would.
        let spaced = DELTA
            .replace(r#""segment":0"#, r#""segment":1.0"#)
            .replace(r#""kind":"delta""#, r#""kind": "delta""#);
        let effects = feed(&mut host, &[&request_line("host:1", &spaced)]);
        let crossed = frames(&effects);
        assert_eq!(crossed.len(), 1);
        assert_eq!(
            crossed[0].2,
            DELTA.replace(r#""segment":0"#, r#""segment":1"#)
        );
    }

    #[test]
    fn a_notification_that_cannot_be_stored_stops_the_host_with_the_store_reason() {
        let mut host = core();
        let effects = feed(&mut host, &[&notification_line(DELTA)]);
        assert_eq!(frames(&effects).len(), 1);
        let effects = host.refused(1, "ace could not store a Cursor SDK frame: disk full");
        assert_eq!(
            port(&effects, PORT_STOP),
            Some(r#"{"reason":"ace could not store a Cursor SDK frame: disk full"}"#.to_owned())
        );
        assert!(writes(&effects).is_empty());
        // The host is stopped: later lines are ignored.
        let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
        assert!(effects.is_empty());
    }

    #[test]
    fn a_notification_that_is_not_a_frame_stops_the_host_through_its_connection() {
        let mut host = core();
        let effects = feed(&mut host, &[r#"{"jsonrpc":"2.0","method":"shutdown"}"#]);
        assert_eq!(
            port(&effects, PORT_CONNECTION),
            Some(r#"{"message":"Unknown host notification"}"#.to_owned())
        );
    }

    #[test]
    fn json_that_is_not_a_json_rpc_message_stops_the_host() {
        let mut host = core();
        let effects = feed(&mut host, &[r#"{"hello":1}"#]);
        assert_eq!(
            port(&effects, PORT_STOP),
            Some(format!(r#"{{"reason":"{MALFORMED}"}}"#))
        );
    }

    #[test]
    fn text_that_may_hold_a_json_rpc_message_stops_the_host_as_a_malformed_line() {
        // An unterminated native write joins the next message's line (`host.ts:137`–`:144`).
        let mut host = core();
        let effects = feed(&mut host, &[r#"half a write "jsonrpc" : {"#]);
        assert_eq!(
            port(&effects, PORT_STOP),
            Some(format!(r#"{{"reason":"{MALFORMED}"}}"#))
        );
    }

    #[test]
    fn two_stray_lines_in_one_chunk_each_take_their_place_before_the_frames_after_them() {
        let mut host = core();
        let line = request_line("host:1", DELTA);
        let effects = feed(&mut host, &["one", "two", &line]);
        // Only the first stray port goes out; the rest waits behind it.
        assert_eq!(
            port(&effects, PORT_STRAY),
            Some(r#"{"line":"one"}"#.to_owned())
        );
        assert_eq!(
            effects
                .iter()
                .filter(|effect| matches!(effect, HostEffect::Port { .. }))
                .count(),
            1
        );
        // The first answer releases the second port, and only then the frame.
        let released = host.note("host-output");
        assert_eq!(
            port(&released, PORT_STRAY),
            Some(r#"{"line":"two"}"#.to_owned())
        );
        assert!(frames(&released).is_empty());
        let released = host.note("host-output");
        assert_eq!(frames(&released).len(), 1);
        assert!(!host.holding());
    }

    #[test]
    fn a_stray_line_holds_the_events_after_it_until_the_facade_notes_the_output() {
        let mut host = core();
        let line = request_line("host:1", DELTA);
        let effects = feed(&mut host, &["a console write", &line]);
        // The note frame's place comes first; the frame waits for it.
        assert_eq!(
            port(&effects, PORT_STRAY),
            Some(r#"{"line":"a console write"}"#.to_owned())
        );
        assert!(frames(&effects).is_empty());
        assert!(host.holding());
        let released = host.note("host-output");
        assert_eq!(frames(&released).len(), 1);
        assert!(!host.holding());
        assert_eq!(
            writes(&host.committed(1)),
            vec![r#"{"jsonrpc":"2.0","id":"host:1","result":{"committed":true}}"#.to_owned()]
        );
    }

    #[test]
    fn at_most_sixty_four_stray_lines_are_kept_and_each_one_holds() {
        let mut host = core();
        let mut noted = 0;
        for index in 0..70 {
            let effects = feed(&mut host, &[&format!("stray {index}")]);
            if port(&effects, PORT_STRAY).is_some() {
                noted += 1;
                host.note("host-output");
            }
        }
        assert_eq!(noted, 64);
    }

    #[test]
    fn an_error_frame_message_crosses_once_its_frame_is_stored() {
        let mut host = core();
        let error = r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"error","body":{"message":"rate limited"}}"#;
        let effects = feed(&mut host, &[&request_line("host:1", error)]);
        assert_eq!(port(&effects, PORT_ERROR_FRAME), None);
        let effects = host.committed(1);
        assert_eq!(
            port(&effects, PORT_ERROR_FRAME),
            Some(r#"{"message":"rate limited"}"#.to_owned())
        );
        // A refused error frame says nothing: it was not stored.
        let mut host = core();
        let effects = feed(&mut host, &[&request_line("host:2", error)]);
        assert_eq!(port(&effects, PORT_ERROR_FRAME), None);
        let effects = host.refused(1, "ace could not store a Cursor SDK frame: full");
        assert_eq!(port(&effects, PORT_ERROR_FRAME), None);
    }

    #[test]
    fn an_oversized_stderr_line_is_dropped_and_the_next_line_still_arrives() {
        let mut host = CursorHostCore::new(CursorHostConfig {
            generation: "g".into(),
            limits: CursorLimits {
                max_frame_bytes: 4_096,
                ..CursorLimits::default()
            },
        });
        let mut chunk = vec![b'x'; 5_000];
        chunk.push(b'\n');
        chunk.extend_from_slice(b"after\n");
        let effects = host.stderr_bytes(&chunk);
        assert_eq!(
            port(&effects, PORT_STDERR),
            Some(r#"{"line":"after"}"#.to_owned())
        );
    }

    #[test]
    fn a_login_url_must_be_https_and_bounded() {
        let mut host = core();
        let effects = feed(
            &mut host,
            &[
                r#"{"jsonrpc":"2.0","method":"login-url","params":{"url":"https://cursor.com/login"}}"#,
            ],
        );
        assert!(matches!(
            effects.as_slice(),
            [HostEffect::LoginUrl(url)] if url == "https://cursor.com/login"
        ));
        let mut host = core();
        let effects = feed(
            &mut host,
            &[
                r#"{"jsonrpc":"2.0","method":"login-url","params":{"url":"http://cursor.com/login"}}"#,
            ],
        );
        assert_eq!(
            port(&effects, PORT_CONNECTION),
            Some(r#"{"message":"Unsafe login URL"}"#.to_owned())
        );
    }

    #[test]
    fn an_unknown_request_is_answered_and_the_host_keeps_reading() {
        let mut host = core();
        let effects = feed(
            &mut host,
            &[r#"{"jsonrpc":"2.0","id":7,"method":"prompt","params":{}}"#],
        );
        assert_eq!(
            writes(&effects),
            vec![
                r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"Unknown SDK host request"}}"#
                    .to_owned()
            ]
        );
        let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
        assert_eq!(frames(&effects).len(), 1);
    }

    #[test]
    fn a_facade_request_over_its_own_bound_is_refused_before_anything_is_written() {
        let mut host = CursorHostCore::new(CursorHostConfig {
            generation: "g".into(),
            limits: CursorLimits {
                max_frame_bytes: 4_096,
                ..CursorLimits::default()
            },
        });
        let params = format!(r#"{{"input":"{}"}}"#, "a".repeat(4_000));
        let value = ace_json::parse(&params).expect("valid JSON");
        let error = host
            .request("send", Some(&value), 1, None)
            .expect_err("over the bound");
        assert_eq!(error.message(), "SDK string exceeds byte budget");
        // Under it, the request is written and its timer armed.
        let small = ace_json::parse(r#"{"input":"hi"}"#).expect("valid JSON");
        let effects = host
            .request("send", Some(&small), 2, None)
            .expect("a request");
        assert_eq!(writes(&effects).len(), 1);
        assert!(effects.iter().any(|effect| matches!(
            effect,
            HostEffect::ArmTimer { ms, .. } if *ms == CursorLimits::default().send_timeout_ms
        )));
    }

    #[test]
    fn a_held_frame_still_crosses_before_the_drain_when_the_note_never_comes() {
        let mut host = core();
        let line = request_line("host:1", DELTA);
        let effects = feed(&mut host, &["stray", &line]);
        assert_eq!(
            port(&effects, PORT_STRAY),
            Some(r#"{"line":"stray"}"#.to_owned())
        );
        let finished = host.finish();
        let frame_at = finished
            .iter()
            .position(|effect| matches!(effect, HostEffect::Frame { .. }))
            .expect("the held frame");
        assert!(finished.contains(&HostEffect::Drained));
        let drained_at = finished
            .iter()
            .position(|effect| *effect == HostEffect::Drained)
            .expect("drained");
        assert!(frame_at < drained_at);
        // The drain is the last event, and the held frame still crosses before it.
        assert_eq!(drained_at, finished.len() - 1);
    }
}
