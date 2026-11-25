// SPDX-License-Identifier: Apache-2.0
//! One frame out of the Codex session: the credential scrub, the frame bound
//! and what may be left out (`emit`, `session.ts:123`-`:177`). Every frame the
//! session publishes is built here and nowhere else, so the order of a frame
//! against the state change after it is the caller's one effect list.
//!
//! Ported from `packages/adapter-codex/src/session.ts:123`-`:184`
//! (`redactMcpCredential` is `mcp-server/src/injection.ts:212`-`:214`),
//! `provider-kit/src/payload.ts:14`-`:40` (the bound) and `history.ts:161`
//! (`compactHistoryReply`, the recorded form of a history reply).

use ace_json::{JsString, Map, Value};

use super::dropped::LineAttribution;

/// The provider's frame bound (`maxProviderPayloadBytes`, `payload.ts:5`).
pub const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
/// `ProviderPayload`'s structural bound (`payload.ts:31`).
pub const MAX_PAYLOAD_NODES: usize = 32_768;
/// What a redacted MCP bearer becomes (`injection.ts:214`).
pub const MCP_CREDENTIAL: &str = "<ACE_MCP_CREDENTIAL>";

/// The effects one input of the session produced, in the order its state
/// changed. The bridge turns `Frame` into a `SessionEvent::Frame` with the seq
/// it assigns at push (E3.0c); every other effect is the shell's to carry out.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// One frame: `dir` and `channel`, `text` the redacted JSON to parse on the
    /// other side. Never published out of order relative to the state change
    /// that produced it.
    Frame {
        dir: FrameDir,
        channel: &'static str,
        text: String,
    },
    /// One request for the shell to send through the session's channel; it is
    /// answered with `Session::settled(call, result)`.
    Request {
        call: u64,
        method: String,
        params: Value,
        timeout_ms: Option<f64>,
    },
    /// One thread's newest turns (`readHistory`, `history.ts`, E3-codex.4),
    /// answered with `Session::history_ready(call, turns, omitted)`.
    ReadHistory {
        call: u64,
        thread: String,
    },
    /// A deferred server request fails: `-32603`, as a rejected `onRequest`.
    AnswerError {
        id: RpcId,
        message: String,
    },
    /// A deferred server request's answer (`Host::answer`), in place of the
    /// rejection above.
    Answer {
        id: RpcId,
        result: Value,
    },
    /// One context callback, on the session's ordered queue by name and as a
    /// JSON array of arguments: the identity a command and its native message
    /// share, queued before the write it belongs to (behaviour.md section 8).
    Callback {
        name: &'static str,
        json: String,
    },
    /// Settles the facade's promise `id` (E3.0c, `SessionEvent::Settle`).
    Settle {
        id: u64,
        result: Result<Value, Failure>,
    },
    /// The launch options an awaited port holds (`getLaunchOptions`): the facade
    /// resolves them and calls `Session::launch_ready(id, launch)`, which pushes
    /// the turn it was asked for. A start's awaits happen here, before its push.
    LaunchOptions {
        id: u64,
        thread: String,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// `lifetime.failTransport()`: the transport is gone and the session stops.
    FailTransport,
    /// `run.cleanup()`: the session releases its state and its timers.
    Cleanup,
    /// `channel.retire()`: the host stops; answered with `Lifetime::retired`.
    Retire {
        reason: Retirement,
    },
    /// `stopWork()`: the tree's root interrupt with `cascade: true`, bounded at
    /// 10 seconds; answered with `Lifetime::work_stopped`.
    StopWork {
        reason: Retirement,
    },
    /// `channel.detach()`: this tenant lets go; answered with
    /// `Lifetime::detached`.
    Detach {
        reason: Retirement,
        message: String,
    },
    /// The close settled: its promise resolves or rejects.
    Closed(Result<(), String>),
    /// `ctx.onExit`: the engine learns the session is gone, and whether it was
    /// deliberate.
    Exited {
        deliberate: bool,
        message: String,
    },
}

