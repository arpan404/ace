// SPDX-License-Identifier: Apache-2.0
//! The Claude wire core, part 1: sans-IO state for the session side of `sdk-process.ts` and the
//! half of `session.ts` that runs per received line. One input produces its effects in the order
//! the state changed; the I/O shell (E3-claude.4) owns the lock, the clock, the timers and the
//! child.
//!
//! Ported from `sdk-process.ts:63`-`:99` (classification, `malformed_stdout`), `:104` (stderr)
//! with `:36`-`:40`'s drop notes, `session.ts:86`-`:100`, `:247`-`:253` and `:281`-`:321` (the
//! pump: confirmation, frame, tasks, rate limit), and `session-tasks.ts` in `tasks.rs`. section 4
//! of claude-session.md is the hot path: one parse, one capture, moves only.

use ace_json::{Map, Value};
use std::borrow::Cow;

use ace_supervisor::budget::{DroppedLine, DroppedNotes, DroppingGate, Framed, NoteStep};
use ace_supervisor::lines::{FramedLines, LineFramer, SHIELD, restore};
use agent_stream_json::Controls;
use agent_stream_json::{Line, MessageKind, classify};

use crate::session::capture::capture;
use crate::session::error::ClaudeError;
use crate::session::input::Writes;
use crate::session::interactions::Interactions;
use crate::session::tasks::SessionTasks;
pub use crate::session::{Effect, FrameDir, WireConfig};

/// The frame channel for the eleven message types and for `control_cancel_request`.
const SDK: &str = "sdk";
/// The frame channel for every other control line, unknown types and malformed stdout.
pub(crate) const WIRE: &str = "wire";
/// The note channels the facade sends (`claude-session.md` section 2).
const LIFECYCLE: &str = "lifecycle";
const COMMANDS: &str = "commands.runtime";
const CATALOG: &str = "catalog.runtime";
const ACCOUNTS: &str = "accounts";
const RECEIPT: &str = "interrupt_receipt";
/// `spawnSdkProcess`'s `maxLineBytes` (`sdk-process.ts:50`), also the outbound line bound.
pub(crate) const LINE_BYTES: usize = 16 * 1024 * 1024;
/// `droppedLineNotes`' default interval (`dropped-line-notes.ts:26`).
const NOTES_MS: f64 = 1_000.0;
/// The timer key the drop notes share.
const NOTES_KEY: &str = "notes";
/// `ensureOpen`'s text, which a pending control settles with at finish.
pub(crate) const CLOSED: &str = "Claude session is closed";
/// claude-session.md intended difference 5: an outbound line over 16 MiB.
pub(crate) const OUTBOUND: &str = "Claude outbound frame capacity reached";

pub struct ClaudeWire {
    pub(crate) config: WireConfig,
    pub(crate) controls: Controls,
    pub(crate) interactions: Interactions,
    pub(crate) writes: Writes,
    /// The `UserPromptSubmit` callbacks still waiting for `answer_hook`.
    pub(crate) pending_hooks: Vec<String>,
    tasks: SessionTasks,
    stdout: LineFramer,
    stderr: DroppingGate,
    /// The stderr lines `DroppingGate` kept: decode and split them (P2).
    stderr_lines: LineFramer,
    notes: DroppedNotes,
    confirmed: bool,
    pub(crate) finished: bool,
    /// A failed line was reported; every later input is ignored.
    pub(crate) failed: bool,
    /// stdin is still open: only then does an expiry write its default answers.
    pub(crate) input_open: bool,
    /// What the last `initialize` this wire wrote declared, in order (event, callback ids).
    pub(crate) declared_hooks: Vec<(String, Vec<String>)>,
}

impl ClaudeWire {
    pub fn new(config: WireConfig) -> ClaudeWire {
        let confirmed = config.resume;
        ClaudeWire {
            config,
            controls: Controls::new(),
            interactions: Interactions::new(),
            writes: Writes::new(),
            pending_hooks: Vec::new(),
            tasks: SessionTasks::new(),
            stdout: LineFramer::new(LINE_BYTES),
            stderr: DroppingGate::new(LINE_BYTES),
            stderr_lines: LineFramer::new(LINE_BYTES),
            notes: DroppedNotes::new(),
            confirmed,
            finished: false,
            failed: false,
            input_open: true,
            declared_hooks: Vec::new(),
        }
    }

