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
use ace_adapter_api::session::CloseReason;
use ace_json::Value;

mod lifecycle;
mod receive;
mod settle;

#[cfg(test)]
mod tests;

use super::commands::CursorSend;
use super::envelope::CursorLimits;
use super::error::HostErrorWire;
use super::frames::CHANNEL;
use super::host::{CursorHostConfig, CursorHostCore, HostEffect};

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
}

/// A port with no payload.
pub(super) fn listener(name: &'static str) -> CoreEffect {
    CoreEffect::Event(SessionEvent::Port {
        name,
        json: String::from("{}"),
    })
}

pub(super) fn listener_event(name: &'static str, message: &str) -> SessionEvent {
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
