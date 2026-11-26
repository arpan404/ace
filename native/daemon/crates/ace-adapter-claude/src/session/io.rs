// SPDX-License-Identifier: Apache-2.0
//! The Claude session's tokio side (E3-claude.4): one lock over the wire, one ordered queue to
//! the facade, the read gate the child's pumps answer, and the child's ports. Every input - an
//! output chunk, a binding call, a timer - runs the one `ClaudeWire` method under `wire`'s lock,
//! hands each `Write` to the child's stdin in order, and publishes the rest as one batch, so two
//! inputs never interleave their events (ADR 0223 section 7 rules 3-4).

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

/// One native Claude session's shared state. The binding holds it; the diverted child's
/// consumer is a clone of the same `Arc`.
pub struct ClaudeSessionCore {
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
        let mut wire = self.lock();
        let effects = wire.control(request_json, id)?;
        self.commit(&mut wire, effects);
        Ok(())
    }

    /// One synchronous send: every message is admitted before the first write.
    pub fn send(&self, messages_json: &str, command_id: Option<&str>) -> Result<(), ClaudeError> {
        let mut wire = self.lock();
        let effects = wire.send(messages_json, command_id)?;
        self.commit(&mut wire, effects);
        Ok(())
    }

    pub fn peek_interaction(&self, id: &str) -> Option<String> {
        self.lock().peek_interaction(id)
    }

    pub fn answer_interaction(&self, id: &str, result_json: &str, resolution_json: &str) -> bool {
        let mut wire = self.lock();
        let (answered, effects) = wire.answer_interaction(id, result_json, resolution_json);
        self.commit(&mut wire, effects);
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

    /// `q.close()`'s `input.close()`: EOF after every queued write, and no expiry writes.
    pub fn end_input(&self) {
        self.lock().end_input();
        if let Some(ports) = self.ports.get() {
            ports.stdin.end();
        }
    }

    /// No child will ever report (the spawn threw): answer what is pending, then `Drained`.
    pub fn abandon(&self) {
        let mut wire = self.lock();
        let mut effects = wire.expire();
        effects.extend(wire.finish());
        self.commit(&mut wire, effects);
    }

    /// One input: the wire's effects, the writes, then one publish, all under the wire's lock.
    /// A write the port refuses undoes its queue record first, so `write_refused` can latch.
    fn commit(&self, wire: &mut ClaudeWire, effects: Vec<Effect>) {
        let mut events = Vec::with_capacity(effects.len());
        for effect in effects {
            match effect {
                Effect::Write { wire: bytes } => {
                    let refused = match self.ports.get() {
                        Some(ports) => ports.stdin.write(bytes).is_err(),
                        None => true,
                    };
                    if refused {
                        push_events(&mut events, wire.write_refused());
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
        let mut wire = self.lock();
        let effects = run(&mut wire);
        self.commit(&mut wire, effects);
    }

    /// The mutex is held only for state moves and queue pushes; a poisoned one is recovered,
    /// because a session must still deliver what it read.
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
        // The terminal barrier. A child that ends before the cutoff cancels it.
        self.input(|wire| {
            let mut effects = vec![Effect::CancelTimer {
                key: CUTOFF.to_owned(),
            }];
            effects.extend(wire.finish());
            effects
        });
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

#[cfg(test)]
mod tests {
    use super::*;

    fn core() -> ClaudeSessionCore {
        ClaudeSessionCore::new(WireConfig {
            session_id: "session-1".to_owned(),
            root_key: "root".to_owned(),
            bearer: None,
            resume: false,
        })
    }

    fn clean_exit() -> RawExit {
        RawExit {
            code: Some(0),
            signal: None,
        }
    }

    /// A final line with no newline is delivered at the barrier, and `Drained` comes last.
    #[test]
    fn a_final_line_and_drained_arrive_at_the_close() {
        let core = core();
        core.input(|wire| wire.stdout_bytes(br#"{"type":"keep_alive"}"#));
        core.close(clean_exit());
        let events = core.queue().take_batch(256, 256 * 1024);
        assert!(
            events.iter().any(
                |event| matches!(event, SessionEvent::Frame { channel, .. } if channel == "sdk")
            )
        );
        assert!(matches!(events.last(), Some(SessionEvent::Drained)));
    }

    /// A fatal capture is published, and the close still settles and drains.
    #[test]
    fn a_fatal_is_followed_by_drained_at_the_close() {
        let core = core();
        let huge = format!(
            r#"{{"type":"keep_alive","data":"{}"}}"#,
            " ".repeat(1024 * 1024)
        );
        core.input(|wire| wire.stdout_bytes(format!("{huge}\n").as_bytes()));
        core.close(clean_exit());
        let events = core.queue().take_batch(512, 1024 * 1024);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, SessionEvent::Fatal { .. }))
        );
        assert!(matches!(events.last(), Some(SessionEvent::Drained)));
    }
}