    /// One stdout chunk: frame on LF, then inspect each line. A line over 16 MiB is fatal, as
    /// today's gate aborts the process rather than dropping it (`process.ts:256`-`:268`, no
    /// `onStdoutLineDropped`).
    pub fn stdout_bytes(&mut self, chunk: &[u8]) -> Vec<Effect> {
        if self.finished || self.failed {
            return Vec::new();
        }
        match self.stdout.push(chunk) {
            Ok(lines) => self.stdout_framed(&lines),
            Err(message) => vec![self.fatal(message)],
        }
    }

    fn stdout_framed(&mut self, framed: &FramedLines) -> Vec<Effect> {
        let mut effects = Vec::new();
        for line in lines(framed) {
            let mut line_effects = self.stdout_line(&unshield(line));
            let fatal = line_effects
                .iter()
                .any(|effect| matches!(effect, Effect::Fatal { .. }));
            effects.append(&mut line_effects);
            if fatal {
                break;
            }
        }
        effects
    }

    /// One stderr chunk: the same 16 MiB bound, but an oversized line is dropped and noted
    /// (`spawnSdkProcess` passes `onStderrLineDropped`, `sdk-process.ts:50`).
    pub fn stderr_bytes(&mut self, chunk: &[u8]) -> Vec<Effect> {
        if self.finished || self.failed {
            return Vec::new();
        }
        let frames = self.stderr.push(chunk);
        self.stderr_frames(frames)
    }

    /// A facade note: `{"channel": "<name>", "data": <value>}`. The wire captures `data` and
    /// emits it on that note channel. A note is the facade's own data, so an unknown channel or
    /// unparsable JSON is a facade bug: the debug build asserts and the release reports `Fatal`.
    pub fn note(&mut self, json: &str) -> Vec<Effect> {
        if self.finished || self.failed {
            return Vec::new();
        }
        let Ok(value) = ace_json::parse(json) else {
            debug_assert!(false, "a note is the facade's own JSON");
            return vec![self.fatal("Claude note is not valid JSON".to_owned())];
        };
        let Some(object) = value.as_object() else {
            debug_assert!(false, "a note is a facade object");
            return vec![self.fatal("Claude note is not valid JSON".to_owned())];
        };
        let channel = match object.get("channel").and_then(Value::as_str) {
            Some("lifecycle") => LIFECYCLE,
            Some("commands.runtime") => COMMANDS,
            Some("catalog.runtime") => CATALOG,
            Some("accounts") => ACCOUNTS,
            Some("interrupt_receipt") => RECEIPT,
            _ => {
                debug_assert!(false, "a note names a known channel");
                return vec![self.fatal("Claude note has an unknown channel".to_owned())];
            }
        };
        let data = object.get("data").unwrap_or(&Value::Null);
        self.framed(FrameDir::Note, channel, data)
    }

    /// The drop notes' interval. Other keys arrive with E3-claude.3.
    pub fn timer(&mut self, key: &str) -> Vec<Effect> {
        if self.finished || self.failed {
            return Vec::new();
        }
        if key == NOTES_KEY {
            let step = self.notes.fire();
            return self.note_step(step);
        }
        Vec::new()
    }

    /// `SessionTasks.resolve(spawn)` as the task's JSON (`session-tasks.ts:76`).
    pub fn task_target(&self, spawn: &str) -> Option<String> {
        self.tasks.task_target(spawn)
    }

    /// `SessionTasks.cascade(spawn)` as `{ids, uncertain}` (`session-tasks.ts:88`).
    pub fn task_cascade(&self, spawn: Option<&str>) -> String {
        self.tasks.cascade(spawn)
    }

    /// `q.close()`'s input close: no later expiry writes a default answer.
    pub(crate) fn end_input(&mut self) {
        self.input_open = false;
    }

    /// The terminal barrier: finalize the framers, flush the drop notes, expire every pending
    /// interaction, settle every pending control, then `Drained`.
    pub fn finish(&mut self) -> Vec<Effect> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        self.end_input();
        let mut effects = Vec::new();

        let tail = self.stdout.finish();
        effects.extend(self.stdout_framed(&tail));

        let frames = self.stderr.finish();
        effects.extend(self.stderr_frames(frames));
        let tail = self.stderr_lines.finish();
        effects.extend(self.stderr_framed(&tail));

        effects.push(Effect::CancelTimer {
            key: NOTES_KEY.to_owned(),
        });
        if let Some(note) = self.notes.flush() {
            effects.extend(self.stderr_note(&note));
        }

        // The terminal expiry: every interaction ends once, and its default answer only while
        // stdin is open (`session.ts:104`, `:117`).
        effects.extend(self.expire_pending());

