// SPDX-License-Identifier: Apache-2.0
//! The Cursor session core: the state `openCursorSession` keeps (`session.ts:142`-`:150`), the
//! frames it hands to `onFrame`, and the host's own events mapped into the session's ordered
//! queue. Sans-IO, like the host core it sits on: the shell owns the process, the pipes, the
//! queue's delivery and the timers, and the facade owns every prose the engine shows.
//!
//! **Sequence.** `seq` starts at 1 and is shared by frames and the fallback operation id
//! (`session.ts:76`, `:134`, `:260`), so the queue starts at 1 and a frame reserves the number it
//! crosses with ([`EventQueue::reserve_seq`]). That number is what the facade reports back from
//! `onFrame`, so the core keeps the host's own frame number beside it: one acknowledgement per
//! frame, as `host.ts:146`-`:169` waits for.

use ace_adapter_api::bridge::queue::{EventQueue, SessionEvent};
use ace_adapter_api::frame::FrameDirection;
use ace_adapter_api::session::CloseReason;
use ace_json::Value;

use super::commands::CursorSend;
use super::envelope::CursorLimits;
use super::error::HostErrorWire;
use super::frames::{self, CHANNEL};
use super::host::{CursorHostConfig, CursorHostCore, HostEffect, PORT_CONNECTION};

/// Internal host-call ids: a facade id is a small counter, so the high half never leaves the core
/// (`session.ts` has no such split; the facade settles its own calls there).
pub(super) const INTERNAL_CALL_BIT: u64 = 1 << 63;
/// The port a stopped host answers (`session.ts:188`, `host.ts:254`).
pub const PORT_EXITED: &str = "exited";
/// The port the facade answers once the child is stopped (`host.ts:254`-`:267`).
pub const PORT_STOP_CHILD: &str = "stop";
/// The port a stray line's answer comes back on (E3.0c's hold, `host.ts:143`).
pub const PORT_HOST_OUTPUT: &str = "host-output";

/// What the session core needs.
pub struct CursorSessionConfig {
    pub generation: String,
    pub instance_id: String,
    pub root_key: String,
    pub limits: CursorLimits,
    /// `onCapabilities`' argument object, rendered by the facade: the provider's capability
    /// catalogs and the platform are TypeScript data (`policy.ts:44`).
    pub capabilities: String,
}

/// One effect of an input: an event for the session's queue, or a line for the child's stdin.
pub enum CoreEffect {
    Event(SessionEvent),
    Write { wire: Vec<u8>, ticket: u64 },
}

/// The session's state (`session.ts:142`-`:150`).
pub(super) struct State {
    pub(super) operation: String,
    pub(super) segment: f64,
    pub(super) active: bool,
    pub(super) uncertain: bool,
    pub(super) terminal: bool,
    pub(super) control: bool,
    pub(super) deliberate: bool,
    pub(super) exited: bool,
}

/// A session core over one host child.
pub struct CursorSessionCore {
    pub(super) generation: String,
    pub(super) instance_id: String,
    pub(super) root_key: String,
    pub(super) limits: CursorLimits,
    pub(super) capabilities: String,
    pub(super) host: CursorHostCore,
    pub(super) queue: EventQueue,
    pub(super) state: State,
    /// The open, while the host is opening.
    pub(super) opening: Option<Opening>,
    /// The send in flight, its cancel first when the turn was active.
    pub(super) sending: Option<super::commands::Sending>,
    /// The close, memoized as `closing` is (`session.ts:183`).
    pub(super) closing: Option<super::commands::CloseFlight>,
    /// The interrupt in flight (`session.ts:285`-`:303`).
    pub(super) interrupting: Option<super::commands::Interrupting>,
    /// Each published frame's session number and the host number it acknowledges.
    pub(super) acknowledgements: Vec<(u64, u64)>,
    /// Callbacks a received frame decided, published before it (`session.ts:105`-`:139`).
    pending_callbacks: Vec<(&'static str, String)>,
    pub(super) next_internal: u64,
}

pub(super) struct Opening {
    facade_id: u64,
    internal: u64,
    snapshot: Option<Value>,
}

impl CursorSessionCore {
    pub fn new(config: CursorSessionConfig, queue: EventQueue) -> CursorSessionCore {
        CursorSessionCore {
            host: CursorHostCore::new(CursorHostConfig {
                generation: config.generation.clone(),
                limits: config.limits,
            }),
            state: State {
                operation: String::from("open"),
                segment: 0.0,
                active: false,
                uncertain: false,
                terminal: false,
                control: false,
                deliberate: false,
                exited: false,
            },
            generation: config.generation,
            instance_id: config.instance_id,
            root_key: config.root_key,
            limits: config.limits,
            capabilities: config.capabilities,
            queue,
            opening: None,
            sending: None,
            closing: None,
            interrupting: None,
            acknowledgements: Vec::new(),
            pending_callbacks: Vec::new(),
            next_internal: 1,
        }
    }

