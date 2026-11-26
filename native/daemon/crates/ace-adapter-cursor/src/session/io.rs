// SPDX-License-Identifier: Apache-2.0
//! The session's shell over a diverted child (E3.0b): one lock over [`CursorSessionCore`], one
//! ordered [`EventQueue`], one [`ReadGate`], and the child's [`ChildPorts`]. Mirrors
//! `ace-adapter-pi/src/session/io.rs`. The Rust daemon owns the process, its stop plan and its
//! timers; this is the only place a session touches its pipes.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ace_adapter_api::bridge::ReadGate;
use ace_adapter_api::bridge::queue::{EventQueue, SessionEvent};
use ace_adapter_api::session::CloseReason;
use ace_json::Value;
use ace_supervisor::divert::{ChildPorts, OutputConsumer};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::spawn::{Delivered, OutputStream, RawExit};

use super::commands::CursorOpen;
use super::core::{CoreEffect, CursorSessionConfig, CursorSessionCore};

/// One native Cursor session's shared state over a diverted child.
pub struct CursorSessionShell {
    core: Mutex<CursorSessionCore>,
    queue: EventQueue,
    gate: ReadGate,
    ports: Arc<OnceLock<ChildPorts>>,
    /// The peer's write tickets whose bytes the pipe has not taken yet, in write order
    /// (`stdin_written` releases the front one).
    writes: Mutex<VecDeque<u64>>,
}