pub use super::host::Retirement;
pub use ace_adapter_api::FrameDirection as FrameDir;
pub use ace_supervisor::jsonrpc::RpcId;

/// Why a command failed, as the facade throws it (ADR 0223 section 7 rule 2): a
/// code the binding maps to the engine-api class, and the message. An unknown
/// code is a plain `Error`, which is what a provider's own refusal must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

/// A failure only the session itself can report.
pub const CODEX_FAILED: &str = "ACE_CODEX_FAILED";

impl Failure {
    /// The turn the input was meant to join has ended: unread, never retried.
    pub fn steer_target_lost(message: impl Into<String>) -> Failure {
        Failure {
            code: ace_adapter_api::bridge::queue::STEER_TARGET_LOST,
            message: message.into(),
        }
    }

    /// The provider refused before taking any of the input.
    pub fn input_rejected(message: impl Into<String>) -> Failure {
        Failure {
            code: ace_adapter_api::bridge::queue::INPUT_REJECTED,
            message: message.into(),
        }
    }

    /// Anything else: a transport failure or a provider's own error.
    pub fn failed(message: impl Into<String>) -> Failure {
        Failure {
            code: CODEX_FAILED,
            message: message.into(),
        }
    }
}

/// One frame ready to publish.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub dir: FrameDir,
    pub channel: &'static str,
    pub text: String,
}

/// The session's own call numbers: one per request it asks the shell to send,
/// answered through `Session::settled(call, result)`.
#[derive(Debug, Default)]
pub struct Calls {
    next: u64,
}

impl Calls {
    pub fn new() -> Calls {
        Calls::default()
    }

    pub fn take(&mut self) -> u64 {
        let call = self.next;
        self.next += 1;
        call
    }
}

impl From<Frame> for Effect {
    fn from(frame: Frame) -> Effect {
        Effect::Frame {
            dir: frame.dir,
            channel: frame.channel,
            text: frame.text,
        }
    }
}

/// What `emit` decided for one frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Emitted {
    /// The frames to publish, in order: one, or the note standing in for a
    /// frame that was left out.
    pub frames: Vec<Frame>,
    /// `invalidateOutput()` runs after the note: this session's output is
    /// uncertain and its controls are recovered from fresh reads.
    pub recover_output: bool,
}

/// A received execution frame the bound refused: the peer detaches, and the
/// session's transport fails first (`session.ts:145`-`:148`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub message: String,
    /// `dir === "recv"`: `lifetime.failTransport()` runs before the error
    /// leaves `emit`.
    pub fail_transport: bool,
}

/// The frame path: the credential scrub, the bound and what may be left out.
#[derive(Debug, Clone)]
pub struct Frames {
    /// The ace MCP bearer this session may echo (`ctx.aceMcp.bearer`).
    bearer: Option<String>,
    /// The channel is on a shared app-server (`link.shared`), so a frame over
    /// the bound may be left out and recovered instead of killing the peer.
    shared: bool,
}

impl Frames {
    pub fn new(bearer: Option<String>) -> Frames {
        Frames {
            bearer,
            shared: false,
        }
    }

    /// `lifetime.attached`: a channel was opened on a shared host.
    pub fn attach_shared(&mut self) {
        self.shared = true;
    }

    pub fn shared(&self) -> bool {
        self.shared
    }

    /// `redactMcpCredential(encoded, ctx.aceMcp)`: the bearer becomes
    /// `<ACE_MCP_CREDENTIAL>`, on the encoded text, exactly as the TypeScript.
    pub fn redact(&self, encoded: &str) -> String {
        match &self.bearer {
            Some(bearer) => encoded.replace(bearer.as_str(), MCP_CREDENTIAL),
            None => encoded.to_owned(),
        }
    }