    pub(super) fn alloc_internal(&mut self) -> u64 {
        let id = INTERNAL_CALL_BIT | self.next_internal;
        self.next_internal = self.next_internal.saturating_add(1);
        id
    }

    /// Feed raw bytes from the child's stdout.
    pub fn stdout_bytes(&mut self, chunk: &[u8]) -> Vec<CoreEffect> {
        let effects = self.host.stdout_bytes(chunk);
        self.map_host(effects)
    }

    /// Feed raw bytes from the child's stderr.
    pub fn stderr_bytes(&mut self, chunk: &[u8]) -> Vec<CoreEffect> {
        let effects = self.host.stderr_bytes(chunk);
        self.map_host(effects)
    }

    /// The frame with the session's number `seq` was stored (`onFrame` resolved).
    pub fn committed(&mut self, seq: u64) -> Vec<CoreEffect> {
        let Some(host_seq) = self.take_acknowledgement(seq) else {
            return Vec::new();
        };
        let effects = self.host.committed(host_seq);
        self.map_host(effects)
    }

    /// The frame with the session's number `seq` could not be stored; `reason` is the facade's
    /// already-redacted `ace could not store a Cursor SDK frame: ...`.
    pub fn refused(&mut self, seq: u64, reason: &str) -> Vec<CoreEffect> {
        let Some(host_seq) = self.take_acknowledgement(seq) else {
            return Vec::new();
        };
        let effects = self.host.refused(host_seq, reason);
        self.map_host(effects)
    }

    /// The pipe took the line of write `ticket`.
    pub fn written(&mut self, ticket: u64) -> Vec<CoreEffect> {
        let effects = self.host.written(ticket);
        self.map_host(effects)
    }

    /// An armed deadline fired.
    pub fn timer(&mut self, key: &str) -> Vec<CoreEffect> {
        let effects = self.host.timer(key);
        self.map_host(effects)
    }

    fn take_acknowledgement(&mut self, seq: u64) -> Option<u64> {
        let at = self
            .acknowledgements
            .iter()
            .position(|(session_seq, _)| *session_seq == seq)?;
        Some(self.acknowledgements.remove(at).1)
    }

    /// The pipes are closed: the host's tails drain, then the facade is asked for the exit
    /// (`session.ts:156` waits on `process.exited`, which is after the pipes here).
    pub fn pipes_closed(&mut self) -> Vec<CoreEffect> {
        let mut effects = Vec::new();
        for effect in self.host.finish() {
            // The host's own `Drained` is not the session's: the session's comes after its
            // host-exit frame, once the facade has answered the exit.
            if matches!(effect, HostEffect::Drained) {
                continue;
            }
            self.apply_host(effect, &mut effects);
        }
        effects.push(listener(PORT_EXITED));
        effects
    }

    /// `process.exited` resolved: the host-exit note, the engine's exit and the drain
    /// (`session.ts:156`-`:181`). `detail` is the facade's `failureMessage`, `stop_cause` its
    /// `stopCause`.
    pub fn exit(
        &mut self,
        code: Option<i64>,
        signal: Option<&str>,
        reason: &str,
        detail: Option<&str>,
        stop_cause: Option<&str>,
    ) -> Vec<CoreEffect> {
        let mut effects = Vec::new();
        self.state.exited = true;
        let body = frames::host_exit_body(self.state.deliberate, code, signal, reason, detail);
        self.frame(
            FrameDirection::Note,
            frames::KIND_HOST_EXIT,
            &body,
            &mut effects,
        );
        effects.push(CoreEffect::Event(SessionEvent::Callback {
            name: "onExit",
            json: frames::exit_args(self.state.deliberate, stop_cause),
        }));
        effects.push(CoreEffect::Event(SessionEvent::Drained));
        effects
    }

