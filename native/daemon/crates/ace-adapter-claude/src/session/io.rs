// SPDX-License-Identifier: Apache-2.0
//! The Claude session's tokio side (E3-claude.4): an ordering gate over every input, the wire
//! state, one ordered queue, the read gate the child's pumps answer, and the child's ports. An
//! input - an output chunk, a binding call, a timer - is the one `ClaudeWire` method, then its
//! `Write`s to the child's stdin and one publish, all under `turn`, so two inputs never
//! interleave their state, writes or events. The state's own lock is never held across a write,
//! a publish or the gate: a slow consumer must not stop the wire from being read or changed
//! (ADR 0223 section 7 rules 3-4).

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::session::error::ClaudeError;
use crate::session::wire::{ClaudeWire, Effect, WireConfig};
use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionErrorWire, SessionEvent};
use ace_supervisor::divert::{ChildPorts, OutputConsumer};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::spawn::{Delivered, OutputStream, RawExit};

/// The inherited-pipe cutoff: 1,000 ms after the leader's exit (`session.ts:120`, `:262`-`:266`).
const CUTOFF: &str = "cutoff";
const CUTOFF_MS: f64 = 1_000.0;

/// The variables the session adds to ace's environment (`session.ts:241`): ace's client-app
/// marker, and the session-state read the recorded 2.1.331 handshake shows the harness sets and
/// nothing else (claude-session.md Q3, `fixtures/claude/handshake-2.1.331/env-added.json`).
pub const SESSION_ENV: [(&str, &str); 2] = [
    ("CLAUDE_AGENT_SDK_CLIENT_APP", "ace/0.0.0"),
    ("CLAUDE_CODE_SDK_READS_SESSION_STATE", "1"),
];

/// The environment the child is spawned with: ace's own, and then the session's variables, so
/// ace's value wins over one a caller left in place (`{ ...env, … , CLAUDE_… : "1" }`).
pub fn session_env(base: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base
        .into_iter()
        .filter(|(name, _)| !SESSION_ENV.iter().any(|(own, _)| own == name))
        .collect();
    env.extend(
        SESSION_ENV
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
    );
    env
}

/// The message a session reports once for its exit (`session.ts:101`-`:109`, `:257`-`:268`): a
/// recorded failure wins, else the process's own end, which reads its code, then its signal,
/// then the shell's reason. An end with none of the three cannot happen today (node reports a
/// code or a signal), so the last arm names it rather than inventing one of them.
pub fn exit_message(failure: Option<&str>, exit: &RawExit, reason: Option<&str>) -> String {
    if let Some(message) = failure {
        return message.to_owned();
    }
    let end = match (&exit.code, &exit.signal) {
        (Some(code), _) => code.to_string(),
        (None, Some(signal)) => signal.clone(),
        (None, None) => reason.unwrap_or("unknown").to_owned(),
    };
    format!("Claude process exited: {end}")
}

/// One native Claude session's shared state. The binding holds it; the diverted child's
/// consumer is a clone of the same `Arc`.
pub struct ClaudeSessionCore {
    /// One input at a time, from its state change through its writes and its publish: that is
    /// what keeps two inputs' frames, writes and events in one order (ADR 0223 §7 rule 3).
    turn: Mutex<()>,
    /// The session's state. Never held across a write, a publish or the gate: a slow queue or a
    /// paused pump must not block the state (rule 4).
    wire: Mutex<ClaudeWire>,
    queue: EventQueue,
    gate: ReadGate,
    ports: Arc<OnceLock<ChildPorts>>,
}

impl ClaudeSessionCore {
    pub fn new(config: WireConfig) -> Self {
        let gate = ReadGate::new();
        let queue = EventQueue::new(gate.clone());
        Self {
            turn: Mutex::new(()),
            wire: Mutex::new(ClaudeWire::new(config)),
            queue,
            gate,
            ports: Arc::new(OnceLock::new()),
        }
    }

    fn attach_gate(&self) {
        if let Some(ports) = self.ports.get() {
            self.gate.attach(ports.output.clone());
        }
    }

    pub fn queue(&self) -> &EventQueue {
        &self.queue
    }

    pub fn gate(&self) -> &ReadGate {
        &self.gate
    }

