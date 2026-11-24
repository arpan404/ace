// SPDX-License-Identifier: Apache-2.0
//! The streams binding: values in, values out, never logic. Framing, budgets, the
//! SSE parser and the JSON-RPC protocol state live in `ace-supervisor`; this module
//! only translates handles, strings and errors, and throws the JavaScript
//! `RangeError` a refused limit is today. Lines and records cross one chunk at a
//! time, joined, so a burst costs one call and one copy, not one per line.

// napi-derive registers this module's exports only outside test builds, so in
// the lib test target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

use ace_supervisor::budget::{
    DropPhase, DroppedNotes, DroppingGate, Framed, OutputGate, StreamError, byte_count,
};
use ace_supervisor::jsonrpc::{self, FrameKind};
use ace_supervisor::lines::FramedLines;
use ace_supervisor::{flow, jsonl, lines, sse};
use napi::bindgen_prelude::Uint8Array;
use napi::{Env, Status};
use napi_derive::napi;
use std::sync::Arc;

/// Map a refusal: `Invalid <limit>` is the `RangeError` `byteLimit` threw.
fn bind(env: &Env, error: StreamError) -> napi::Error {
    match error {
        StreamError::InvalidLimit(name) => {
            let message = format!("Invalid {name}");
            let _ = env.throw_range_error(&message, None);
            napi::Error::new(Status::PendingException, message)
        }
        StreamError::Refused(message) => napi::Error::from_reason(message),
    }
}

fn reason(message: String) -> napi::Error {
    napi::Error::from_reason(message)
}

/// A ticket crosses as a JavaScript number; the queue's own counter is the truth.
fn ticket(value: f64) -> u64 {
    if value.is_finite() && value >= 0.0 {
        value as u64
    } else {
        0
    }
}

/// Lines from one crossing, joined by LF; `count` tells zero lines from one empty.
#[napi(object)]
pub struct FramedLinesJs {
    pub text: String,
    pub count: f64,
}

fn framed_lines(lines: FramedLines) -> FramedLinesJs {
    FramedLinesJs {
        text: lines.text,
        count: lines.count as f64,
    }
}

/// One line framer behind the `lineReader` shell.
#[napi]
pub struct LineFramerNative {
    inner: lines::LineFramer,
}

#[napi]
impl LineFramerNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(env: Env, max_bytes: f64) -> napi::Result<Self> {
        let limit = ace_supervisor::budget::byte_limit(max_bytes, "maxLineBytes")
            .map_err(|error| bind(&env, error))?;
        Ok(LineFramerNative {
            inner: lines::LineFramer::new(limit),
        })
    }

    /// Complete lines from one chunk's raw bytes; the error is the output-limit text.
    #[napi(catch_unwind)]
    pub fn push(&mut self, chunk: Uint8Array) -> napi::Result<FramedLinesJs> {
        self.inner.push(&chunk).map(framed_lines).map_err(reason)
    }

    /// The input ended: the final lines, without a terminator.
    #[napi(catch_unwind)]
    pub fn finish(&mut self) -> FramedLinesJs {
        framed_lines(self.inner.finish())
    }
}

/// Undo the U+2028/U+2029 shield in one line.
#[napi]
pub fn line_restore(text: String) -> String {
    lines::restore(&text)
}

/// `byteLimit`: a positive safe integer, or the `RangeError` it threw.
#[napi]
pub fn stream_byte_limit(env: Env, value: f64, name: String) -> napi::Result<f64> {
    if ace_supervisor::budget::is_byte_limit(value) {
        return Ok(value);
    }
    let message = format!("Invalid {name}");
    let _ = env.throw_range_error(&message, None);
    Err(napi::Error::new(Status::PendingException, message))
}

/// The non-dropping output gate's line counter.
#[napi]
pub struct OutputGateNative {
    inner: OutputGate,
}

#[napi]
impl OutputGateNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(env: Env, max_line_bytes: Option<f64>) -> napi::Result<Self> {
        let limit = match max_line_bytes {
            Some(value) => Some(
                ace_supervisor::budget::byte_limit(value, "maxLineBytes")
                    .map_err(|error| bind(&env, error))?,
            ),
            None => None,
        };
        Ok(OutputGateNative {
            inner: OutputGate::new(limit),
        })
    }

    /// The output-limit message once a line crossed the limit.
    #[napi(catch_unwind)]
    pub fn push(&mut self, chunk: Uint8Array) -> Option<String> {
        self.inner.push(&chunk)
    }
}