    /// The facade answered a port. `"host-output"` releases the host's hold with the redacted
    /// text; `"stop"` is the child's stop; `"exited"` is answered by [`CursorSessionCore::exit`].
    pub fn note(&mut self, name: &str, text: Option<&str>) -> Vec<CoreEffect> {
        match name {
            PORT_HOST_OUTPUT => {
                let mut effects = Vec::new();
                if let Some(text) = text {
                    let mut body = ace_json::Map::with_capacity(1);
                    body.insert("text", Value::from(text));
                    let body = Value::Object(body);
                    self.frame(
                        FrameDirection::Note,
                        frames::KIND_HOST_OUTPUT,
                        &body,
                        &mut effects,
                    );
                }
                let released = self.host.note("host-output");
                for effect in released {
                    self.apply_host(effect, &mut effects);
                }
                effects
            }
            PORT_STOP_CHILD => super::commands::close_stopped(self),
            _ => Vec::new(),
        }
    }

    /// A stdin write failed (`proc.stdin.on("error")`): the host is stopped as a connection
    /// failure, as `host.ts:152`-`:154` fails it.
    pub fn stdin_failed(&mut self, message: &str) -> Vec<CoreEffect> {
        let effects = self.host.close(message);
        let mut effects = self.map_host(effects);
        effects.insert(
            0,
            CoreEffect::Event(listener_event(PORT_CONNECTION, message)),
        );
        effects
    }

    /// The open request (`session.ts:195`-`:217`): the host's reply settles the facade after the
    /// recovery snapshot note, which the engine stores as part of opening.
    pub(super) fn start_open(
        &mut self,
        facade_id: u64,
        params: &Value,
        snapshot: Option<Value>,
    ) -> Result<Vec<CoreEffect>, HostErrorWire> {
        let internal = self.alloc_internal();
        self.opening = Some(Opening {
            facade_id,
            internal,
            snapshot,
        });
        let effects = self
            .host
            .request("open", Some(params), internal, None)
            .map_err(|error| super::commands::rpc_error(error.message()))?;
        Ok(self.map_host(effects))
    }

    /// `configure` (`session.ts:222`-`:229`): one request, settled by the host's reply.
    pub fn configure(
        &mut self,
        facade_id: u64,
        model: &str,
        model_params: Option<&Value>,
    ) -> Result<Vec<CoreEffect>, HostErrorWire> {
        let params = super::commands::configure_params(model, model_params);
        let effects = self
            .host
            .request("configure", Some(&params), facade_id, None)
            .map_err(|error| super::commands::rpc_error(error.message()))?;
        Ok(self.map_host(effects))
    }

    /// `send` (`session.ts:230`-`:284`): admission's refusals here, the rest as a machine over
    /// the host's `cancel` and `send` requests (see `commands/send.rs`).
    pub fn send(
        &mut self,
        facade_id: u64,
        send: CursorSend<'_>,
    ) -> Result<Vec<CoreEffect>, HostErrorWire> {
        super::commands::send(self, facade_id, send)
    }

    /// `interrupt` (`session.ts:285`-`:303`).
    pub fn interrupt(
        &mut self,
        facade_id: u64,
        agent: Option<&str>,
        _cascade: bool,
    ) -> Result<Vec<CoreEffect>, HostErrorWire> {
        super::commands::interrupt(self, facade_id, agent)
    }

    /// `close` (`session.ts:182`-`:194`), memoized: a second caller waits on the first close.
    pub fn close(&mut self, facade_id: u64, reason: CloseReason) -> Vec<CoreEffect> {
        super::commands::close(self, facade_id, reason)
    }

    /// One host effect, as the session sees it: its frames pass through `receive`, its writes go
    /// to the pipe, its settlements reach the facade or a flight.
    pub(super) fn map_host(&mut self, effects: Vec<HostEffect>) -> Vec<CoreEffect> {
        let mut out = Vec::new();
        for effect in effects {
            self.apply_host(effect, &mut out);
        }
        out
    }

