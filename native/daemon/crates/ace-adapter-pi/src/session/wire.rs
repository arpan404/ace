// SPDX-License-Identifier: Apache-2.0
//! The Pi wire core: sans-IO state for `rpc.ts` whole and the half of
//! `session.ts` that runs per line or per write. One input produces its effects
//! in the order the state changed; the I/O shell (E3-pi.2) owns the lock, the
//! clock, the timers and the child.
//!
//! Ported from `packages/adapter-pi/src/rpc.ts:12`–`:124` (`PiRpc`) and
//! `session.ts:129`–`:133` (redaction), `:195`–`:202` (dialog expiry),
//! `:217`–`:259` (the `recv` inspection), `:261`–`:265` (stderr lines),
//! `:430`–`:445` (resolve's reservation) and `:272`–`:283` (the drain, which
//! the facade still runs). The shapes are `native.ts:14`–`:42`.

use std::collections::VecDeque;

use ace_adapter_api::util::{ElisionLimits, JsonElider};
use ace_json::{JsString, Map, Value};
use ace_supervisor::budget::{DroppedLine, DroppingGate, Framed, NoteStep};
use ace_supervisor::jsonl::JsonLines;
use ace_supervisor::lines::{FramedLines, Utf8Decoder};
use indexmap::IndexMap;

use super::dialogs::{self, Dialog, Response};
use super::error::{PiError, Refused, Uncertain};
use super::redact::Redactor;

pub use ace_adapter_api::FrameDirection as FrameDir;

/// At most 64 unanswered commands (`rpc.ts:82`).
const MAX_PENDING: usize = 64;
/// Pi's stdin queue bound (`new RpcWriter(proc.stdin, 2 * 1024 * 1024)`, `rpc.ts:43`).
const MAX_QUEUED_BYTES: usize = 2 * 1024 * 1024;
/// One command line's bound (`rpc.ts:73`).
const MAX_FRAME_BYTES: usize = 1024 * 1024;
/// `readJsonLines(proc.stdout, 1024 * 1024, ...)` (`rpc.ts:46`).
const STDOUT_LINE_BYTES: usize = 1024 * 1024;
/// The session's stdout elision (`session.ts:151`).
const ELISION: ElisionLimits = ElisionLimits {
    hold_bytes: 16 * 1024,
    text_bytes: 1024 * 1024,
};
/// `lineReader(proc.stderr, 1024 * 1024, ...)` (`session.ts:261`).
const STDERR_LINE_BYTES: usize = 1024 * 1024;
/// `armDeadline`'s 30 seconds (`rpc.ts:111`).
const DEADLINE_MS: f64 = 30_000.0;
/// `droppedLineNotes`' default interval (`dropped-line-notes.ts:26`).
const NOTES_MS: f64 = 1_000.0;
/// The stderr note channel in the TypeScript (`session.ts:136` emits a stderr frame).
const STDIO: &str = "stdio";
/// The lifecycle note channel (`session.ts:194`).
const LIFECYCLE: &str = "lifecycle";

