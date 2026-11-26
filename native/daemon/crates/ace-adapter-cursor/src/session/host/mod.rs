// SPDX-License-Identifier: Apache-2.0
//! The Cursor host's wire core (`host.ts:85`-`:206`), sans-IO over the JSON-RPC peer
//! (`ace-supervisor/src/peer.rs`). This is everything `CursorHost`'s daemon side does with the
//! host child's bytes: the peer's limits, the malformed-line rule, `receiveFrame` (the bound, the
//! envelope, the generation, the commit, the error frame), the login URL, the acknowledgement
//! that waits for every frame of a batch, and the stray-line hold.
//!
//! **What stays the shell's, on purpose.** Host prose is never redacted or classified here
//! (brief point 3): stderr lines, stray stdout lines, the peer's connection failure and an error
//! frame's message cross as ports, and the caller keeps `CursorHost`'s diagnostic fields with
//! `@ace/redaction`. The process, its stop plan and its timers are the caller's too.
//!
//! **One parse per line.** The peer parses the line; this core walks that value once for the
//! bound, and borrows the frame's text from the line when the host wrote it canonically (it does:
//! `host-wire.ts:85` writes every line with `boundedJson`), so a received frame costs no second
//! serialisation. A batch recomposes each inner frame once, in `Envelope`'s key order, because
//! zod's parse is what produced its text.
//!
//! **The stray-line hold** (`host.ts:143`). A stray line's `host-output` note frame takes its
//! place in line order, before the next line is read. The core cannot push that frame itself -
//! its text needs the caller's redaction - so it publishes `Port { name: "stray" }` and holds
//! every later event until the caller answers [`CursorHostCore::note`] with `"host-output"`.
//! The caller answers synchronously inside the same delivery, so a hold lasts one batch; while it
//! lasts the io shell pauses the read gate, which is how held events stay inside the queue's
//! bound (a held event never outlives what the pipe already delivered).

mod ports;
mod stderr;
mod wire;

#[cfg(test)]
mod tests;

use std::collections::VecDeque;

use ace_json::{JsString, Value};
use ace_supervisor::lines::{LineFramer, restore};
use ace_supervisor::peer::{PeerConfig, RpcPeer, Timeout};

use super::ack::AckBook;
use super::envelope::CursorLimits;
use crate::session::bounded;
use crate::session::error::{HostErrorWire, SessionError};

use ports::port_json;
use stderr::DroppingStderr;

/// The peer's pending-request bound (`host.ts:133`): one session's host, not a shared one.
const MAX_PENDING_REQUESTS: usize = 16;
/// The peer's incoming-request bound (`jsonrpc.ts:149`, the default the host leaves alone).
const MAX_INCOMING_REQUESTS: usize = 128;
/// `request`'s own bound leaves room for the JSON-RPC envelope around `params`
/// (`host.ts:208`: `maxFrameBytes - 1024`).
const REQUEST_MARGIN: usize = 1024;
/// Stray stdout lines kept as diagnostics (`host.ts:143`).
pub(super) const MAX_STRAYS: usize = 64;
/// The login URL bound counts UTF-16 units (`host.ts:174`: `url.length > 8192`).
const MAX_LOGIN_URL: usize = 8_192;
/// `host.ts:140`: a line from ace's own host that is not a JSON-RPC message.
pub const MALFORMED: &str = "Cursor SDK host sent a malformed message";
/// `jsonrpc.ts`'s close reason, which the peer settles pending calls with.
pub const PEER_CLOSED: &str = "JSON-RPC peer closed";
/// The pipe's end (`jsonrpc.ts:263`).
pub const PROCESS_EXITED: &str = "process exited";

/// The diagnostics the caller runs itself; the payload is the raw host text (never redacted
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
    /// Settles the caller's promise `id` with JSON, or with the peer's failure.
    Settle {
        id: u64,
        result: Result<String, HostErrorWire>,
    },
    /// A host login URL that passed the check (`host.ts:174`).
    LoginUrl(String),
    /// A diagnostic the caller owns; `json` is a one-field object.
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
    /// An error frame's message, kept until its frame is stored (`host.ts:180`-`:186`).
    errors: Vec<(u64, String)>,
    strays: usize,
    next_frame: u64,
    held: VecDeque<HostEffect>,
    /// Stray ports the caller has not answered.
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

    /// Whether events are waiting for the caller's `note("host-output")`.
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

    /// One caller call: `host.request` (`host.ts:207`-`:244`), minus the prose.
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

    /// The frame `seq` could not be stored (`onFrame` rejected); `reason` is the caller's
    /// already-redacted `ace could not store a Cursor SDK frame: ...`.
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

    /// The caller's `stop()`: the RPC is disposed, which settles every call still pending.
    pub fn close(&mut self, reason: &str) -> Vec<HostEffect> {
        let effects = self.peer.close(reason);
        self.closed = true;
        let mut out = Vec::new();
        self.peer_effects(None, effects, &mut out);
        out
    }

    /// The caller answered a port. `"host-output"` releases the stray hold; anything else is
    /// ignored.
    pub fn note(&mut self, name: &str) -> Vec<HostEffect> {
        if name != "host-output" || self.notes == 0 {
            return Vec::new();
        }
        self.notes -= 1;
        let take = if self.notes == 0 {
            self.held.len()
        } else {
            // Up to and including the next stray port: the caller answers one port per batch.
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
}