    pub(super) fn apply_host(&mut self, effect: HostEffect, out: &mut Vec<CoreEffect>) {
        match effect {
            HostEffect::Frame {
                seq: host_seq,
                data,
                text,
            } => {
                let dir = self.receive(&data);
                for (name, json) in std::mem::take(&mut self.pending_callbacks) {
                    out.push(CoreEffect::Event(SessionEvent::Callback { name, json }));
                }
                if let Some(dir) = dir {
                    let session_seq = self.queue.reserve_seq();
                    self.acknowledgements.push((session_seq, host_seq));
                    out.push(CoreEffect::Event(SessionEvent::Frame {
                        seq: session_seq,
                        dir,
                        channel: CHANNEL.to_owned(),
                        text,
                    }));
                }
            }
            HostEffect::Write { wire, ticket } => {
                out.push(CoreEffect::Write { wire, ticket });
            }
            HostEffect::Settle { id, result } => self.settle(id, result, out),
            HostEffect::Port { name, json } => {
                out.push(CoreEffect::Event(SessionEvent::Port { name, json }));
            }
            HostEffect::LoginUrl(url) => {
                out.push(CoreEffect::Event(SessionEvent::Callback {
                    name: "onLoginUrl",
                    json: format!("[{}]", Value::from(url.as_str()).to_json()),
                }));
            }
            HostEffect::ArmTimer { key, ms } => {
                out.push(CoreEffect::Event(SessionEvent::ArmTimer { key, ms }));
            }
            HostEffect::CancelTimer { key } => {
                out.push(CoreEffect::Event(SessionEvent::CancelTimer { key }));
            }
            HostEffect::Drained => out.push(CoreEffect::Event(SessionEvent::Drained)),
        }
    }

    /// `receive` (`session.ts:105`-`:139`): the callbacks first, then the turn's fate, then the
    /// frame. `None` once the session is drained.
    fn receive(&mut self, data: &Value) -> Option<FrameDirection> {
        let kind = data
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if kind == "open" {
            self.callback("onCapabilities", &self.capabilities.clone());
            if let Some(agent_id) = data.get("agentId").and_then(Value::as_js_str) {
                let json = frames::identity_args(&self.instance_id, &agent_id.clone());
                self.callback("onSessionIdentity", &json);
            }
        }
        let same_turn = data.get("operationId").and_then(Value::as_str)
            == Some(self.state.operation.as_str())
            && data.get("segment").and_then(Value::as_f64) == Some(self.state.segment);
        if (kind == "result" || kind == "error") && same_turn {
            let body = data.get("body").unwrap_or(&Value::Null);
            let settled = (kind == "error" && frames::settled_error(body))
                || frames::result_status(body)
                    .is_some_and(|status| ["finished", "cancelled", "error"].contains(&status));
            if settled {
                self.state.active = false;
                self.state.terminal = true;
                self.state.uncertain = false;
            } else {
                self.state.uncertain = true;
            }
        }
        Some(if kind == "send" {
            FrameDirection::Send
        } else {
            FrameDirection::Recv
        })
    }

    /// One callback's event is queued here; the frame that follows it is the caller's.
    fn callback(&mut self, name: &'static str, json: &str) {
        self.pending_callbacks.push((name, json.to_owned()));
    }

    /// A frame the session builds (`session.ts:58`-`:83`): the envelope text, then the event.
    pub(super) fn frame(
        &mut self,
        dir: FrameDirection,
        kind: &str,
        body: &Value,
        out: &mut Vec<CoreEffect>,
    ) {
        let text = frames::session_frame(
            &self.generation,
            &self.state.operation,
            self.state.segment,
            kind,
            body,
        );
        let Ok(text) = text else {
            return;
        };
        let seq = self.queue.reserve_seq();
        out.push(CoreEffect::Event(SessionEvent::Frame {
            seq,
            dir,
            channel: CHANNEL.to_owned(),
            text,
        }));
    }