    pub fn ports(&self) -> &Arc<OnceLock<ChildPorts>> {
        &self.ports
    }

    /// One control request; its write goes to stdin and its `send`/`wire` frame follows the ack.
    pub fn control(&self, request_json: &str, id: u64) -> Result<(), ClaudeError> {
        let _turn = self.turn();
        let effects = {
            let mut wire = self.lock();
            wire.control(request_json, id)?
        };
        self.apply(effects, true);
        Ok(())
    }

    /// One synchronous send: every message is admitted before the first write.
    pub fn send(&self, messages_json: &str, command_id: Option<&str>) -> Result<(), ClaudeError> {
        let _turn = self.turn();
        let effects = {
            let mut wire = self.lock();
            wire.send(messages_json, command_id)?
        };
        self.apply(effects, true);
        Ok(())
    }

    pub fn peek_interaction(&self, id: &str) -> Option<String> {
        self.lock().peek_interaction(id)
    }

    pub fn answer_interaction(&self, id: &str, result_json: &str, resolution_json: &str) -> bool {
        let _turn = self.turn();
        let (answered, effects) = {
            let mut wire = self.lock();
            wire.answer_interaction(id, result_json, resolution_json)
        };
        self.apply(effects, true);
        answered
    }

    pub fn answer_hook(&self, request_id: &str, output_json: &str) {
        self.input(|wire| wire.answer_hook(request_id, output_json));
    }

    pub fn task_target(&self, spawn: &str) -> Option<String> {
        self.lock().task_target(spawn)
    }

    pub fn task_cascade(&self, spawn: Option<&str>) -> String {
        self.lock().task_cascade(spawn)
    }

    pub fn note(&self, json: &str) {
        self.input(|wire| wire.note(json));
    }

    /// `"cutoff"` closes both pumps; the wire's own notes timer runs in it.
    pub fn timer(&self, key: &str) {
        if key == CUTOFF {
            if let Some(ports) = self.ports.get() {
                ports.output.close(OutputStream::Stdout);
                ports.output.close(OutputStream::Stderr);
            }
            return;
        }
        self.input(|wire| wire.timer(key));
    }

    /// The close's own expiry: every pending interaction gets its default answer.
    pub fn expire(&self) {
        self.input(ClaudeWire::expire);
    }

    /// `q.close()`'s `input.close()`: EOF after every queued write, and no write after it. The
    /// state flip and the port's end are one step under `turn`, so a send either queues its
    /// lines before the EOF or is refused by the state, and never writes into an ended pipe.
    pub fn end_input(&self) {
        let _turn = self.turn();
        self.end_input_under_turn();
    }

    /// Today's close input half (`session.ts:101`-`:109`): every pending ask expires with its
    /// default answer while stdin is open, then input ends. The child's stop is the owner's,
    /// between this and the barrier, whose `finish` is where `Drained` comes from.
    pub fn close(&self) {
        let _turn = self.turn();
        let effects = self.lock().expire();
        // A pipe that is already gone refuses this write; that is the close, not a failure.
        self.apply(effects, false);
        self.end_input_under_turn();
    }

    /// No child will ever report (the spawn threw): answer what is pending, then `Drained`
    /// (`finish` expires first, then ends input).
    pub fn abandon(&self) {
        let _turn = self.turn();
        let effects = self.lock().finish();
        self.apply(effects, false);
    }

    /// One input: its effects, the writes, then one publish, all under `turn` - but never under
    /// the state's lock, so the state is readable while a slow consumer drains the queue.
    /// `latch` is false only while closing: a write the dead pipe refused is then the close, not
    /// a failure to report.
    fn apply(&self, effects: Vec<Effect>, latch: bool) {
        let mut events = Vec::with_capacity(effects.len());
        for effect in effects {
            match effect {
                Effect::Write { wire: bytes } => {
                    let refused = match self.ports.get() {
                        Some(ports) => ports.stdin.write(bytes).is_err(),
                        None => true,
                    };
                    if refused && latch {
                        push_events(&mut events, self.lock().write_refused());
                    }
                }
                Effect::Fatal { message } => events.push(SessionEvent::Fatal { message }),
                other => push_events(&mut events, std::iter::once(other)),
            }
        }
        if !events.is_empty() {
            self.queue.publish(events);
        }
    }