/// The effects of one input, in the order the state changed.
#[derive(Debug)]
pub enum Effect {
    /// One frame, already redacted. `seq` is assigned when the queue publishes it.
    Frame {
        dir: FrameDir,
        channel: &'static str,
        text: String,
    },
    /// The original line's bytes plus "\n", to hand to the child's stdin.
    Write {
        wire: Vec<u8>,
    },
    /// Settles the facade's promise `id`.
    Settle {
        id: u64,
        result: Result<String, PiError>,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// The session cannot go on; the facade closes it.
    Fatal {
        message: String,
    },
    /// The terminal barrier: everything before it has been emitted.
    Drained,
}

/// What `PiWire::new` needs from the facade's injected runtime.
#[derive(Debug, Clone)]
pub struct PiWireConfig {
    pub control_secret: String,
    pub lease_bearer: Option<String>,
}

/// One answered command: its name and the facade promise to settle.
#[derive(Debug)]
struct Pending {
    command: String,
    facade_id: u64,
}

/// One line handed to stdin and not yet acknowledged by the pipe, in order.
#[derive(Debug)]
struct WriteRecord {
    /// The redacted line, as the `send` frame carries it.
    text: String,
    /// The facade promise: a request's, or a `write()`'s.
    facade_id: u64,
    /// The `ace-<n>` id when this line is a correlated request.
    correlation: Option<String>,
    resume_deadlines_after: bool,
    /// The line's UTF-8 bytes plus one for the newline.
    charge: usize,
}

pub struct PiWire {
    redact: Redactor,
    pending: IndexMap<String, Pending>,
    seq: u64,
    writes: VecDeque<WriteRecord>,
    /// The dialog as received, and its timer key when it has a timeout.
    dialogs: IndexMap<String, (Value, Option<String>)>,
    waiting_on_human: bool,
    rollback: Option<(String, Option<bool>)>,
    closed: bool,
    stdin_failed: Option<String>,
    notes: ace_supervisor::budget::DroppedNotes,
    /// Bytes charged to the stdin queue and not yet released.
    queued_bytes: usize,
    elider: JsonElider,
    stdout: JsonLines,
    stderr: DroppingGate,
    stderr_decoder: Utf8Decoder,
    /// A stderr line still being assembled.
    stderr_pending: String,
    finished: bool,
}

impl PiWire {
    /// The limits are compile-time constants that satisfy `JsonElider::new`, so
    /// the only way it fails is a corrected constant.
    #[allow(clippy::expect_used)]
    pub fn new(config: PiWireConfig) -> PiWire {
        PiWire {
            redact: Redactor::new(config.control_secret, config.lease_bearer),
            pending: IndexMap::new(),
            seq: 0,
            writes: VecDeque::new(),
            dialogs: IndexMap::new(),
            waiting_on_human: false,
            rollback: None,
            closed: false,
            stdin_failed: None,
            notes: ace_supervisor::budget::DroppedNotes::new(),
            queued_bytes: 0,
            elider: JsonElider::new(ELISION).expect("the elision limits are valid constants"),
            stdout: JsonLines::new(STDOUT_LINE_BYTES),
            stderr: DroppingGate::new(STDERR_LINE_BYTES),
            stderr_decoder: Utf8Decoder::default(),
            stderr_pending: String::new(),
            finished: false,
        }
    }

    /// `rpc.request` (`rpc.ts:80`–`:94`): validate before reserving anything.
    pub fn request(
        &mut self,
        command: &str,
        params: &Map,
        id: u64,
    ) -> Result<Vec<Effect>, PiError> {
        if self.closed || self.stdin_failed.is_some() {
            return Err(PiError::refused(Refused::Closed));
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(PiError::refused(Refused::Capacity));
        }
        // An oversized command still uses up its number, as today.
        self.seq += 1;
        let correlation = format!("ace-{}", self.seq);
        let line = request_line(command, params, &correlation);
        if line.len() > MAX_FRAME_BYTES {
            return Err(PiError::refused(Refused::FrameLimit));
        }
        let charge = line.len() + 1;
        if self.queued_bytes + charge > MAX_QUEUED_BYTES {
            // Settles through the queue, never as a throw: today it rejects as a
            // plain Error after the request was reserved.
            return Ok(vec![Effect::Settle {
                id,
                result: Err(PiError::uncertain(Uncertain::WriteQueueFull)),
            }]);
        }
        self.pending.insert(
            correlation.clone(),
            Pending {
                command: command.to_owned(),
                facade_id: id,
            },
        );
        let mut effects = Vec::with_capacity(2);
        if !self.waiting_on_human {
            effects.push(Effect::ArmTimer {
                key: deadline_key(&correlation),
                ms: DEADLINE_MS,
            });
        }
        self.queued_bytes += charge;
        self.writes.push_back(WriteRecord {
            text: self.redact.redact(&line),
            facade_id: id,
            correlation: Some(correlation),
            resume_deadlines_after: false,
            charge,
        });
        effects.push(Effect::Write {
            wire: wire_bytes(line),
        });
        Ok(effects)
    }