/// A dropped line as the shell's `DroppedOutputLine`.
#[napi(object)]
pub struct DroppedLineJs {
    pub bytes: f64,
    pub prefix: String,
    pub phase: String,
}

/// One framed output: a run of bytes to publish, or the line that was dropped.
#[napi(object)]
pub struct FramedJs {
    /// `data` or `drop`.
    pub kind: String,
    pub data: Option<Uint8Array>,
    pub line: Option<DroppedLineJs>,
}

fn framed_data(run: &mut Vec<u8>, out: &mut Vec<FramedJs>) {
    if run.is_empty() {
        return;
    }
    out.push(FramedJs {
        kind: "data".to_owned(),
        data: Some(Uint8Array::new(std::mem::take(run))),
        line: None,
    });
}

/// Contiguous data frames become one crossing; a drop always flushes.
fn framed(frames: Vec<Framed>) -> Vec<FramedJs> {
    let mut out = Vec::with_capacity(frames.len());
    let mut run = Vec::new();
    for frame in frames {
        match frame {
            Framed::Data(bytes) => run.extend_from_slice(&bytes),
            Framed::Drop(line) => {
                framed_data(&mut run, &mut out);
                out.push(FramedJs {
                    kind: "drop".to_owned(),
                    data: None,
                    line: Some(DroppedLineJs {
                        bytes: line.bytes as f64,
                        prefix: line.prefix,
                        phase: line.phase.as_str().to_owned(),
                    }),
                });
            }
        }
    }
    framed_data(&mut run, &mut out);
    out
}

/// The dropping gate behind `droppingOutputGate`.
#[napi]
pub struct DroppingGateNative {
    inner: DroppingGate,
}

#[napi]
impl DroppingGateNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(env: Env, limit: f64) -> napi::Result<Self> {
        let limit = ace_supervisor::budget::byte_limit(limit, "maxLineBytes")
            .map_err(|error| bind(&env, error))?;
        Ok(DroppingGateNative {
            inner: DroppingGate::new(limit),
        })
    }

    #[napi(catch_unwind)]
    pub fn push(&mut self, chunk: Uint8Array) -> Vec<FramedJs> {
        framed(self.inner.push(&chunk))
    }

    #[napi(catch_unwind)]
    pub fn finish(&mut self) -> Vec<FramedJs> {
        framed(self.inner.finish())
    }

    /// Admission was refused: hold nothing more.
    #[napi(catch_unwind)]
    pub fn stop(&mut self) {
        self.inner.stop();
    }
}

/// One notes step: a note to deliver and whether to arm the interval again.
#[napi(object)]
pub struct NoteStepJs {
    pub note: Option<String>,
    pub arm: bool,
}

fn notes_step(step: ace_supervisor::budget::NoteStep) -> NoteStepJs {
    NoteStepJs {
        note: step.note,
        arm: step.arm,
    }
}

fn phase(name: &str) -> DropPhase {
    if name == "start" {
        DropPhase::Start
    } else {
        DropPhase::Complete
    }
}

/// `droppedLineNotes`' accumulator; the timer stays in the shell.
#[napi]
pub struct DroppedNotesNative {
    inner: DroppedNotes,
}

impl Default for DroppedNotesNative {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl DroppedNotesNative {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        DroppedNotesNative {
            inner: DroppedNotes::new(),
        }
    }

    #[napi(catch_unwind)]
    pub fn dropped(&mut self, bytes: f64, phase: String) -> NoteStepJs {
        notes_step(self.inner.dropped(byte_count(bytes), self::phase(&phase)))
    }

    #[napi(catch_unwind)]
    pub fn fire(&mut self) -> NoteStepJs {
        notes_step(self.inner.fire())
    }

    #[napi(catch_unwind)]
    pub fn flush(&mut self) -> Option<String> {
        self.inner.flush()
    }
}

/// One JSONL chunk: records in order, then the refusal that stopped it.
#[napi(object)]
pub struct JsonlPushJs {
    pub lines: FramedLinesJs,
    pub error: Option<String>,
}