    /// One host settlement: the internal flights first, then the facade's own promises.
    pub(super) fn settle(
        &mut self,
        id: u64,
        result: Result<String, HostErrorWire>,
        out: &mut Vec<CoreEffect>,
    ) {
        if id & INTERNAL_CALL_BIT == 0 {
            out.push(CoreEffect::Event(SessionEvent::Settle {
                id,
                result: result.map_err(session_error),
            }));
            return;
        }
        if self
            .opening
            .as_ref()
            .is_some_and(|opening| opening.internal == id)
        {
            self.finish_open(result, out);
            return;
        }
        if self
            .sending
            .as_ref()
            .is_some_and(|sending| sending.internal == id)
        {
            self.finish_send(result, out);
            return;
        }
        if self
            .interrupting
            .as_ref()
            .is_some_and(|interrupt| interrupt.internal == id)
        {
            let Some(interrupt) = self.interrupting.take() else {
                return;
            };
            let cancel_error = result.err();
            super::commands::interrupt_close(self, interrupt.facade_id, cancel_error, out);
            return;
        }
        if self
            .closing
            .as_ref()
            .is_some_and(|close| close.internal == Some(id))
        {
            if let Some(close) = &mut self.closing {
                close.request_error = result.err();
            }
            out.extend(super::commands::request_stop(self));
        }
    }

    /// The open's reply (`session.ts:195`-`:217`): the snapshot note first, then its agent id.
    fn finish_open(&mut self, result: Result<String, HostErrorWire>, out: &mut Vec<CoreEffect>) {
        let Some(opening) = self.opening.take() else {
            return;
        };
        let agent_id = match result {
            Ok(json) => match ace_json::parse(&json)
                .map_err(|_| String::from("Invalid open reply"))
                .and_then(|value| frames::open_agent_id(&value).map_err(|error| error.message()))
            {
                Ok(agent_id) => agent_id,
                Err(message) => {
                    out.push(settle_error(
                        opening.facade_id,
                        super::commands::rpc_error(message),
                    ));
                    return;
                }
            },
            Err(error) => {
                out.push(settle_error(opening.facade_id, error));
                return;
            }
        };
        if let Some(snapshot) = opening.snapshot {
            self.frame(FrameDirection::Note, frames::KIND_SNAPSHOT, &snapshot, out);
        }
        let mut reply = ace_json::Map::with_capacity(1);
        reply.insert("nativeSessionId", Value::String(agent_id));
        out.push(CoreEffect::Event(SessionEvent::Settle {
            id: opening.facade_id,
            result: Ok(Value::Object(reply).to_json()),
        }));
    }

    /// A cancel or send settled: the machine advances (`session.ts:250`-`:280`).
    fn finish_send(&mut self, result: Result<String, HostErrorWire>, out: &mut Vec<CoreEffect>) {
        let Some(sending) = self.sending.take() else {
            return;
        };
        match sending.stage {
            super::commands::SendStage::Cancel => match result {
                Ok(_) => {
                    if sending.replacement {
                        self.state.segment += 1.0;
                    } else {
                        self.state.operation = match &sending.operation_id {
                            Some(operation) => operation.clone(),
                            None => format!("{}:{}", self.generation, self.queue.reserve_seq()),
                        };
                        self.state.segment = 0.0;
                    }
                    self.sending = Some(sending);
                    if let Err(error) = self.start_send(out) {
                        self.state.control = false;
                        let id = self.sending.take().map_or(0, |flight| flight.facade_id);
                        if id != 0 {
                            out.push(settle_error(id, error));
                        }
                    }
                }
                Err(error) => {
                    self.state.control = false;
                    out.push(settle_error(
                        sending.facade_id,
                        super::commands::input_rejected(error.message),
                    ));
                }
            },
            super::commands::SendStage::Send => match result {
                Ok(value) => {
                    self.state.control = false;
                    out.push(CoreEffect::Event(SessionEvent::Settle {
                        id: sending.facade_id,
                        result: Ok(value),
                    }));
                }
                Err(error) => {
                    self.state.active = false;
                    self.state.uncertain = !self.state.terminal;
                    self.state.control = false;
                    let error = if super::commands::refused_by_host(&error.message) {
                        super::commands::input_rejected(error.message)
                    } else {
                        error
                    };
                    out.push(settle_error(sending.facade_id, error));
                }
            },
        }
    }