    /// `rpc.write` (`rpc.ts:70`–`:79`) for a dialog answer: no correlation.
    pub fn write(
        &mut self,
        data: &Map,
        id: u64,
        resume_after: bool,
    ) -> Result<Vec<Effect>, PiError> {
        if self.closed || self.stdin_failed.is_some() {
            return Err(PiError::refused(Refused::Closed));
        }
        let line = ace_json::to_string(&Value::Object(data.clone()));
        if line.len() > MAX_FRAME_BYTES {
            return Err(PiError::refused(Refused::FrameLimit));
        }
        let charge = line.len() + 1;
        if self.queued_bytes + charge > MAX_QUEUED_BYTES {
            return Ok(vec![Effect::Settle {
                id,
                result: Err(PiError::uncertain(Uncertain::WriteQueueFull)),
            }]);
        }
        self.queued_bytes += charge;
        self.writes.push_back(WriteRecord {
            text: self.redact.redact(&line),
            facade_id: id,
            correlation: None,
            resume_deadlines_after: resume_after,
            charge,
        });
        Ok(vec![Effect::Write {
            wire: wire_bytes(line),
        }])
    }

    /// The stdin port refused the `Write` just returned: the pump has ended.
    pub fn write_refused(&mut self) -> Vec<Effect> {
        let Some(record) = self.writes.pop_back() else {
            return Vec::new();
        };
        self.queued_bytes = self.queued_bytes.saturating_sub(record.charge);
        let mut effects = Vec::with_capacity(3);
        match record.correlation {
            Some(correlation) => {
                if self.pending.shift_remove(&correlation).is_some() {
                    effects.push(Effect::CancelTimer {
                        key: deadline_key(&correlation),
                    });
                    effects.push(Effect::Settle {
                        id: record.facade_id,
                        result: Err(PiError::uncertain(Uncertain::StdinClosed)),
                    });
                }
            }
            None => effects.push(Effect::Settle {
                id: record.facade_id,
                result: Err(PiError::uncertain(Uncertain::StdinClosed)),
            }),
        }
        let message = Uncertain::StdinClosed.to_string();
        self.stdin_failed = Some(message.clone());
        effects.push(Effect::Fatal { message });
        effects
    }

    /// One stdin write reached the pipe (`rpc.ts:78`).
    pub fn stdin_written(&mut self) -> Vec<Effect> {
        let Some(record) = self.writes.pop_front() else {
            return Vec::new();
        };
        self.queued_bytes = self.queued_bytes.saturating_sub(record.charge);
        let mut effects = vec![Effect::Frame {
            dir: FrameDir::Send,
            channel: STDIO,
            text: record.text,
        }];
        if record.correlation.is_none() {
            effects.push(Effect::Settle {
                id: record.facade_id,
                result: Ok("null".to_owned()),
            });
        }
        if record.resume_deadlines_after && self.dialogs.is_empty() {
            self.resume_deadlines(&mut effects);
        }
        effects
    }

    /// stdin failed: no later write reaches Pi, and a send may have run.
    pub fn stdin_error(&mut self, message: &str) -> Vec<Effect> {
        let mut effects = Vec::new();
        while let Some(record) = self.writes.pop_front() {
            self.queued_bytes = self.queued_bytes.saturating_sub(record.charge);
            match record.correlation {
                Some(correlation) => {
                    if self.pending.shift_remove(&correlation).is_some() {
                        effects.push(Effect::CancelTimer {
                            key: deadline_key(&correlation),
                        });
                        effects.push(Effect::Settle {
                            id: record.facade_id,
                            result: Err(PiError::uncertain(Uncertain::StdinFailed(
                                message.to_owned(),
                            ))),
                        });
                    }
                }
                None => effects.push(Effect::Settle {
                    id: record.facade_id,
                    result: Err(PiError::uncertain(Uncertain::StdinFailed(
                        message.to_owned(),
                    ))),
                }),
            }
        }
        self.stdin_failed = Some(message.to_owned());
        effects.push(Effect::Fatal {
            message: message.to_owned(),
        });
        effects
    }