/// The `readJsonLines` framing.
#[napi]
pub struct JsonLinesNative {
    inner: jsonl::JsonLines,
}

#[napi]
impl JsonLinesNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(env: Env, max_bytes: f64) -> napi::Result<Self> {
        let limit = ace_supervisor::budget::byte_limit(max_bytes, "maxLineBytes")
            .map_err(|error| bind(&env, error))?;
        Ok(JsonLinesNative {
            inner: jsonl::JsonLines::new(limit),
        })
    }

    #[napi(catch_unwind)]
    pub fn push(&mut self, chunk: Uint8Array) -> JsonlPushJs {
        let push = self.inner.push(&chunk);
        JsonlPushJs {
            lines: framed_lines(push.lines),
            error: push.error,
        }
    }

    /// The stream ended; `paused` is the owner's flow state at that moment.
    #[napi(catch_unwind)]
    pub fn finish(&mut self, paused: bool) -> Option<String> {
        self.inner.finish(paused)
    }
}

/// One dispatched SSE event.
#[napi(object)]
pub struct SseEventJs {
    pub data: String,
    pub event: String,
    /// Absent when it repeats the previous event's id, which the shell already
    /// holds: a long id crosses once per run of events, not once per event.
    pub id: Option<String>,
    pub retry_ms: Option<f64>,
}

/// One `feed`: events in order, then the refusal that stopped it.
#[napi(object)]
pub struct SseFeedJs {
    pub events: Vec<SseEventJs>,
    /// The id in force after this feed, when it differs from the last one sent:
    /// an `id:` line with no event still changes what the shell must hold.
    pub id: Option<String>,
    pub error: Option<String>,
}

/// The SSE parser behind `SseParser`.
#[napi]
pub struct SseParserNative {
    inner: sse::SseParser,
    /// The last id handed to the shell, so an unchanged one never recrosses.
    sent_id: Arc<str>,
}

#[napi]
impl SseParserNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(
        env: Env,
        max_line_bytes: f64,
        max_event_bytes: f64,
        last_event_id: String,
    ) -> napi::Result<Self> {
        let line = ace_supervisor::budget::byte_limit(max_line_bytes, "maxLineBytes")
            .map_err(|error| bind(&env, error))?;
        let event = ace_supervisor::budget::byte_limit(max_event_bytes, "maxEventBytes")
            .map_err(|error| bind(&env, error))?;
        let inner = sse::SseParser::new(line, event, last_event_id);
        let sent_id = Arc::from(inner.last_event_id());
        Ok(SseParserNative { inner, sent_id })
    }

    #[napi(catch_unwind)]
    pub fn feed(&mut self, text: String) -> SseFeedJs {
        let feed = self.inner.feed(&text);
        let mut sent = Arc::clone(&self.sent_id);
        let events: Vec<SseEventJs> = feed
            .events
            .into_iter()
            .map(|event| {
                let id = if event.id == sent {
                    None
                } else {
                    sent = Arc::clone(&event.id);
                    Some(event.id.to_string())
                };
                SseEventJs {
                    data: event.data,
                    event: event.event,
                    id,
                    retry_ms: event.retry_ms,
                }
            })
            .collect();
        let last = self.inner.last_event_id();
        let (id, sent_id) = if last == &*sent {
            (None, sent)
        } else {
            (Some(last.to_owned()), Arc::from(last))
        };
        self.sent_id = sent_id;
        SseFeedJs {
            events,
            id,
            error: feed.error,
        }
    }

    #[napi(catch_unwind)]
    pub fn retry_ms(&self) -> Option<f64> {
        self.inner.retry_ms()
    }
}

/// Process-lifetime id reservations shared by the peers on one pipe.
#[napi]
pub struct RpcIdsNative {
    inner: jsonrpc::RpcIds,
}

