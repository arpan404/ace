// SPDX-License-Identifier: Apache-2.0
//! The session's channel and its exit evidence (`sessionLifetime`,
//! `session-lifetime.ts`): the stderr tail, the deliberate retirement, the one
//! close every other stop joins, and the exit diagnostic the engine logs.
//! Channel and exit evidence stay outside translation and policy logic.
//!
//! The close's own I/O (`channel.retire`, `channel.detach`, `stopWork`) is the
//! shell's: each branch is an effect, and its outcome comes back as an input, so
//! one close resolves only when its branch is confirmed.

use ace_json::{Map, Value};

use super::frames::{Effect, FrameDir, Frames};
use super::host::{HostExit, Retirement};

/// How much stderr the exit evidence keeps (`session-lifetime.ts:96`).
const STDERR_BYTES: usize = 4096;
/// How much of it the diagnostic summarises (`stderrSummary`).
const STDERR_SUMMARY: usize = 1024;

/// The text redactor `createTextRedactor` (`@ace/redaction`) supplies: the
/// workspace, the home directory, the host name and every environment value
/// become placeholders. It is the shell's, and every line is scrubbed before it
/// is retained or emitted.
pub type Redactor = Box<dyn Fn(&str) -> String + Send + Sync>;

/// What a close is waiting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// `channel.retire()`: the host is stopping.
    Retire,
    /// `stopWork()`: the root interrupt with `cascade: true`.
    Work,
    /// `channel.detach()`: this tenant lets go of a shared host.
    Detach,
}

/// The one close a session runs (`closePromise`).
#[derive(Debug, Clone, PartialEq)]
enum Run {
    /// In flight; `awaited` is false for a stop nobody waits on.
    Running {
        stage: Stage,
        reason: Retirement,
        awaited: bool,
        message: String,
    },
    /// Settled: every later close joins this outcome.
    Settled(Result<(), String>),
}

/// A channel's state, as the lifetime reads it (`CodexChannel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Channel {
    shared: bool,
    alone: bool,
    gone: bool,
}

/// `sessionLifetime`. It owns the stderr tail, the retirement and the close.
pub struct Lifetime {
    generation: String,
    redact: Redactor,
    stderr: String,
    retirement: Option<Retirement>,
    closed: bool,
    exited: bool,
    cleaned: bool,
    channel: Option<Channel>,
    run: Option<Run>,
}

impl Lifetime {
    pub fn new(generation: String, redact: Redactor) -> Lifetime {
        Lifetime {
            generation,
            redact,
            stderr: String::new(),
            retirement: None,
            closed: false,
            exited: false,
            cleaned: false,
            channel: None,
            run: None,
        }
    }

    /// `lifetime.attached(link)`.
    pub fn attached(&mut self, shared: bool, alone: bool) {
        self.channel = Some(Channel {
            shared,
            alone,
            gone: false,
        });
    }

    /// `channel.alone` moves as tenants attach and detach.
    pub fn set_alone(&mut self, alone: bool) {
        if let Some(channel) = self.channel.as_mut() {
            channel.alone = alone;
        }
    }