    /// One stdout chunk: elide, then frame on LF, then inspect each line.
    pub fn stdout_bytes(&mut self, chunk: &[u8]) -> Vec<Effect> {
        let mut elided = Vec::with_capacity(chunk.len());
        self.elider.push(chunk, &mut elided);
        self.stdout_push(&elided)
    }

    /// One stderr chunk, framed on CR and LF as `lineReader` did.
    pub fn stderr_bytes(&mut self, chunk: &[u8]) -> Vec<Effect> {
        let frames = self.stderr.push(chunk);
        self.stderr_frames(frames)
    }

    /// `rpc.ts:49`–`:63`, then the inspection of `session.ts:217`–`:259`.
    pub fn stdout_line(&mut self, line: &str) -> Vec<Effect> {
        if self.closed {
            return Vec::new();
        }
        let text = self.redact.redact(line);
        let value = match ace_json::parse(&text) {
            Ok(value) => value,
            Err(_) => {
                return vec![Effect::Fatal {
                    message: "Invalid Pi frame".to_owned(),
                }];
            }
        };
        let mut effects = vec![Effect::Frame {
            dir: FrameDir::Recv,
            channel: STDIO,
            text,
        }];
        self.settle_response(&value, &mut effects);
        self.inspect(&value, &mut effects);
        effects
    }

    /// `session.ts:261`–`:265`: redacted, and empty lines skipped.
    pub fn stderr_line(&mut self, line: &str) -> Vec<Effect> {
        if line.is_empty() {
            return Vec::new();
        }
        let text = dialogs::quoted(&self.redact.redact(line));
        vec![Effect::Frame {
            dir: FrameDir::Stderr,
            channel: STDIO,
            text,
        }]
    }

    /// One oversized stderr line the gate dropped (`session.ts:149`).
    pub fn stderr_dropped(&mut self, line: DroppedLine) -> Vec<Effect> {
        let step = self.notes.dropped(line.bytes as u64, line.phase);
        self.note_step(step)
    }

    /// `"deadline:<id>"`, `"dialog:<id>"` or `"notes"`.
    pub fn timer(&mut self, key: &str) -> Vec<Effect> {
        if let Some(id) = key.strip_prefix("deadline:") {
            let Some(pending) = self.pending.shift_remove(id) else {
                return Vec::new();
            };
            return vec![
                Effect::Settle {
                    id: pending.facade_id,
                    result: Err(PiError::uncertain(Uncertain::TimedOut)),
                },
                Effect::Fatal {
                    message: "Pi command timed out".to_owned(),
                },
            ];
        }
        if let Some(id) = key.strip_prefix("dialog:") {
            let timed = self
                .dialogs
                .get(id)
                .is_some_and(|(_, timer)| timer.as_deref() == Some(key));
            if !timed {
                return Vec::new();
            }
            self.dialogs.shift_remove(id);
            let mut effects = Vec::with_capacity(2);
            if self.dialogs.is_empty() {
                self.resume_deadlines(&mut effects);
            }
            effects.push(Effect::Frame {
                dir: FrameDir::Note,
                channel: LIFECYCLE,
                text: dialogs::dialog_expired(id),
            });
            return effects;
        }
        if key == "notes" {
            let step = self.notes.fire();
            return self.note_step(step);
        }
        Vec::new()
    }

    /// The facade's lifecycle notes (`session.ts:193`–`:194`).
    pub fn note(&mut self, json: &str) -> Vec<Effect> {
        vec![Effect::Frame {
            dir: FrameDir::Note,
            channel: LIFECYCLE,
            text: json.to_owned(),
        }]
    }

    /// The dialog as received, without consuming it.
    pub fn peek_dialog(&self, id: &str) -> Option<Value> {
        self.dialogs.get(id).map(|(dialog, _)| dialog.clone())
    }

    /// resolve()'s reservation (`session.ts:435`–`:436`).
    pub fn take_dialog(&mut self, id: &str) -> (bool, Vec<Effect>) {
        match self.dialogs.shift_remove(id) {
            Some((_, Some(key))) => (true, vec![Effect::CancelTimer { key }]),
            Some((_, None)) => (true, Vec::new()),
            None => (false, Vec::new()),
        }
    }

