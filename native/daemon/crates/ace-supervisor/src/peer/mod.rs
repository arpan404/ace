// SPDX-License-Identifier: Apache-2.0
//! The JSON-RPC peer, ported from `provider-kit/src/jsonrpc.ts` (`JsonRpcPeer`,
//! `:129`–`:365`), `rpc-owner.ts` and `rpc-timers.ts` over the merged halves in
//! [`crate::jsonrpc`] (`RpcIds`, `WriterQueue`, `inspect`, `error_code`). Sans-IO
//! like `PiWire`: one input returns its effects in the order the state changed,
//! and the shell owns the pipe, the clock and the timers.
//!
//! JSON goes through `ace-json`, so a request id keeps its exact type (`"7"` is
//! not `7`) and a lone surrogate survives (`id_to_json` writes it back as
//! `\ud800`). A received frame keeps every unknown field: the shell observes the
//! whole value, and classification only names its shape.
//!
//! Split by responsibility: `effects` is what an input returns, `owner` is the
//! shared stdin (ids, the bounded write queue, incoming slots), `wire` builds and
//! reads the JSON values, `lines` takes a received line, and `replies` answers
//! the agent's requests. This file is the peer's own state and outbound calls.
//!
//! A `PeerOwner` carries the pipe's id reservations (`rpc-owner.ts`), so a
//! replacement peer on the same stdin keeps every id the retired one reserved;
//! each peer owns its write queue. A timeout, a rejected reply and a close each
//! settle a pending call exactly once: settling removes it before the effects
//! are built, so a later response or a second close finds nothing.

use ace_json::Value;

use crate::jsonrpc::{self, RpcId};

use wire::{notification_value, request_value, wire_frame};

mod effects;
mod lines;
mod owner;
mod replies;
mod wire;

pub use effects::{Direction, PeerConfig, PeerEffect, PeerError, Timeout};
pub use owner::PeerOwner;

/// `maxMessageBytes`' default (`jsonrpc.ts:151`).
const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// `maxIncomingRequests`' default (`jsonrpc.ts:149`); shared Codex hosts use 512.
const DEFAULT_MAX_INCOMING: usize = 128;
/// `maxQueuedBytes`' default (`jsonrpc.ts:159`).
const DEFAULT_MAX_QUEUED_BYTES: usize = 32 * 1024 * 1024;
/// `maxExplicitIds`' default (`jsonrpc.ts:158`).
const MAX_EXPLICIT_IDS: usize = 4096;
/// The default deadline when a request and its config both leave one unset.
const DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
/// `MethodNotFound`'s code in an answer (`jsonrpc.ts:361`).
pub const METHOD_NOT_FOUND: f64 = -32601.0;
/// Any other handler failure's code (`jsonrpc.ts:361`).
pub const INTERNAL_ERROR: f64 = -32603.0;
/// The default `onRequest`'s message (`jsonrpc.ts:142`).
pub const UNHANDLED_REQUEST: &str = "unhandled request";

/// One request waiting for its answer.
/// A caller's veto of the frame it would send, by the exact value the emitter
/// sees: `Some(message)` refuses it, with the error the caller gets.
pub type FrameVeto<'a> = &'a dyn Fn(&Value) -> Option<String>;

struct Pending {
    facade: u64,
    method: String,
    timer: Option<String>,
    /// Its write's ticket while the queue still holds it.
    ticket: Option<u64>,
}

pub struct RpcPeer {
    config: PeerConfig,
    owner: PeerOwner,
    owner_id: u64,
    pending: Vec<(RpcId, Pending)>,
    /// The first error that stopped requests; inputs still observe frames.
    stopped: Option<PeerError>,
    /// `close` ran: no later line reaches the state.
    closed: bool,
}

impl RpcPeer {
    pub fn new(config: PeerConfig) -> RpcPeer {
        let owner = PeerOwner::new(config.max_queued_bytes);
        RpcPeer::with_owner(config, owner)
    }

    /// A peer over an existing pipe's owner: a replacement keeps the ids and the
    /// write queue (in-flight bytes and the one active write) the retired peer
    /// left. The first peer's `max_queued_bytes` fixed the queue's cap.
    pub fn with_owner(config: PeerConfig, owner: PeerOwner) -> RpcPeer {
        let owner_id = owner.join();
        RpcPeer {
            config,
            owner,
            owner_id,
            pending: Vec::new(),
            stopped: None,
            closed: false,
        }
    }

