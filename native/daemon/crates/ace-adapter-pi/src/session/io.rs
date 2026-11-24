// SPDX-License-Identifier: Apache-2.0
//! The Pi session's tokio side (E3-pi.2): one lock over the wire, one ordered
//! queue to the facade, the read gate the child's pumps answer, and the
//! child's ports. Every input — an output chunk, a binding call, a timer — runs
//! the one `PiWire` method under `wire`'s lock, hands each `Write` to the
//! child's stdin in order, and publishes the rest as one batch, so two inputs
//! never interleave their events (ADR 0223 §7 rules 3–4).

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionErrorWire, SessionEvent};
use ace_json::{JsString, Map};
use ace_supervisor::divert::{ChildPorts, OutputConsumer};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::spawn::{Delivered, OutputStream, RawExit};

use super::error::PiError;
use super::wire::{Effect, PiWire, PiWireConfig};

/// The code a refused command settles with (`ACE_PI_COMMAND_REFUSED`).
pub const COMMAND_REFUSED: &str = "ACE_PI_COMMAND_REFUSED";
/// The code a command that may have run settles with (`ACE_PI_UNCERTAIN`).
pub const UNCERTAIN: &str = "ACE_PI_UNCERTAIN";
/// The inherited-pipe cutoff: 1,000 ms after the leader's exit (`session.ts:272`–`:283`).
const CUTOFF: &str = "cutoff";
const CUTOFF_MS: f64 = 1_000.0;

/// One native Pi session's shared state. The binding holds it; the diverted
/// child's consumer is a clone of the same `Arc`.
pub struct PiSessionCore {
    wire: Mutex<PiWire>,
    queue: EventQueue,
    gate: ReadGate,
    ports: Arc<OnceLock<ChildPorts>>,
}

impl PiSessionCore {
    /// The wire, its queue and the gate the queue paces the child's pumps with.
    pub fn new(config: PiWireConfig) -> Self {
        let gate = ReadGate::new();
        let queue = EventQueue::new(gate.clone());
        Self {
            wire: Mutex::new(PiWire::new(config)),
            queue,
            gate,
            ports: Arc::new(OnceLock::new()),
        }
    }

    pub fn queue(&self) -> &EventQueue {
        &self.queue
    }

    pub fn gate(&self) -> &ReadGate {
        &self.gate
    }

    /// The child's controls, filled by the spawn before it returns (E3.0b).
    pub fn ports(&self) -> &Arc<OnceLock<ChildPorts>> {
        &self.ports
    }

    /// A command Pi may refuse: the refusal is the binding's error, and nothing
    /// was published, because validation ran before any state changed.
    pub fn request(&self, command: &str, params: &Map, id: u64) -> Result<(), PiError> {
        let mut wire = self.lock();
        let effects = wire.request(command, params, id)?;
        self.commit(&mut wire, effects);
        Ok(())
    }

    /// A dialog answer, as `rpc.write`.
    pub fn write(&self, data: &Map, id: u64, resume_after: bool) -> Result<(), PiError> {
        let mut wire = self.lock();
        let effects = wire.write(data, id, resume_after)?;
        self.commit(&mut wire, effects);
        Ok(())
    }

    pub fn note(&self, json: &str) {
        self.input(|wire| wire.note(json));
    }

    /// `"cutoff"` closes both pumps; the wire's own timers run in it.
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

    pub fn peek_dialog(&self, id: &JsString) -> Option<String> {
        self.lock().peek_dialog(id)
    }

    pub fn take_dialog(&self, id: &JsString) -> bool {
        let mut wire = self.lock();
        let (taken, effects) = wire.take_dialog(id);
        self.commit(&mut wire, effects);
        taken
    }

    pub fn dialog_count(&self) -> usize {
        self.lock().dialog_count()
    }

    pub fn expect_rollback(&self, id: String) {
        self.lock().expect_rollback(id);
    }

    pub fn rollback_result(&self) -> Option<bool> {
        self.lock().rollback_result()
    }

    pub fn clear_rollback(&self) {
        self.lock().clear_rollback();
    }

    /// No child will ever report (the spawn threw): close the wire and publish
    /// `Drained` now, so every promise and timer settles.
    pub fn abandon(&self) {
        let mut wire = self.lock();
        let mut effects = wire.close();
        effects.push(Effect::Drained);
        self.commit(&mut wire, effects);
    }

    /// One input: the wire's effects, the writes, then one publish, all under
    /// the wire's lock. A write the port refuses undoes its reservation first,
    /// so the request settles through the queue and the call still returns.
    ///
    /// A `Fatal` is today's `PiRpc.fail` (`rpc.ts:62`–`:64`): the shell's close
    /// ran `rpc.close()` synchronously, so the wire closes here, its pending
    /// requests settle uncertain before the failure, and nothing later in the
    /// same chunk is read.
    fn commit(&self, wire: &mut PiWire, effects: Vec<Effect>) {
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
                Effect::Fatal { message } => {
                    events.push(SessionEvent::Fatal { message });
                    push_events(&mut events, wire.close());
                    break;
                }
                other => push_events(&mut events, std::iter::once(other)),
            }
        }
        if !events.is_empty() {
            self.queue.publish(events);
        }
    }

    fn input(&self, run: impl FnOnce(&mut PiWire) -> Vec<Effect>) {
        let mut wire = self.lock();
        let effects = run(&mut wire);
        self.commit(&mut wire, effects);
    }

    /// The mutex is held only for state moves and queue pushes; a poisoned one
    /// is recovered, because a session must still deliver what it read.
    fn lock(&self) -> MutexGuard<'_, PiWire> {
        self.wire.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl OutputConsumer for PiSessionCore {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        match stream {
            OutputStream::Stdout => self.input(|wire| wire.stdout_bytes(&bytes)),
            OutputStream::Stderr => self.input(|wire| wire.stderr_bytes(&bytes)),
        }
        // The check and the pause are one step: the gate holds its lock while it
        // reads the state and answers the chunk (E3.0c, step 2).
        self.gate.answer(delivered);
    }

    fn end(&self, _stream: OutputStream) {
        // An end is not the barrier; only the supervisor's `close` is.
    }

    fn stdin_written(&self) {
        self.input(PiWire::stdin_written);
    }

    fn stdin_error(&self, error: NodeIoError) {
        let message = stdin_message(&error);
        self.input(|wire| wire.stdin_error(&message));
    }

    fn exit(&self, _exit: RawExit) {
        self.gate.exited();
        self.queue.publish(vec![SessionEvent::ArmTimer {
            key: CUTOFF.to_owned(),
            ms: CUTOFF_MS,
        }]);
    }

    fn close(&self, _exit: RawExit) {
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

/// One wire effect as the queue carries it. A write never becomes an event: it
/// reaches the pipe, and `stdin_written` emits its `send` frame.
fn event_of(effect: Effect) -> Option<SessionEvent> {
    Some(match effect {
        Effect::Frame { dir, channel, text } => SessionEvent::Frame {
            seq: 0,
            dir,
            channel: channel.to_owned(),
            text,
        },
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

fn settle_error(error: PiError) -> SessionErrorWire {
    match error {
        PiError::Refused(kind) => SessionErrorWire {
            code: COMMAND_REFUSED,
            message: kind.to_string(),
        },
        PiError::Uncertain(kind) => SessionErrorWire {
            code: UNCERTAIN,
            message: kind.to_string(),
        },
    }
}