    fn input(&self, run: impl FnOnce(&mut ClaudeWire) -> Vec<Effect>) {
        let _turn = self.turn();
        let effects = {
            let mut wire = self.lock();
            run(&mut wire)
        };
        self.apply(effects, true);
    }

    /// The state flip and the port's EOF, one step under `turn`: nothing queues a line between
    /// them, so no write can follow the end.
    fn end_input_under_turn(&self) {
        self.lock().end_input();
        if let Some(ports) = self.ports.get() {
            ports.stdin.end();
        }
    }

    /// The ordering gate: an input holds it from its state change to its last event.
    fn turn(&self) -> MutexGuard<'_, ()> {
        self.turn.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Held for state moves only, never across a write, a publish or the gate. A poisoned lock
    /// is recovered, because a session must still deliver what it read.
    fn lock(&self) -> MutexGuard<'_, ClaudeWire> {
        self.wire.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl OutputConsumer for ClaudeSessionCore {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.attach_gate();
        match stream {
            OutputStream::Stdout => self.input(|wire| wire.stdout_bytes(&bytes)),
            OutputStream::Stderr => self.input(|wire| wire.stderr_bytes(&bytes)),
        }
        self.gate.answer(delivered);
    }

    fn end(&self, _stream: OutputStream) {
        // An end is not the barrier; only the supervisor's `close` is.
    }

    fn stdin_written(&self) {
        self.attach_gate();
        self.input(ClaudeWire::stdin_written);
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.attach_gate();
        let message = stdin_message(&error);
        self.input(|wire| wire.stdin_error(&message));
    }

    fn exit(&self, _exit: RawExit) {
        self.attach_gate();
        self.gate.exited();
        self.queue.publish(vec![SessionEvent::ArmTimer {
            key: CUTOFF.to_owned(),
            ms: CUTOFF_MS,
        }]);
    }

    fn close(&self, _exit: RawExit) {
        self.attach_gate();
        // The terminal barrier: the child is stopped and reaped, so this is the only `finish`.
        // It cancels the cutoff timer, expires anything that arrived since the close (writing
        // its answer while input is still open), and ends input before `Drained`.
        let _turn = self.turn();
        let effects = {
            let mut wire = self.lock();
            let mut effects = vec![Effect::CancelTimer {
                key: CUTOFF.to_owned(),
            }];
            effects.extend(wire.finish());
            effects
        };
        // The exit is already the session's outcome (`exit_message`), never a write failure.
        self.apply(effects, false);
    }
}

/// The stdin failure's node message (`NodeIoError::to_json`'s `message`).
fn stdin_message(error: &NodeIoError) -> String {
    let json = error.to_json();
    ace_json::parse(&json)
        .ok()
        .and_then(|value| {
            value
                .as_object()
                .and_then(|map| map.get("message"))
                .and_then(|message| message.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "write EPIPE".to_owned())
}

fn push_events(events: &mut Vec<SessionEvent>, effects: impl IntoIterator<Item = Effect>) {
    for effect in effects {
        if let Some(event) = event_of(effect) {
            events.push(event);
        }
    }
}

/// One wire effect as the queue carries it. A write never becomes an event: it reaches the
/// pipe, and `stdin_written` emits its `send` frame.
fn event_of(effect: Effect) -> Option<SessionEvent> {
    Some(match effect {
        Effect::Frame { dir, channel, text } => SessionEvent::Frame {
            seq: 0,
            dir,
            channel: channel.to_owned(),
            text,
        },
        Effect::Callback { name, json } => SessionEvent::Callback { name, json },
        Effect::Settle { id, result } => SessionEvent::Settle {
            id,
            result: result.map_err(settle_error),
        },
        Effect::ArmTimer { key, ms } => SessionEvent::ArmTimer { key, ms },
        Effect::CancelTimer { key } => SessionEvent::CancelTimer { key },
        Effect::Fatal { message } => SessionEvent::Fatal { message },
        Effect::Drained => SessionEvent::Drained,
        Effect::Write { .. } => return None,
    })
}

fn settle_error(error: ClaudeError) -> SessionErrorWire {
    SessionErrorWire {
        code: error.code(),
        message: error.to_string(),
    }
}

#[cfg(all(test, unix))]
mod child;
#[cfg(test)]
mod tests;