    /// `request` (`jsonrpc.ts:180`–`:238`): validate, reserve, then write.
    /// `params: None` omits the field, as `undefined` does; a `Value::Null`
    /// inside `Some` is the explicit `params: null`.
    pub fn request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        self.enqueue_request(method, params, id, timeout, None, None)
    }

    /// `request` under a caller's veto of the frame it would send: the veto
    /// runs on the exact value the emitter sees, before a call slot, a timer or
    /// a write ticket exists, so a refused frame is one settlement and nothing
    /// else. The shell vets its frame bound this way (`session.ts:153`).
    pub fn request_vetoed(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
        veto: FrameVeto<'_>,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        self.enqueue_request(method, params, id, timeout, None, Some(veto))
    }

    /// `request` with `options.id`: the wire id is exact (`"7"` stays a string).
    pub fn request_with_id(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
        wire_id: RpcId,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        self.enqueue_request(method, params, id, timeout, Some(wire_id), None)
    }

    fn enqueue_request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        id: u64,
        timeout: Timeout,
        wire_id: Option<RpcId>,
        veto: Option<FrameVeto<'_>>,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        if let Some(error) = &self.stopped {
            return Err(error.clone());
        }
        if self.pending.len() >= self.config.max_pending {
            return Err(PeerError::new("JSON-RPC pending request limit"));
        }
        let deadline = match timeout {
            Timeout::Default => self.config.timeout_ms,
            Timeout::Disabled => None,
            Timeout::After(ms) => Some(ms),
        };
        if let Some(ms) = deadline
            && (!ms.is_finite() || ms < 0.0)
        {
            return Err(PeerError::new("Invalid timeoutMs"));
        }
        let request_id = self.owner.reserve(wire_id)?;
        let value = request_value(&request_id, method, params);
        if let Some(message) = veto.and_then(|veto| veto(&value)) {
            return Ok(vec![PeerEffect::Settle {
                id,
                result: Err(PeerError::new(message)),
            }]);
        }
        let (text, wire) = wire_frame(&value, self.config.frame_text);
        let mut effects = Vec::new();
        let timer = deadline.map(|ms| {
            let key = timer_key(&request_id);
            effects.push(PeerEffect::ArmTimer {
                key: key.clone(),
                ms,
            });
            key
        });
        if wire.len() > MAX_MESSAGE_BYTES {
            cancel_timer(timer.as_deref(), &mut effects);
            effects.push(PeerEffect::Settle {
                id,
                result: Err(PeerError::new("JSON-RPC message exceeded limit")),
            });
            return Ok(effects);
        }
        let mut pending = Pending {
            facade: id,
            method: method.to_owned(),
            timer: timer.clone(),
            ticket: None,
        };
        effects.push(PeerEffect::Frame {
            dir: Direction::Send,
            value,
            text,
        });
        match self.owner.enqueue(self.owner_id, wire) {
            Ok(ticket) => {
                pending.ticket = Some(ticket);
                self.pending.push((request_id, pending));
                self.pump(&mut effects);
            }
            Err(error) => {
                cancel_timer(timer.as_deref(), &mut effects);
                effects.push(PeerEffect::Settle {
                    id,
                    result: Err(error.into()),
                });
            }
        }
        Ok(effects)
    }

    /// `notify` (`jsonrpc.ts:241`–`:247`): no correlation, write failures report.
    pub fn notify(
        &mut self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Vec<PeerEffect>, PeerError> {
        if let Some(error) = &self.stopped {
            return Err(error.clone());
        }
        let value = notification_value(method, params);
        let (text, wire) = wire_frame(&value, self.config.frame_text);
        let mut effects = Vec::new();
        if wire.len() > MAX_MESSAGE_BYTES {
            effects.push(PeerEffect::Failed {
                message: "JSON-RPC message exceeded limit".to_owned(),
            });
            return Ok(effects);
        }
        effects.push(PeerEffect::Frame {
            dir: Direction::Send,
            value,
            text,
        });
        match self.owner.enqueue(self.owner_id, wire) {
            Ok(_) => self.pump(&mut effects),
            Err(error) => effects.push(PeerEffect::Failed {
                message: error.to_string(),
            }),
        }
        Ok(effects)
    }

    fn pump(&mut self, effects: &mut Vec<PeerEffect>) {
        if let Some((ticket, wire)) = self.owner.claim() {
            effects.push(PeerEffect::Write { wire, ticket });
        }
    }
}

fn cancel_timer(timer: Option<&str>, effects: &mut Vec<PeerEffect>) {
    if let Some(key) = timer {
        effects.push(PeerEffect::CancelTimer {
            key: key.to_owned(),
        });
    }
}

fn timer_key(id: &RpcId) -> String {
    format!("request:{}", jsonrpc::id_to_json(id))
}

#[cfg(test)]
mod tests;
