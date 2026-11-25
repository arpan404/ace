// SPDX-License-Identifier: Apache-2.0
//! The ACP session's I/O shell over a diverted child (E3-acp.1): one lock over
//! [`AcpCore`], one ordered [`EventQueue`], one [`ReadGate`], and the child's
//! [`ChildPorts`]. Mirrors `ace-adapter-pi/src/session/io.rs`.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionErrorWire, SessionEvent};
use ace_json::{Map, Value};
use ace_supervisor::divert::{ChildPorts, OutputConsumer};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::peer::{PeerError, PeerOwner, Timeout};
use ace_supervisor::spawn::{Delivered, OutputStream, RawExit};

use super::core::{AcpCore, AcpCoreConfig, AcpEffect, AcpErrorWire};
use super::input::InputSend;

/// Inherited-pipe cutoff after leader exit (1,000 ms, same as `PiSessionCore`).
const CUTOFF: &str = "cutoff";
const CUTOFF_MS: f64 = 1_000.0;

/// One native ACP session's shared state over a diverted child.
pub struct AcpSessionCore {
    core: Mutex<AcpCore>,
    queue: EventQueue,
    gate: ReadGate,
    ports: Arc<OnceLock<ChildPorts>>,
}

impl AcpSessionCore {
    /// Construct a new ACP session core with a fresh [`PeerOwner`].
    pub fn new(config: AcpCoreConfig) -> Self {
        let (core, initial) = AcpCore::new(config);
        Self::from_parts(core, initial)
    }

    /// Construct a new ACP session core over an explicit [`PeerOwner`].
    pub fn with_owner(config: AcpCoreConfig, owner: PeerOwner) -> Self {
        let (core, initial) = AcpCore::with_owner(config, owner);
        Self::from_parts(core, initial)
    }

    fn from_parts(core: AcpCore, initial: Vec<AcpEffect>) -> Self {
        let gate = ReadGate::new();
        let queue = EventQueue::new(gate.clone());
        let session = Self {
            core: Mutex::new(core),
            queue,
            gate,
            ports: Arc::new(OnceLock::new()),
        };
        let mut guard = session.lock();
        session.commit(&mut guard, initial);
        drop(guard);
        session
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

    /// Begin the ACP open handshake (`initialize` + `session/new|load|resume`).
    pub fn start_open(&self, facade_id: u64) {
        self.input(|core| core.start_open(facade_id));
    }

    /// Issue a JSON-RPC request through the session's [`RpcPeer`].
    pub fn request(
        &self,
        method: &str,
        params: Option<&Value>,
        facade_id: u64,
        timeout: Timeout,
    ) -> Result<(), PeerError> {
        let mut core = self.lock();
        let effects = core.request(method, params, facade_id, timeout)?;
        self.commit(&mut core, effects);
        Ok(())
    }

    /// Issue a JSON-RPC notification through the session's [`RpcPeer`].
    pub fn notify(&self, method: &str, params: Option<&Value>) -> Result<(), PeerError> {
        let mut core = self.lock();
        let effects = core.notify(method, params)?;
        self.commit(&mut core, effects);
        Ok(())
    }

    /// Fire a timer key (`"cutoff"` closes both child pumps; others run inside [`AcpCore`]).
    pub fn timer(&self, key: &str) {
        if key == CUTOFF {
            if let Some(ports) = self.ports.get() {
                ports.output.close(OutputStream::Stdout);
                ports.output.close(OutputStream::Stderr);
            }
            return;
        }
        self.input(|core| core.timer(key));
    }

    /// Abandon before any child exists: fail pending calls and publish `Drained`.
    pub fn abandon(&self) {
        self.input(AcpCore::abandon);
    }

    fn commit(&self, core: &mut AcpCore, effects: Vec<AcpEffect>) {
        let mut events = Vec::with_capacity(effects.len());
        for effect in effects {
            match effect {
                AcpEffect::Write { wire, .. } => {
                    let refused = match self.ports.get() {
                        Some(ports) => ports.stdin.write(wire).is_err(),
                        None => true,
                    };
                    if refused {
                        let follow_up = core.stdin_error("write EPIPE");
                        push_non_write_events(&mut events, follow_up);
                    }
                }
                other => push_non_write_events(&mut events, std::iter::once(other)),
            }
        }
        if !events.is_empty() {
            self.queue.publish(events);
        }
    }

    fn input(&self, run: impl FnOnce(&mut AcpCore) -> Vec<AcpEffect>) {
        let mut core = self.lock();
        let effects = run(&mut core);
        self.commit(&mut core, effects);
    }

    fn lock(&self) -> MutexGuard<'_, AcpCore> {
        self.core.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// `openWithSignIn`'s retry: the session request again, without `initialize`
    /// (`acp-sign-in.ts:30`).
    pub fn retry_open(&self, facade_id: u64) {
        self.input(|core| core.retry_open_session(facade_id));
    }

    /// `session.ts`'s send: admission, steer or queue, then the drain (E3-acp.2).
    pub fn send(&self, send: InputSend<'_>) {
        self.input(|core| {
            let mut effects = Vec::new();
            core.send(send, &mut effects);
            effects
        });
    }

    /// `interrupt` (`session.ts:856`): its frames, then the operation's settlement, so the
    /// facade hears the refusal only after the frames it caused were published.
    pub fn interrupt(&self, target: ace_adapter_api::session::InterruptTarget, operation: u64) {
        let mut core = self.lock();
        let mut effects = Vec::new();
        let result = core.interrupt(target, &mut effects);
        effects.push(settled(operation, result));
        self.commit(&mut core, effects);
    }

    /// `resolve` (`session.ts:820`): the person's answer to an agent's request.
    pub fn resolve(&self, key: &str, resolution: &Value, operation: u64) {
        let mut core = self.lock();
        let mut effects = Vec::new();
        let result = core.resolve(key, resolution, &mut effects);
        effects.push(settled(operation, result));
        self.commit(&mut core, effects);
    }

    /// `setModel` (`session.ts:572`): settles the facade's `operation` with its reply.
    pub fn set_model(&self, operation: u64, model: &str) {
        self.input(|core| {
            let mut effects = Vec::new();
            core.set_model(operation, model, &mut effects);
            effects
        });
    }

    /// `setMode` (`session.ts:587`).
    pub fn set_mode(&self, operation: u64, mode: &str) {
        self.input(|core| {
            let mut effects = Vec::new();
            core.set_mode(operation, mode, &mut effects);
            effects
        });
    }

    /// `stopTask` (`session.ts:898`): ACP has no per-task control.
    pub fn stop_task(&self, task: &str, operation: u64) {
        let mut core = self.lock();
        let result = core.stop_task(task);
        self.commit(&mut core, vec![settled(operation, result)]);
    }

    /// The native mode the session reports running (`session.ts:522`): the configuration's
    /// current mode, which a getter over the core gives the facade.
    pub fn permission_mode(&self) -> Option<String> {
        self.lock()
            .configuration
            .current(super::selectors::SelectorKind::Mode)
    }

    /// `close` (`session.ts:901`): the session's own teardown; the stop plan is the facade's.
    pub fn close_session(&self, reason: ace_adapter_api::session::CloseReason) {
        self.input(|core| {
            let mut effects = Vec::new();
            core.close(reason, &mut effects);
            effects
        });
    }
}

impl OutputConsumer for AcpSessionCore {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.attach_gate();
        match stream {
            OutputStream::Stdout => self.input(|core| core.stdout_bytes(&bytes)),
            OutputStream::Stderr => self.input(|core| core.stderr_bytes(&bytes)),
        }
        self.gate.answer(delivered);
    }