impl CursorSessionShell {
    pub fn new(config: CursorSessionConfig) -> CursorSessionShell {
        let gate = ReadGate::new();
        let queue = EventQueue::starting_at(gate.clone(), 1);
        let core = CursorSessionCore::new(config, queue.clone());
        CursorSessionShell {
            core: Mutex::new(core),
            queue,
            gate,
            ports: Arc::new(OnceLock::new()),
            writes: Mutex::new(VecDeque::new()),
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

    /// `openCursorSession`'s open (`session.ts:195`-`:217`), settling `operation`.
    pub fn open(&self, operation: u64, open: CursorOpen<'_>, snapshot: Option<Value>) {
        // One lock, cloned out: two `self.lock()` calls in one statement would keep the first
        // guard alive until the semicolon and deadlock on the second.
        let params = {
            let core = self.lock();
            super::commands::open_params(&core.generation, &core.limits, open)
        };
        self.input(|core| match core.start_open(operation, &params, snapshot) {
            Ok(effects) => effects,
            Err(error) => vec![CoreEffect::Event(SessionEvent::Settle {
                id: operation,
                result: Err(ace_adapter_api::bridge::queue::SessionErrorWire {
                    code: error.code,
                    message: error.message,
                }),
            })],
        });
    }

    /// `configure` (`session.ts:222`-`:229`).
    pub fn configure(&self, operation: u64, model: &str, model_params: Option<&Value>) -> bool {
        let mut core = self.lock();
        match core.configure(operation, model, model_params) {
            Ok(effects) => {
                self.commit(&mut core, effects);
                true
            }
            Err(_) => false,
        }
    }

    /// `send` (`session.ts:230`-`:284`): the refusal is returned to the caller, which throws it.
    pub fn send(
        &self,
        operation: u64,
        send: super::commands::CursorSend<'_>,
    ) -> Option<ace_adapter_api::bridge::queue::SessionErrorWire> {
        let mut core = self.lock();
        match core.send(operation, send) {
            Ok(effects) => {
                self.commit(&mut core, effects);
                None
            }
            Err(error) => Some(ace_adapter_api::bridge::queue::SessionErrorWire {
                code: error.code,
                message: error.message,
            }),
        }
    }

    /// `interrupt` (`session.ts:285`-`:303`).
    pub fn interrupt(
        &self,
        operation: u64,
        agent: Option<&str>,
        cascade: bool,
    ) -> Option<ace_adapter_api::bridge::queue::SessionErrorWire> {
        let mut core = self.lock();
        match core.interrupt(operation, agent, cascade) {
            Ok(effects) => {
                self.commit(&mut core, effects);
                None
            }
            Err(error) => Some(ace_adapter_api::bridge::queue::SessionErrorWire {
                code: error.code,
                message: error.message,
            }),
        }
    }

    /// `close` (`session.ts:182`-`:194`), settling `operation`.
    pub fn close(&self, operation: u64, reason: CloseReason) {
        self.input(|core| core.close(operation, reason));
    }

    /// No child will ever report (the spawn threw): the exit and the drain are published now,
    /// so every promise settles (`session.ts`'s catch around the host's open).
    pub fn abandon(&self) {
        self.input(|core| core.pipes_closed());
        self.input(|core| core.exit(None, None, "spawn-error", None, None));
    }

    /// The child ended (`session.ts:156`-`:181`): the caller supplies its end, its reason and
    /// the prose the host left (already redacted: redaction is the caller's).
    pub fn exit(
        &self,
        code: Option<i64>,
        signal: Option<&str>,
        reason: &str,
        detail: Option<&str>,
        stop_cause: Option<&str>,
    ) {
        self.input(|core| core.exit(code, signal, reason, detail, stop_cause));
    }

    /// The caller answered a port: `"host-output"` with the redacted text, `"stop"` with nothing.
    pub fn note(&self, name: &str, text: Option<&str>) {
        self.input(|core| core.note(name, text));
    }

    /// `onFrame` resolved for the session's number `seq`.
    pub fn committed(&self, seq: u64) {
        self.input(|core| core.committed(seq));
    }

    /// `onFrame` rejected for the session's number `seq`.
    pub fn refused(&self, seq: u64, reason: &str) {
        self.input(|core| core.refused(seq, reason));
    }

    /// The pipe took the line of write `ticket`.
    pub fn written(&self, ticket: u64) {
        self.input(|core| core.written(ticket));
    }

    /// An armed deadline fired.
    pub fn timer(&self, key: &str) {
        self.input(|core| core.timer(key));
    }

    fn input(&self, run: impl FnOnce(&mut CursorSessionCore) -> Vec<CoreEffect>) {
        let mut core = self.lock();
        let effects = run(&mut core);
        self.commit(&mut core, effects);
    }

    fn lock(&self) -> MutexGuard<'_, CursorSessionCore> {
        self.core.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Writes go to the child's stdin; events go to the queue, whose bound is the gate's.
    fn commit(&self, core: &mut CursorSessionCore, effects: Vec<CoreEffect>) {
        let mut events = Vec::with_capacity(effects.len());
        for effect in effects {
            match effect {
                CoreEffect::Event(event) => events.push(event),
                CoreEffect::Write { wire, ticket } => {
                    let refused = match self.ports.get() {
                        Some(ports) => ports.stdin.write(wire).is_err(),
                        None => true,
                    };
                    if refused {
                        let message = String::from("write EPIPE");
                        events.extend(core.stdin_failed(&message).into_iter().filter_map(
                            |effect| match effect {
                                CoreEffect::Event(event) => Some(event),
                                _ => None,
                            },
                        ));
                    } else {
                        // The peer hands out one write at a time and the pipe's own callback
                        // (`stdin_written`) releases it, as `rpc-writer.ts` does.
                        self.writes
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .push_back(ticket);
                    }
                }
            }
        }
        if !events.is_empty() {
            self.queue.publish(events);
        }
    }

    fn attach_gate(&self) {
        if let Some(ports) = self.ports.get() {
            self.gate.attach(ports.output.clone());
        }
    }
}

impl OutputConsumer for CursorSessionShell {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.attach_gate();
        match stream {
            OutputStream::Stdout => self.input(|core| core.stdout_bytes(&bytes)),
            OutputStream::Stderr => self.input(|core| core.stderr_bytes(&bytes)),
        }
        self.gate.answer(delivered);
    }

    fn end(&self, _stream: OutputStream) {}

    fn stdin_written(&self) {
        self.attach_gate();
        // The pipe took the oldest line this session wrote: let the peer hand out the next.
        let ticket = self
            .writes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pop_front();
        if let Some(ticket) = ticket {
            self.input(|core| core.written(ticket));
        }
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.attach_gate();
        // The node error's message, as `io.rs` in ACP reads it: a JSON object with `message`.
        let message = ace_json::parse(&error.to_json())
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(|m| m.as_str().map(str::to_owned))
            })
            .unwrap_or_else(|| String::from("write EPIPE"));
        self.input(|core| core.stdin_failed(&message));
    }

    fn exit(&self, _exit: RawExit) {
        // The leader ended: stop pausing the pumps, so the last bytes still drain
        // (`bridge.rs`'s `exited`).
        self.attach_gate();
        self.gate.exited();
    }

    fn close(&self, _exit: RawExit) {
        self.attach_gate();
        self.gate.exited();
        self.input(CursorSessionCore::pipes_closed);
    }
}

#[cfg(test)]
mod tests;