    /// `omittable`: a received frame that can be left out without losing a
    /// question. Shared hosts only, and never a server request, whose
    /// interaction would otherwise wait unseen.
    pub fn omittable(&self, data: &Value) -> bool {
        if !self.shared {
            return false;
        }
        let Some(message) = data.as_object() else {
            return true;
        };
        let is_request = message
            .get("method")
            .is_some_and(|method| method.is_string())
            && message.contains_key("id");
        !is_request
    }

    /// `emit(dir, data, channel, optionalMethod)`, statement for statement.
    pub fn emit(
        &self,
        dir: FrameDir,
        data: &Value,
        channel: &'static str,
        optional: Option<&str>,
    ) -> Result<Emitted, Rejected> {
        let encoded = self.redact(&ace_json::to_string(data));
        let admission = admit_payload(&encoded);
        if admission.is_ok() {
            return Ok(Emitted {
                frames: vec![Frame {
                    dir,
                    channel,
                    text: encoded,
                }],
                recover_output: false,
            });
        }
        if admission == Err(Admission::Invalid) {
            // Only the bound is ever left out; a frame that is not JSON is the
            // session's own defect and fails it, as a non-`RangeError` does.
            return Err(Rejected {
                message: "Invalid provider frame".to_owned(),
                fail_transport: dir == FrameDir::Recv,
            });
        }
        if optional.is_none() && dir == FrameDir::Recv && self.omittable(data) {
            // The frame is left out like a dropped line: this thread records its
            // size and recovers its state from fresh reads.
            let message = data.as_object();
            let params = object_of(message.and_then(|message| message.get("params")));
            let thread = params.get("threadId").filter(|value| value.is_string());
            let mut attributed = Map::new();
            attributed.insert(
                "response",
                Value::Bool(!message.is_some_and(|message| message.contains_key("method"))),
            );
            if let Some(id) = message.and_then(|message| message.get("id")) {
                attributed.insert("id", id.clone());
            }
            if let Some(thread) = thread {
                attributed.insert("threadId", thread.clone());
            }
            let mut note = Map::new();
            note.insert("event", Value::from("output-line-dropped"));
            note.insert("phase", Value::from("complete"));
            note.insert("bytes", Value::from(encoded.len() as f64));
            note.insert("reason", Value::from("frame-bound"));
            note.insert("attributed", Value::Object(attributed));
            let emitted = self.emit(FrameDir::Note, &Value::Object(note), "stdio", None)?;
            return Ok(Emitted {
                frames: emitted.frames,
                recover_output: true,
            });
        }
        let Some(method) = optional else {
            return Err(Rejected {
                message: bound_message(&encoded),
                fail_transport: dir == FrameDir::Recv,
            });
        };
        let mut note = Map::new();
        note.insert("event", Value::from("optional-catalog-frame-omitted"));
        note.insert("method", Value::from(method));
        note.insert("bytes", Value::from(encoded.len() as f64));
        note.insert("reason", Value::from(bound_message(&encoded)));
        let emitted = self.emit(FrameDir::Note, &Value::Object(note), "stdio", None)?;
        Ok(Emitted {
            frames: emitted.frames,
            recover_output: false,
        })
    }
}

impl Default for Frames {
    fn default() -> Self {
        Frames::new(None)
    }
}

/// How `ProviderPayload` refuses a text: its `RangeError` (the byte or
/// structural bound, which the session may leave out) or a value that is not
/// JSON at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Admission {
    Bound,
    Invalid,
}

/// `ProviderPayload`'s admission (`payload.ts:14`-`:40`), in the same order:
/// the byte bound, then `JSON.parse`, then the structural bound.
fn admit_payload(text: &str) -> Result<(), Admission> {
    if text.len() > MAX_PAYLOAD_BYTES {
        return Err(Admission::Bound);
    }
    let Ok(value) = ace_json::parse(text) else {
        return Err(Admission::Invalid);
    };
    if within_structural_limit(&value) {
        Ok(())
    } else {
        Err(Admission::Bound)
    }
}

