// SPDX-License-Identifier: Apache-2.0
//! The answers a peer gives the other side (`jsonrpc.ts:344`-`:369`): a result, an error,
//! `method not found`, a refusal, and a reply held until its write is acknowledged.
use ace_json::Value;

use crate::jsonrpc::RpcId;

use super::wire::answer_value;
use super::wire::wire_frame;
use super::{
    Direction, FrameVeto, MAX_MESSAGE_BYTES, METHOD_NOT_FOUND, PeerEffect, PeerError, RpcPeer,
    UNHANDLED_REQUEST,
};

impl RpcPeer {
    /// `#answer`'s success reply (`jsonrpc.ts:349`): `result ?? null`.
    pub fn answer(&mut self, server_id: &RpcId, result: &Value) -> Vec<PeerEffect> {
        self.send_reply(answer_value(server_id, Ok(result)), None)
    }

    /// `answer` under a caller's veto, before the reply claims a ticket.
    pub fn answer_vetoed(
        &mut self,
        server_id: &RpcId,
        result: &Value,
        veto: FrameVeto<'_>,
    ) -> Vec<PeerEffect> {
        self.send_reply(answer_value(server_id, Ok(result)), Some(veto))
    }

    /// `#answer`'s failure reply: `-32601` for a missing method, `-32603` else.
    pub fn answer_error(&mut self, server_id: &RpcId, code: f64, message: &str) -> Vec<PeerEffect> {
        self.send_reply(answer_value(server_id, Err((code, message))), None)
    }

    /// `answer_error` under a caller's veto.
    pub fn answer_error_vetoed(
        &mut self,
        server_id: &RpcId,
        code: f64,
        message: &str,
        veto: FrameVeto<'_>,
    ) -> Vec<PeerEffect> {
        self.send_reply(answer_value(server_id, Err((code, message))), Some(veto))
    }

    /// The default `onRequest`'s answer: `MethodNotFound("unhandled request")`.
    pub fn answer_not_found(&mut self, server_id: &RpcId) -> Vec<PeerEffect> {
        self.answer_error(server_id, METHOD_NOT_FOUND, UNHANDLED_REQUEST)
    }

    /// `rejectRequest` (`jsonrpc.ts:250`–`:254`): a lost reply settles only its
    /// own call. Empty when that call was already settled.
    pub fn reject_request(&mut self, id: &RpcId, error: PeerError) -> Vec<PeerEffect> {
        let mut effects = Vec::new();
        if let Some(pending) = self.take_pending(id) {
            self.settle_pending(pending, Err(error), &mut effects);
        }
        effects
    }

    /// `#settle` for one facade promise (`jsonrpc.ts:277`–`:284`): a channel's
    /// detach settles only the calls that channel is waiting on, by the promise
    /// it holds, and nothing else on the shared pipe. Empty when that call was
    /// already settled.
    pub fn abort(&mut self, facade: u64, reason: &str) -> Vec<PeerEffect> {
        let at = self
            .pending
            .iter()
            .position(|(_, pending)| pending.facade == facade);
        let Some(at) = at else {
            return Vec::new();
        };
        let pending = self.pending.remove(at).1;
        let mut effects = Vec::new();
        self.settle_pending(pending, Err(PeerError::new(reason)), &mut effects);
        effects
    }
    /// A server request's reply holds its incoming slot until `written`, as
    /// `#answer` decrements in its `finally` after the send resolves.
    fn send_reply(&mut self, value: Value, veto: Option<FrameVeto<'_>>) -> Vec<PeerEffect> {
        let mut effects = Vec::new();
        if self.stopped.is_some() {
            self.finish_incoming();
            return effects;
        }
        if let Some(message) = veto.and_then(|veto| veto(&value)) {
            // The reply never claims a ticket: nothing is left to release.
            self.finish_incoming();
            effects.push(PeerEffect::Failed { message });
            return effects;
        }
        let (text, wire) = wire_frame(&value, self.config.frame_text);
        if wire.len() > MAX_MESSAGE_BYTES {
            self.finish_incoming();
            effects.push(PeerEffect::Failed {
                message: "JSON-RPC message exceeded limit".to_owned(),
            });
            return effects;
        }
        effects.push(PeerEffect::Frame {
            dir: Direction::Send,
            value,
            text,
        });
        match self.owner.enqueue_reply(self.owner_id, wire) {
            Ok(_) => self.pump(&mut effects),
            Err(error) => {
                self.finish_incoming();
                effects.push(PeerEffect::Failed {
                    message: error.to_string(),
                });
            }
        }
        effects
    }
}