#[napi]
impl RpcIdsNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(env: Env, max_explicit: f64) -> napi::Result<Self> {
        let limit = ace_supervisor::budget::byte_limit(max_explicit, "maxExplicitIds")
            .map_err(|error| bind(&env, error))?;
        Ok(RpcIdsNative {
            inner: jsonrpc::RpcIds::new(limit),
        })
    }

    /// Reserve the id `JSON.stringify` text names, or a generated one; the answer is
    /// the reserved id as `JSON.stringify` text, lone surrogates included.
    #[napi(catch_unwind)]
    pub fn reserve(&mut self, env: Env, explicit_json: Option<String>) -> napi::Result<String> {
        let explicit = match explicit_json {
            Some(text) => Some(jsonrpc::id_from_json(&text).map_err(|error| bind(&env, error))?),
            None => None,
        };
        self.inner
            .reserve(explicit)
            .map(|reserved| jsonrpc::id_to_json(&reserved))
            .map_err(|error| bind(&env, error))
    }
}

/// The bounded stdin queue shared by the peers on one pipe.
#[napi]
pub struct WriterQueueNative {
    inner: jsonrpc::WriterQueue,
}

#[napi]
impl WriterQueueNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(env: Env, max_queued_bytes: f64) -> napi::Result<Self> {
        let limit = ace_supervisor::budget::byte_limit(max_queued_bytes, "maxQueuedBytes")
            .map_err(|error| bind(&env, error))?;
        Ok(WriterQueueNative {
            inner: jsonrpc::WriterQueue::new(limit),
        })
    }

    #[napi(catch_unwind)]
    pub fn enqueue(&mut self, env: Env, bytes: f64) -> napi::Result<f64> {
        self.inner
            .enqueue(bytes.max(0.0) as usize)
            .map(|ticket| ticket as f64)
            .map_err(|error| bind(&env, error))
    }

    #[napi(catch_unwind)]
    pub fn claim(&mut self) -> Option<f64> {
        self.inner.claim().map(|ticket| ticket as f64)
    }

    #[napi(catch_unwind)]
    pub fn written(&mut self, written: f64) {
        self.inner.written(ticket(written));
    }

    #[napi(catch_unwind)]
    pub fn cancel(&mut self, cancelled: f64) -> bool {
        self.inner.cancel(ticket(cancelled))
    }

    #[napi(catch_unwind)]
    pub fn set_blocked(&mut self, blocked: bool) {
        self.inner.set_blocked(blocked);
    }

    #[napi(catch_unwind)]
    pub fn active(&self) -> Option<f64> {
        self.inner.active().map(|ticket| ticket as f64)
    }

    #[napi(catch_unwind)]
    pub fn close(&mut self) -> Vec<f64> {
        self.inner
            .close()
            .into_iter()
            .map(|ticket| ticket as f64)
            .collect()
    }
}

/// What one received line is: `unparsable`, `malformed`, `request`, `notification`
/// or `response`. The shell parses the line itself once for the message and fields.
#[napi]
pub fn rpc_inspect(line: String) -> String {
    match jsonrpc::inspect(&line) {
        FrameKind::Unparsable => "unparsable",
        FrameKind::Malformed => "malformed",
        FrameKind::Request => "request",
        FrameKind::Notification => "notification",
        FrameKind::Response => "response",
    }
    .to_owned()
}

/// `rpcErrorCode`: the integer `code` of a JSON-RPC error message, if it is one.
#[napi]
pub fn rpc_error_code(message: String) -> Option<f64> {
    jsonrpc::error_code(&message)
}

/// The reader's drain guard shared by the line and JSONL shells.
#[napi]
pub struct ReaderFlowNative {
    inner: flow::ReaderFlow,
}

impl Default for ReaderFlowNative {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl ReaderFlowNative {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        ReaderFlowNative {
            inner: flow::ReaderFlow::new(),
        }
    }

    #[napi(catch_unwind)]
    pub fn begin_drain(&mut self) -> bool {
        self.inner.begin()
    }

    #[napi(catch_unwind)]
    pub fn end_drain(&mut self) {
        self.inner.end();
    }

    #[napi(catch_unwind)]
    pub fn block(&mut self) {
        self.inner.block();
    }

    #[napi(catch_unwind)]
    pub fn unblock(&mut self) {
        self.inner.unblock();
    }

    #[napi(catch_unwind)]
    pub fn fail(&mut self) {
        self.inner.fail();
    }

    #[napi(catch_unwind)]
    pub fn detach(&mut self) {
        self.inner.detach();
    }
}