    /// `host.request("send", ...)` (`session.ts:263`-`:272`), after the cancel when there was one.
    pub(super) fn start_send(&mut self, out: &mut Vec<CoreEffect>) -> Result<(), HostErrorWire> {
        self.state.active = true;
        self.state.terminal = false;
        let Some(mut sending) = self.sending.take() else {
            return Ok(());
        };
        sending.stage = super::commands::SendStage::Send;
        if let Some(command_id) = &sending.command_id {
            out.push(CoreEffect::Event(SessionEvent::Callback {
                name: "onInputMessage",
                json: frames::input_message_args(command_id),
            }));
        }
        let params = super::commands::send_params(
            &self.state.operation,
            sending.command_id.as_deref(),
            self.state.segment,
            &sending.input,
        );
        sending.internal = self.alloc_internal();
        let effects = self
            .host
            .request("send", Some(&params), sending.internal, None)
            .map_err(|error| super::commands::rpc_error(error.message()))?;
        self.sending = Some(sending);
        out.extend(self.map_host(effects));
        Ok(())
    }
}

/// A promise settled with a refusal or a failure.
fn settle_error(facade_id: u64, error: HostErrorWire) -> CoreEffect {
    CoreEffect::Event(SessionEvent::Settle {
        id: facade_id,
        result: Err(ace_adapter_api::bridge::queue::SessionErrorWire {
            code: error.code,
            message: error.message,
        }),
    })
}

fn listener(name: &'static str) -> CoreEffect {
    CoreEffect::Event(SessionEvent::Port {
        name,
        json: String::from("{}"),
    })
}

fn listener_event(name: &'static str, message: &str) -> SessionEvent {
    if message.is_empty() {
        return SessionEvent::Port {
            name,
            json: String::from("{}"),
        };
    }
    let mut object = ace_json::Map::with_capacity(1);
    object.insert("message", Value::from(message));
    SessionEvent::Port {
        name,
        json: Value::Object(object).to_json(),
    }
}

/// A host failure as the queue carries it.
fn session_error(error: HostErrorWire) -> ace_adapter_api::bridge::queue::SessionErrorWire {
    ace_adapter_api::bridge::queue::SessionErrorWire {
        code: error.code,
        message: error.message,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use ace_adapter_api::bridge::ReadGate;

    pub(super) fn core() -> CursorSessionCore {
        CursorSessionCore::new(
            CursorSessionConfig {
                generation: String::from("g"),
                instance_id: String::from("i"),
                root_key: String::from("root"),
                limits: CursorLimits::default(),
                capabilities: String::from(r#"{"steer":true}"#),
            },
            EventQueue::starting_at(ReadGate::new(), 1),
        )
    }

    pub(super) fn envelope(kind: &str, operation: &str, segment: f64, body: &str) -> String {
        format!(
            r#"{{"schemaVersion":1,"operationId":"{operation}","generation":"g","segment":{segment},"kind":"{kind}","body":{body}}}"#
        )
    }

    pub(super) fn frame_line(params: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":"h","method":"frame","params":{params}}}"#)
    }

    #[test]
    fn a_frame_starting_at_one_acknowledges_the_host_frame_it_carries() {
        let mut core = core();
        let line = frame_line(&envelope(
            "delta",
            "open",
            0.0,
            r#"{"type":"text-delta","text":"a"}"#,
        ));
        let effects = core.stdout_bytes(format!("{line}\n").as_bytes());
        let frame = effects
            .iter()
            .find_map(|effect| match effect {
                CoreEffect::Event(SessionEvent::Frame { seq, dir, text, .. }) => {
                    Some((*seq, *dir, text.clone()))
                }
                _ => None,
            })
            .expect("a frame");
        assert_eq!(frame.0, 1);
        assert_eq!(frame.1, FrameDirection::Recv);
        assert!(frame.2.contains(r#""kind":"delta""#));
        // The acknowledgement names the session's number; the host hears its own.
        let effects = core.committed(1);
        assert!(effects.iter().any(|effect| matches!(
            effect,
            CoreEffect::Write { wire, .. }
                if String::from_utf8_lossy(wire).contains(r#""result":{"committed":true}"#)
        )));
    }
}