    /// `channel.gone`: the process is gone, so a stop cannot make it deliberate.
    pub fn set_gone(&mut self) {
        if let Some(channel) = self.channel.as_mut() {
            channel.gone = true;
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn is_exited(&self) -> bool {
        self.exited
    }

    pub fn retirement(&self) -> Option<Retirement> {
        self.retirement
    }

    pub fn stderr_tail(&self) -> &str {
        &self.stderr
    }

    /// `lifetime.stderr(line)`: scrub, then keep the tail. Scrubbing comes
    /// before slicing, so neither a split credential nor a raw frame enters the
    /// retained bytes, and the encoded bound survives replacement.
    pub fn stderr_line(&mut self, frames: &Frames, line: &str) -> Vec<Effect> {
        let safe = (self.redact)(line);
        let mut bytes = Vec::with_capacity(self.stderr.len() + safe.len() + 1);
        bytes.extend_from_slice(self.stderr.as_bytes());
        bytes.extend_from_slice(safe.as_bytes());
        bytes.push(b'\n');
        if bytes.len() > STDERR_BYTES {
            bytes.drain(..bytes.len() - STDERR_BYTES);
        }
        // A tail can begin inside a UTF-8 sequence: decode leniently, then trim
        // to the encoded bound one character at a time.
        let mut tail = String::from_utf8_lossy(&bytes).into_owned();
        while tail.len() > STDERR_BYTES {
            let mut chars = tail.chars();
            chars.next();
            tail = chars.as_str().to_owned();
        }
        self.stderr = tail;
        emit(frames, FrameDir::Stderr, &Value::from(safe), "stdio")
    }

    /// `close(reason)`: the same close every caller joins.
    pub fn close(&mut self, reason: Retirement, busy: bool) -> Vec<Effect> {
        self.stop(
            reason,
            format!("Codex session closed ({})", reason.as_str()),
            busy,
            true,
        )
    }

    /// `stopUnawaited("aborted")`, with the signal's own reason for the detach
    /// error.
    pub fn abort(&mut self, frames: &Frames, signal_reason: String, busy: bool) -> Vec<Effect> {
        self.stop_unawaited(frames, Retirement::Aborted, signal_reason, busy)
    }

    /// `failOpen`: a stop the caller awaits, reported as `open_failed`.
    pub fn fail_open(&mut self, busy: bool) -> Vec<Effect> {
        self.stop(
            Retirement::OpenFailed,
            "Codex session closed (open_failed)".to_owned(),
            busy,
            true,
        )
    }

    /// `failTransport`: fire-and-forget from RPC callbacks; a failed stop is
    /// recorded on the session.
    pub fn fail_transport(&mut self, frames: &Frames, busy: bool) -> Vec<Effect> {
        self.stop_unawaited(
            frames,
            Retirement::RpcFailed,
            "Codex session closed (rpc_failed)".to_owned(),
            busy,
        )
    }

    /// `exited(exit)`: the process is gone for good.
    pub fn exited(&mut self, frames: &Frames, exit: &HostExit) -> Vec<Effect> {
        self.exited = true;
        self.closed = true;
        let mut effects = self.cleanup();
        let deliberate = matches!(
            self.retirement,
            Some(reason)
                if reason != Retirement::OpenFailed && reason != Retirement::RpcFailed
        );
        let mut diagnostic = Map::new();
        diagnostic.insert("event", Value::from("codex-session-exit"));
        diagnostic.insert("generation", Value::from(self.generation.clone()));
        diagnostic.insert("deliberate", Value::Bool(deliberate));
        diagnostic.insert(
            "retirement",
            self.retirement
                .map(|reason| Value::from(reason.as_str()))
                .unwrap_or(Value::Null),
        );
        diagnostic.insert("reason", Value::from(exit.reason.as_str()));
        diagnostic.insert(
            "code",
            exit.code
                .map(|code| Value::from(i64::from(code)))
                .unwrap_or(Value::Null),
        );
        diagnostic.insert(
            "signal",
            exit.signal.clone().map(Value::from).unwrap_or(Value::Null),
        );
        if let Some(pid) = exit.pid {
            diagnostic.insert("pid", Value::from(u64::from(pid)));
        }
        diagnostic.insert("stderrSummary", Value::from(summary(&self.stderr)));
        diagnostic.insert("outputDrained", Value::Bool(exit.output_drained));
        diagnostic.insert("stderr", Value::from(self.stderr.clone()));
        let diagnostic = Value::Object(diagnostic);
        effects.extend(emit(frames, FrameDir::Note, &diagnostic, "stdio"));
        let message = format!(
            "Codex app-server {}: {}",
            match self.retirement {
                Some(reason) if deliberate => format!("retired ({})", reason.as_str()),
                _ => "disconnected".to_owned(),
            },
            ace_json::to_string(&diagnostic)
        );
        effects.push(Effect::Exited {
            deliberate,
            message,
        });
        effects
    }

    /// `run.cleanup()`: the session's state is released, once.
    fn cleanup(&mut self) -> Vec<Effect> {
        if self.cleaned {
            return Vec::new();
        }
        self.cleaned = true;
        vec![Effect::Cleanup]
    }

    fn stop_unawaited(
        &mut self,
        frames: &Frames,
        reason: Retirement,
        message: String,
        busy: bool,
    ) -> Vec<Effect> {
        match &self.run {
            None => self.stop(reason, message, busy, false),
            // The same promise, whose failure is recorded once per join.
            Some(Run::Settled(Err(failure))) => self.stop_failed(frames, reason, failure),
            Some(_) => Vec::new(),
        }
    }

    /// `stopUnawaited`'s catch: the failure is a note on the session.
    fn stop_failed(&self, frames: &Frames, reason: Retirement, message: &str) -> Vec<Effect> {
        let mut note = Map::new();
        note.insert("event", Value::from("codex-stop-failed"));
        note.insert("retirement", Value::from(reason.as_str()));
        note.insert("message", Value::from((self.redact)(message)));
        emit(frames, FrameDir::Note, &Value::Object(note), "stdio")
    }

    /// `stop(reason)`, branch for branch. Retiring only finishes cleanup once
    /// the process died: it cannot make the loss deliberate.
    fn stop(
        &mut self,
        reason: Retirement,
        message: String,
        busy: bool,
        awaited: bool,
    ) -> Vec<Effect> {
        if let Some(Run::Settled(outcome)) = &self.run {
            return vec![Effect::Closed(outcome.clone())];
        }
        if self.run.is_some() {
            // A close is already in flight; its own branch settles it.
            return Vec::new();
        }
        let gone = self.channel.is_some_and(|channel| channel.gone);
        if !self.exited && !gone {
            self.retirement = Some(reason);
        }
        self.closed = true;
        let stage = match self.channel {
            Some(_) if self.exited => None,
            None => None,
            Some(channel) if channel.shared && channel.alone && busy => Some(Stage::Retire),
            Some(channel) if channel.shared && busy => Some(Stage::Work),
            Some(_) => Some(Stage::Detach),
        };
        let Some(stage) = stage else {
            // Nothing to detach from: cleanup finishes the close at once.
            self.run = Some(Run::Settled(Ok(())));
            let mut effects = self.cleanup();
            effects.push(Effect::Closed(Ok(())));
            return effects;
        };
        self.run = Some(Run::Running {
            stage,
            reason,
            awaited,
            message,
        });
        let mut effects = self.cleanup();
        effects.extend(self.branch());
        effects
    }

    /// The effect the close's current stage waits on.
    fn branch(&mut self) -> Vec<Effect> {
        let Some(Run::Running {
            stage,
            reason,
            message,
            ..
        }) = self.run.clone()
        else {
            return Vec::new();
        };
        match stage {
            Stage::Retire => vec![Effect::Retire { reason }],
            Stage::Work => vec![Effect::StopWork { reason }],
            Stage::Detach => vec![Effect::Detach { reason, message }],
        }
    }

    /// `channel.retire()` returned. A stop that did not land rejects the close.
    pub fn retired(&mut self, frames: &Frames, result: Result<(), String>) -> Vec<Effect> {
        self.settle(frames, result)
    }

    /// `stopWork()` returned.
    pub fn work_stopped(&mut self, result: Result<(), String>) -> Vec<Effect> {
        let Some(Run::Running { .. }) = self.run else {
            return Vec::new();
        };
        let next = match result {
            // Unconfirmed work cannot be left running unobserved: stop the
            // process instead, which ends the work exactly.
            Err(_) => Stage::Retire,
            Ok(()) => Stage::Detach,
        };
        if let Some(Run::Running { stage, .. }) = self.run.as_mut() {
            *stage = next;
        }
        self.branch()
    }

    /// `channel.detach()` returned.
    pub fn detached(&mut self, frames: &Frames, result: Result<(), String>) -> Vec<Effect> {
        self.settle(frames, result)
    }

    /// The close's outcome, once.
    fn settle(&mut self, frames: &Frames, outcome: Result<(), String>) -> Vec<Effect> {
        let Some(Run::Running {
            reason, awaited, ..
        }) = self.run.clone()
        else {
            return Vec::new();
        };
        self.run = Some(Run::Settled(outcome.clone()));
        let mut effects = vec![Effect::Closed(outcome.clone())];
        if !awaited && let Err(message) = outcome {
            effects.extend(self.stop_failed(frames, reason, &message));
        }
        effects
    }
}

/// One frame through the session's emitter, or nothing when the bound refuses
/// it (a note is small, so only a defect reaches that).
fn emit(frames: &Frames, dir: FrameDir, data: &Value, channel: &'static str) -> Vec<Effect> {
    match frames.emit(dir, data, channel, None) {
        Ok(emitted) => emitted.frames.into_iter().map(Effect::from).collect(),
        Err(_) => Vec::new(),
    }
}

/// `stderr.slice(-1024)`: the tail's last 1,024 characters. JavaScript counts
/// UTF-16 units, so a boundary inside a surrogate pair is the one place a
/// JavaScript diagnostic can carry a lone surrogate; a Rust string cannot, and
/// keeps the whole character.
fn summary(stderr: &str) -> String {
    let mut chars = stderr
        .chars()
        .rev()
        .take(STDERR_SUMMARY)
        .collect::<Vec<char>>();
    chars.reverse();
    chars.into_iter().collect()
}

#[cfg(test)]
mod tests;
