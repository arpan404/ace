// SPDX-License-Identifier: Apache-2.0
//! A received line and the states that end a call (`jsonrpc.ts:256`-`:278`, `:282`-`:347`):
//! classification, the incoming request slots, and a settlement that happens once.
use ace_json::Value;

use crate::jsonrpc::{self, FrameKind, RpcId};

use super::wire::{id_of, method_of, params_of};
use super::{Direction, PeerEffect, PeerError, Pending, RpcPeer, cancel_timer};

impl RpcPeer {
    /// One received line (`#receive`, `jsonrpc.ts:315`–`:347`).
    pub fn line(&mut self, line: &str) -> Vec<PeerEffect> {
        if self.closed {
            return Vec::new();
        }
        let Ok(value) = ace_json::parse(line) else {
            return vec![PeerEffect::Malformed {
                line: line.to_owned(),
            }];
        };
        let kind = jsonrpc::inspect_value(&value);
        let mut effects = Vec::new();
        match kind {
            FrameKind::Unparsable => {
                return vec![PeerEffect::Malformed {
                    line: line.to_owned(),
                }];
            }
            FrameKind::Malformed => effects.push(PeerEffect::Malformed {
                line: line.to_owned(),
            }),
            FrameKind::Request => self.received_request(&value, &mut effects),
            FrameKind::Notification => {
                if let Some(method) = method_of(&value) {
                    effects.push(PeerEffect::Notification { method });
                }
            }
            FrameKind::Response => self.received_response(&value, &mut effects),
        }
        effects.insert(
            0,
            PeerEffect::Frame {
                dir: Direction::Recv,
                text: self.config.frame_text.then(|| line.to_owned()),
                value,
            },
        );
        effects
    }

    /// The ticket the line of facade call `facade` took, once its write was enqueued: the
    /// shell names it as `Write { ticket }` (immediately when the writer was idle, later
    /// when the line queued). Empty once that call settled.
    pub fn write_ticket(&self, facade: u64) -> Option<u64> {
        self.pending
            .iter()
            .find(|(_, pending)| pending.facade == facade)
            .and_then(|(_, pending)| pending.ticket)
    }

    /// The write callback ran: release its bytes and hand out the next queued
    /// write, so at most one line is in flight (`rpc-writer.ts`).
    pub fn written(&mut self, ticket: u64) -> Vec<PeerEffect> {
        if !self.owner.written(ticket) {
            return Vec::new();
        }
        let mut effects = Vec::new();
        self.pump(&mut effects);
        effects
    }

    /// An armed deadline fired (`rpc-timers.ts`): settle its call as timed out.
    pub fn timer(&mut self, key: &str) -> Vec<PeerEffect> {
        // Only an armed key settles a call: a disabled deadline has no timer.
        let at = self
            .pending
            .iter()
            .position(|(_, pending)| pending.timer.as_deref() == Some(key));
        let Some(at) = at else {
            return Vec::new();
        };
        let pending = self.pending.remove(at).1;
        let message = format!("JSON-RPC request timed out: {}", pending.method);
        let mut effects = Vec::new();
        self.settle_pending(pending, Err(PeerError::new(message)), &mut effects);
        effects
    }

    /// `stopRequests` (`jsonrpc.ts:256`–`:263`): refuse work and settle every
    /// call, but keep observing final stdout frames until `close`.
    pub fn stop_requests(&mut self, reason: &str) -> Vec<PeerEffect> {
        self.stop(PeerError::new(reason))
    }

    /// Dispose the peer (`close`, `jsonrpc.ts:270`–`:278`): settle every pending
    /// call once and refuse later input.
    pub fn close(&mut self, reason: &str) -> Vec<PeerEffect> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        self.stop(PeerError::new(reason))
    }

    pub(super) fn finish_incoming(&mut self) {
        self.owner.release_request(self.owner_id);
    }

    pub(super) fn received_request(&mut self, value: &Value, effects: &mut Vec<PeerEffect>) {
        // `#receive`: after the observer's frame, a stopped peer ignores requests.
        if self.stopped.is_some() {
            return;
        }
        if self.owner.incoming(self.owner_id) >= self.config.max_incoming {
            let error = PeerError::new("JSON-RPC incoming request limit");
            let mut failed = self.stop(error);
            failed.push(PeerEffect::Failed {
                message: "JSON-RPC incoming request limit".to_owned(),
            });
            effects.append(&mut failed);
            return;
        }
        let (Some(id), Some(method)) = (id_of(value), method_of(value)) else {
            return;
        };
        self.owner.receive(self.owner_id);
        effects.push(PeerEffect::ServerRequest {
            id,
            method,
            params: params_of(value),
        });
    }

    pub(super) fn received_response(&mut self, value: &Value, effects: &mut Vec<PeerEffect>) {
        let Some(id) = id_of(value) else {
            return;
        };
        let result = match value.get("error") {
            // `rpcErrorMessage`: the raw frame already reached the observer. Its
            // fallback is unreachable: ace-json writes any parsed value.
            Some(error) => Err(PeerError::new(error.to_json())),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        if let Some(pending) = self.take_pending(&id) {
            self.settle_pending(pending, result, effects);
        }
    }

    pub(super) fn stop(&mut self, error: PeerError) -> Vec<PeerEffect> {
        self.stopped.get_or_insert_with(|| error.clone());
        let pending = std::mem::take(&mut self.pending);
        let mut effects = Vec::new();
        for (_, pending) in pending {
            self.settle_pending(pending, Err(error.clone()), &mut effects);
        }
        // Cancel this peer's queued writes (a cancelled reply frees its slot);
        // the shared queue stays open for a replacement peer on the same stdin.
        self.owner.cancel_owner(self.owner_id);
        self.owner.retire(self.owner_id);
        effects
    }

    pub(super) fn take_pending(&mut self, id: &RpcId) -> Option<Pending> {
        let at = self.pending.iter().position(|(key, _)| key == id)?;
        Some(self.pending.remove(at).1)
    }

    pub(super) fn settle_pending(
        &mut self,
        pending: Pending,
        result: Result<Value, PeerError>,
        effects: &mut Vec<PeerEffect>,
    ) {
        if let Some(ticket) = pending.ticket {
            self.owner.cancel(self.owner_id, ticket);
        }
        cancel_timer(pending.timer.as_deref(), effects);
        effects.push(PeerEffect::Settle {
            id: pending.facade,
            result,
        });
    }
}