    pub fn dialog_count(&self) -> usize {
        self.dialogs.len()
    }

    pub fn expect_rollback(&mut self, id: String) {
        self.rollback = Some((id, None));
    }

    pub fn rollback_result(&self) -> Option<bool> {
        self.rollback.as_ref().and_then(|(_, success)| *success)
    }

    pub fn clear_rollback(&mut self) {
        self.rollback = None;
    }

    /// The terminal barrier: both framers flush, the notes settle, then `close`.
    pub fn finish(&mut self) -> Vec<Effect> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut effects = Vec::new();

        let mut tail = Vec::new();
        self.elider.end(&mut tail);
        effects.extend(self.stdout_push(&tail));
        if let Some(error) = self.stdout.finish(false) {
            effects.push(Effect::Fatal { message: error });
        }

        let frames = self.stderr.finish();
        effects.extend(self.stderr_frames(frames));
        let mut text = String::new();
        self.stderr_decoder.finish(&mut text);
        self.split_stderr(&text, &mut effects);
        let pending = std::mem::take(&mut self.stderr_pending);
        effects.extend(self.stderr_line(&pending));

        effects.push(Effect::CancelTimer {
            key: "notes".to_owned(),
        });
        if let Some(note) = self.notes.flush() {
            effects.push(Effect::Frame {
                dir: FrameDir::Stderr,
                channel: STDIO,
                text: dialogs::quoted(&note),
            });
        }

        effects.extend(self.close());
        effects.push(Effect::Drained);
        effects
    }