        for tag in self.controls.drain() {
            effects.push(Effect::Settle {
                id: tag,
                result: Err(ClaudeError::Uncertain(CLOSED.to_owned())),
            });
        }
        effects.push(Effect::Drained);
        effects
    }

    /// section 4's hot path: one parse, `classify`, then the frame and what the line tells the
    /// session, in `session.ts:286`-`:306`'s order.
    fn stdout_line(&mut self, line: &str) -> Vec<Effect> {
        let Ok(value) = ace_json::parse(line) else {
            let malformed = malformed_stdout(line);
            return self.framed(FrameDir::Recv, WIRE, &malformed);
        };
        let mut effects = Vec::new();
        match classify(value) {
            Line::Message { kind, value } => {
                if self.confirms(kind, &value) {
                    self.confirmed = true;
                    effects.push(Effect::Callback {
                        name: "onSessionConfirmed",
                        json: ace_json::to_string(&Value::from(self.config.session_id.as_str())),
                    });
                }
                match self.frame(FrameDir::Recv, SDK, &value) {
                    Ok(effect) => effects.push(effect),
                    Err(message) => {
                        // `frame('recv','sdk',...)` threw inside the pump: `String(error)` keeps
                        // the class prefix, which ends the session.
                        let effect = self.fatal(format!("RangeError: {message}"));
                        effects.push(effect);
                        return effects;
                    }
                }
                if let Err(error) = self.tasks.observe(&value) {
                    let effect = self.fatal(format!("Error: {error}"));
                    effects.push(effect);
                    return effects;
                }
                if kind == MessageKind::RateLimitEvent
                    && let Some(info) = value.get("rate_limit_info").filter(|info| info.is_object())
                {
                    effects.push(Effect::Callback {
                        name: "onRateLimit",
                        json: ace_json::to_string(info),
                    });
                }
            }
            // A control request the CLI sent: its `recv`/`wire` frame, then the channel ask.
            Line::HostRequest {
                request_id,
                request,
                value,
            } => {
                match self.frame(FrameDir::Recv, WIRE, &value) {
                    Ok(effect) => effects.push(effect),
                    Err(message) => {
                        let effect = self.fatal(format!("RangeError: {message}"));
                        effects.push(effect);
                        return effects;
                    }
                }
                effects.extend(self.host_request(&request_id, request, &value));
            }
            Line::ControlResponse {
                request_id,
                outcome,
                value,
            } => {
                match self.frame(FrameDir::Recv, WIRE, &value) {
                    Ok(effect) => effects.push(effect),
                    Err(message) => {
                        let effect = self.fatal(format!("RangeError: {message}"));
                        effects.push(effect);
                        return effects;
                    }
                }
                effects.extend(self.control_settled(&request_id, outcome, &value));
            }
            // `session.ts:247`-`:253`: cancel first, then the `sdk` frame.
            Line::Cancel { request_id, value } => {
                effects.extend(self.interaction_cancelled(&request_id));
                effects.extend(self.framed(FrameDir::Recv, SDK, &value));
            }
            // A string-typed unknown is `recv/wire` and then `recv/sdk`: the SDK yields it to
            // the iterator too, and the pump frames it again (seq 5-8). A line whose `type` is
            // not a string stops at `onWire` (`sdk-process.ts:72`-`:75`), so it gets one frame.
            Line::Unknown { value } => match self.frame(FrameDir::Recv, WIRE, &value) {
                Ok(Effect::Frame { text, .. }) => {
                    effects.push(Effect::Frame {
                        dir: FrameDir::Recv,
                        channel: WIRE,
                        text: text.clone(),
                    });
                    if value.get("type").and_then(Value::as_str).is_some() {
                        effects.push(Effect::Frame {
                            dir: FrameDir::Recv,
                            channel: SDK,
                            text,
                        });
                    }
                }
                Ok(effect) => effects.push(effect),
                Err(message) => {
                    let effect = self.fatal(format!("RangeError: {message}"));
                    effects.push(effect);
                }
            },
        }
        effects
    }

    /// The confirmation rule: `system/init` or a parentless `user` line naming the session, once.
    fn confirms(&self, kind: MessageKind, value: &Value) -> bool {
        if self.confirmed {
            return false;
        }
        let named = value.get("session_id").and_then(Value::as_str)
            == Some(self.config.session_id.as_str());
        if !named {
            return false;
        }
        match kind {
            MessageKind::System => value.get("subtype").and_then(Value::as_str) == Some("init"),
            MessageKind::User => falsy(value.get("parent_tool_use_id")),
            _ => false,
        }
    }

    /// One captured frame, or the `Fatal` its capture failure becomes. `sdk-process.ts`'s line
    /// listener does not catch `onWire`'s throw: it reaches the readline consumer
    /// (`line-reader.ts:99`), which stops stdout, so the session ends. `Fatal` ends it the same
    /// way (behaviour.md section 14 records the intended difference).
    pub(crate) fn framed(
        &mut self,
        dir: FrameDir,
        channel: &'static str,
        value: &Value,
    ) -> Vec<Effect> {
        match self.frame(dir, channel, value) {
            Ok(effect) => vec![effect],
            Err(message) => {
                let effect = self.fatal(format!("RangeError: {message}"));
                vec![effect]
            }
        }
    }

    pub(crate) fn frame(
        &self,
        dir: FrameDir,
        channel: &'static str,
        value: &Value,
    ) -> Result<Effect, String> {
        self.capture(value)
            .map(|text| Effect::Frame { dir, channel, text })
    }

    /// The one capture per frame: elide, redact the bearer, then the bounds.
    pub(crate) fn capture(&self, value: &Value) -> Result<String, String> {
        capture(value, self.config.bearer.as_deref()).map_err(|error| error.to_string())
    }

    /// Report a failure and latch: nothing after a `Fatal` reaches the CLI or the frames.
    pub(crate) fn fatal(&mut self, message: String) -> Effect {
        self.failed = true;
        Effect::Fatal { message }
    }

    fn stderr_frames(&mut self, frames: Vec<Framed>) -> Vec<Effect> {
        let mut effects = Vec::new();
        for frame in frames {
            match frame {
                Framed::Data(bytes) => match self.stderr_lines.push(&bytes) {
                    Ok(lines) => effects.extend(self.stderr_framed(&lines)),
                    Err(message) => {
                        let fatal = self.fatal(message);
                        effects.push(fatal);
                    }
                },
                Framed::Drop(line) => effects.extend(self.stderr_dropped(line)),
            }
        }
        effects
    }

    fn stderr_framed(&mut self, framed: &FramedLines) -> Vec<Effect> {
        let mut effects = Vec::new();
        for line in lines(framed) {
            effects.extend(self.stderr_line(&unshield(line)));
        }
        effects
    }

    /// `onStderr`: `frame("stderr","sdk", line)` (`session.ts:246`).
    fn stderr_line(&mut self, line: &str) -> Vec<Effect> {
        self.stderr_note(line)
    }

    fn stderr_note(&mut self, line: &str) -> Vec<Effect> {
        self.framed(FrameDir::Stderr, SDK, &Value::from(line))
    }

    /// One oversized stderr line the gate dropped (`sdk-process.ts:36`-`:40`).
    fn stderr_dropped(&mut self, line: DroppedLine) -> Vec<Effect> {
        let step = self.notes.dropped(line.bytes as u64, line.phase);
        self.note_step(step)
    }

    fn note_step(&mut self, step: NoteStep) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Some(note) = step.note {
            effects.extend(self.stderr_note(&note));
        }
        if step.arm {
            effects.push(Effect::ArmTimer {
                key: NOTES_KEY.to_owned(),
                ms: NOTES_MS,
            });
        }
        effects
    }
}

/// Every record a `FramedLines` holds, in order.
fn lines(framed: &FramedLines) -> impl Iterator<Item = &str> {
    let count = framed.count;
    framed.text.split('\n').take(count)
}

/// A line's text with `LineFramer`'s U+2028/U+2029 shield undone, copied only when shielded.
fn unshield(line: &str) -> Cow<'_, str> {
    if line.contains(SHIELD) {
        Cow::Owned(restore(line))
    } else {
        Cow::Borrowed(line)
    }
}

/// `{type: "malformed_stdout", line}` (`sdk-process.ts:66`-`:71`).
fn malformed_stdout(line: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type", Value::from("malformed_stdout"));
    map.insert("line", Value::from(line));
    Value::Object(map)
}

/// JavaScript truthiness, which `!data["parent_tool_use_id"]` used.
fn falsy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Bool(flag)) => !*flag,
        Some(Value::Number(number)) => {
            let value = number.value();
            value == 0.0 || value.is_nan()
        }
        Some(Value::String(text)) => text.is_empty(),
        Some(_) => false,
    }
}

#[cfg(test)]
mod tests;