/// `ProviderPayload`'s node count: one linear pass, every surviving value
/// counts, and no call stack is used.
fn within_structural_limit(root: &Value) -> bool {
    let mut pending = vec![root];
    let mut nodes = 0usize;
    while let Some(value) = pending.pop() {
        nodes += 1;
        if nodes > MAX_PAYLOAD_NODES {
            return false;
        }
        match value {
            Value::Array(items) => pending.extend(items.iter()),
            Value::Object(map) => pending.extend(map.values()),
            _ => {}
        }
    }
    true
}

/// `ProviderPayload`'s message, as the TypeScript's `RangeError`.
fn bound_message(encoded: &str) -> String {
    if encoded.len() > MAX_PAYLOAD_BYTES {
        return "Provider payload exceeds byte limit".to_owned();
    }
    "Provider payload exceeds structural limit".to_owned()
}

/// The recorded form of a history reply (`compactHistoryReply`, `history.ts:161`):
/// its shape and counts, never its turns. Every history note holds the turns.
pub fn compact_history_reply(message: &Value) -> Value {
    let envelope = object(message);
    if envelope.contains_key("error") || !envelope.contains_key("result") {
        return message.clone();
    }
    let result = object_of(envelope.get("result"));
    let thread = object_of(result.get("thread"));
    let mut compact = Map::new();
    if let Some(id) = envelope.get("id") {
        compact.insert("id", id.clone());
    }
    let mut body = Map::new();
    if let Some(data) = result.get("data").and_then(Value::as_array) {
        body.insert("turns", Value::from(data.len() as f64));
        body.insert(
            "nextCursor",
            result.get("nextCursor").cloned().unwrap_or(Value::Null),
        );
    }
    if result.contains_key("thread") {
        body.insert("thread", Value::Object(without_history(&thread)));
        let turns = thread
            .get("turns")
            .and_then(Value::as_array)
            .map_or(0, |turns| turns.len());
        body.insert("turns", Value::from(turns as f64));
    }
    compact.insert("result", Value::Object(body));
    Value::Object(compact)
}

/// A thread's metadata without any turns it carried (`withoutHistory`).
pub fn without_history(thread: &Map) -> Map {
    let mut copy = Map::with_capacity(thread.len());
    for (key, value) in thread {
        if key.as_str() != "turns" {
            copy.insert(key.clone(), value.clone());
        }
    }
    copy
}

/// `obj(value)`: `{}` unless the value is an object.
pub fn object(value: &Value) -> Map {
    value.as_object().cloned().unwrap_or_default()
}

/// `obj(maybe)`: `{}` unless an object member.
pub fn object_of(value: Option<&Value>) -> Map {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// `str(value, "")`.
pub fn text(value: Option<&Value>) -> Option<JsString> {
    value
        .and_then(Value::as_js_str)
        .filter(|text| !text.as_str().is_empty())
        .cloned()
}

/// The note a dropped line becomes, in `dropped(line)`'s field order.
pub fn dropped_note(bytes: usize, phase: &str, attributed: &LineAttribution) -> Value {
    let mut note = Map::new();
    note.insert("event", Value::from("output-line-dropped"));
    note.insert("bytes", Value::from(bytes as f64));
    note.insert("phase", Value::from(phase));
    let mut fields = Map::new();
    fields.insert("response", Value::Bool(attributed.response));
    if let Some(id) = &attributed.id {
        fields.insert("id", rpc_value(id));
    }
    if let Some(thread) = &attributed.thread_id {
        fields.insert("threadId", Value::String(thread.clone()));
    }
    note.insert("attributed", Value::Object(fields));
    Value::Object(note)
}

fn rpc_value(id: &RpcId) -> Value {
    match id {
        RpcId::Text(text) => Value::String(text.clone()),
        RpcId::Number(number) => Value::Number(ace_json::Number::from_f64_lossy(*number)),
    }
}

#[cfg(test)]
mod tests;