    /// `rpc.ts:113`–`:123`: settle everything, in the writer's order.
    pub fn close(&mut self) -> Vec<Effect> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        let mut effects = Vec::new();
        while let Some(record) = self.writes.pop_front() {
            self.queued_bytes = self.queued_bytes.saturating_sub(record.charge);
            if record.correlation.is_none() {
                effects.push(Effect::Settle {
                    id: record.facade_id,
                    result: Err(PiError::uncertain(Uncertain::Closed)),
                });
            }
        }
        let pending = std::mem::take(&mut self.pending);
        for (id, entry) in pending {
            effects.push(Effect::CancelTimer {
                key: deadline_key(&id),
            });
            effects.push(Effect::Settle {
                id: entry.facade_id,
                result: Err(PiError::uncertain(Uncertain::Closed)),
            });
        }
        effects
    }

    /// `rpc.ts:52`–`:61`: remove the pending entry and settle it.
    fn settle_response(&mut self, value: &Value, effects: &mut Vec<Effect>) {
        let Some(response) = Response::parse(value) else {
            return;
        };
        let Some(pending) = self.pending.shift_remove(&response.id) else {
            return;
        };
        effects.push(Effect::CancelTimer {
            key: deadline_key(&response.id),
        });
        let result = if response.command != pending.command {
            Err(PiError::uncertain(Uncertain::Mismatch))
        } else if !response.success {
            Err(PiError::refused(Refused::Rejected(
                response
                    .error
                    .unwrap_or_else(|| "Pi command rejected".to_owned()),
            )))
        } else {
            Ok(response.data.unwrap_or_else(|| "null".to_owned()))
        };
        effects.push(Effect::Settle {
            id: pending.facade_id,
            result,
        });
    }

    /// `session.ts:217`–`:259`: rollback acknowledgement, dialogs, a bad dialog.
    fn inspect(&mut self, value: &Value, effects: &mut Vec<Effect>) {
        let event_type = dialogs::type_of(value);
        let method = dialogs::method_of(value);
        if event_type == Some("extension_ui_request")
            && method == Some("notify")
            && let (Some((id, success)), Some(message)) =
                (&mut self.rollback, dialogs::message_of(value))
            && let Some(ack) = dialogs::rollback_ack(message, id.as_str())
        {
            *success = Some(ack);
        }
        if let Some(dialog) = Dialog::parse(value) {
            if self.dialogs.contains_key(&dialog.id) {
                return;
            }
            let timer = dialog.timeout.map(|ms| {
                let key = format!("dialog:{}", dialog.id);
                effects.push(Effect::ArmTimer {
                    key: key.clone(),
                    ms,
                });
                key
            });
            self.dialogs
                .insert(dialog.id.clone(), (value.clone(), timer));
            self.pause_deadlines(effects);
            return;
        }
        if event_type == Some("extension_ui_request")
            && let Some(method) = method
            && crate::translate::native::is_blocking_dialog_method(method)
        {
            effects.push(Effect::Fatal {
                message: "Pi RPC closed".to_owned(),
            });
        }
    }

    /// `rpc.pauseDeadlines` (`rpc.ts:95`–`:98`).
    fn pause_deadlines(&mut self, effects: &mut Vec<Effect>) {
        self.waiting_on_human = true;
        for id in self.pending.keys() {
            effects.push(Effect::CancelTimer {
                key: deadline_key(id),
            });
        }
    }

    /// `rpc.resumeDeadlines` (`rpc.ts:99`–`:103`).
    fn resume_deadlines(&mut self, effects: &mut Vec<Effect>) {
        if !self.waiting_on_human || self.closed {
            return;
        }
        self.waiting_on_human = false;
        for id in self.pending.keys() {
            effects.push(Effect::ArmTimer {
                key: deadline_key(id),
                ms: DEADLINE_MS,
            });
        }
    }

    fn note_step(&self, step: NoteStep) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Some(note) = step.note {
            effects.push(Effect::Frame {
                dir: FrameDir::Stderr,
                channel: STDIO,
                text: dialogs::quoted(&note),
            });
        }
        if step.arm {
            effects.push(Effect::ArmTimer {
                key: "notes".to_owned(),
                ms: NOTES_MS,
            });
        }
        effects
    }

    fn stdout_push(&mut self, chunk: &[u8]) -> Vec<Effect> {
        let push = self.stdout.push(chunk);
        let mut effects = Vec::new();
        for line in lines(&push.lines) {
            effects.extend(self.stdout_line(line));
        }
        if let Some(error) = push.error {
            effects.push(Effect::Fatal { message: error });
        }
        effects
    }

    fn stderr_frames(&mut self, frames: Vec<Framed>) -> Vec<Effect> {
        let mut effects = Vec::new();
        for frame in frames {
            match frame {
                Framed::Data(bytes) => {
                    let mut text = String::new();
                    self.stderr_decoder.push(&bytes, &mut text);
                    self.split_stderr(&text, &mut effects);
                }
                Framed::Drop(line) => effects.extend(self.stderr_dropped(line)),
            }
        }
        effects
    }

    /// Lines end at CR, LF or CRLF; an empty line is skipped by `stderr_line`.
    fn split_stderr(&mut self, text: &str, effects: &mut Vec<Effect>) {
        let mut pending = std::mem::take(&mut self.stderr_pending);
        pending.push_str(text);
        let mut start = 0;
        for (at, character) in pending.char_indices() {
            if character != '\r' && character != '\n' {
                continue;
            }
            if at > start {
                effects.extend(self.stderr_line(&pending[start..at]));
            }
            start = at + character.len_utf8();
        }
        self.stderr_pending = pending[start..].to_owned();
    }
}

fn deadline_key(id: &str) -> String {
    format!("deadline:{id}")
}

/// `JSON.stringify({type: command, ...params, id})`, key order and overwrites included.
fn request_line(command: &str, params: &Map, correlation: &str) -> String {
    let mut map = Map::with_capacity(params.len() + 2);
    map.insert("type", Value::String(JsString::from(command)));
    for (key, value) in params {
        map.insert(key.clone(), value.clone());
    }
    map.insert("id", Value::String(JsString::from(correlation)));
    ace_json::to_string(&Value::Object(map))
}

fn wire_bytes(line: String) -> Vec<u8> {
    let mut bytes = line.into_bytes();
    bytes.push(b'\n');
    bytes
}

/// Every record a `FramedLines` holds, in order.
fn lines(framed: &FramedLines) -> impl Iterator<Item = &str> {
    let count = framed.count;
    framed
        .text
        .split('\n')
        .take(count)
        .filter(|line| !line.is_empty())
}