    fn end(&self, stream: OutputStream) {
        self.attach_gate();
        if matches!(stream, OutputStream::Stdout) {
            self.input(AcpCore::stdout_closed);
        }
    }

    fn stdin_written(&self) {
        self.attach_gate();
        self.input(AcpCore::stdin_written);
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.attach_gate();
        let message = stdin_message(&error);
        self.input(|core| core.stdin_error(&message));
    }

    fn exit(&self, _exit: RawExit) {
        self.attach_gate();
        self.gate.exited();
        self.input(AcpCore::mark_exited);
        self.queue.publish(vec![SessionEvent::ArmTimer {
            key: CUTOFF.to_owned(),
            ms: CUTOFF_MS,
        }]);
    }

    fn close(&self, exit: RawExit) {
        self.attach_gate();
        let (detail, summary) = format_exit(&exit);
        self.input(|core| {
            let mut effects = vec![AcpEffect::CancelTimer {
                key: CUTOFF.to_owned(),
            }];
            effects.extend(core.finish(detail, &summary));
            effects
        });
    }
}

/// A facade operation settled with what the command decided, the failure included.
fn settled(operation: u64, result: Result<(), AcpErrorWire>) -> AcpEffect {
    AcpEffect::Settle {
        id: operation,
        result: result.map(|()| "null".to_owned()),
    }
}

fn push_non_write_events(
    events: &mut Vec<SessionEvent>,
    effects: impl IntoIterator<Item = AcpEffect>,
) {
    for effect in effects {
        match effect {
            AcpEffect::Frame { dir, channel, text } => events.push(SessionEvent::Frame {
                seq: 0,
                dir,
                channel,
                text,
            }),
            AcpEffect::Callback { name, json } => {
                events.push(SessionEvent::Callback { name, json })
            }
            AcpEffect::Settle { id, result } => events.push(SessionEvent::Settle {
                id,
                result: result.map_err(|err| SessionErrorWire {
                    code: err.code,
                    message: err.message,
                }),
            }),
            AcpEffect::ArmTimer { key, ms } => events.push(SessionEvent::ArmTimer { key, ms }),
            AcpEffect::CancelTimer { key } => events.push(SessionEvent::CancelTimer { key }),
            AcpEffect::Fatal { message } => events.push(SessionEvent::Fatal { message }),
            AcpEffect::Drained => events.push(SessionEvent::Drained),
            AcpEffect::Write { .. } => {}
        }
    }
}

fn format_exit(exit: &RawExit) -> (Value, String) {
    let mut map = Map::with_capacity(2);
    if let Some(code) = exit.code {
        map.insert("code", Value::from(code));
    } else {
        map.insert("code", Value::Null);
    }
    if let Some(signal) = &exit.signal {
        map.insert("signal", Value::from(signal.as_str()));
    } else {
        map.insert("signal", Value::Null);
    }
    let summary = exit
        .code
        .map(|c| c.to_string())
        .or_else(|| exit.signal.clone())
        .unwrap_or_else(|| "exited".to_owned());
    (Value::Object(map), summary)
}

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
