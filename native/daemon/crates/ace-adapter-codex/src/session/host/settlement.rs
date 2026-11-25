// SPDX-License-Identifier: Apache-2.0
//! The peer's effects: writes, timers, settlements, and the host's own calls.

use super::*;

impl Inner {
    pub(super) fn take(&mut self) -> Vec<HostEffect> {
        std::mem::take(&mut self.out)
    }

    /// A facade id for one of the host's own requests.
    pub(super) fn own_id(&mut self) -> u64 {
        let id = OWN_ID_BASE + self.next_own;
        self.next_own += 1;
        id
    }

    /// Enqueues one of the host's own requests, with no tenant attributed to
    /// its send frame. The effects are returned unapplied: the caller registers
    /// its purpose first, so a queue that refuses the line settles through that
    /// purpose instead of waiting for an answer that will never come.
    pub(super) fn enqueue_own(
        &mut self,
        method: &str,
        params: &[(&str, &JsString)],
        timeout_ms: f64,
    ) -> Result<(u64, Vec<PeerEffect>), String> {
        let mut map = Map::with_capacity(params.len());
        for (name, value) in params {
            map.insert(*name, Value::from((*value).clone()));
        }
        let id = self.own_id();
        self.sender = None;
        let peer = self
            .peer
            .request(
                method,
                Some(&Value::Object(map)),
                id,
                Timeout::After(timeout_ms),
            )
            .map_err(|error| error.message().to_owned())?;
        Ok((id, peer))
    }

    /// Settle every call one channel is waiting on (`tenant.abort`,
    /// `host.ts:349`), settling the peer's promise exactly as a reply would.
    pub(super) fn abort_calls(&mut self, tenant: u64, reason: &str) {
        let calls: Vec<u64> = self
            .calls
            .iter()
            .filter(|(_, owner)| **owner == tenant)
            .map(|(id, _)| *id)
            .collect();
        for id in calls {
            self.calls.shift_remove(&id);
            let effects = self.peer.abort(id, reason);
            self.apply(effects);
        }
    }

    /// Apply the peer's effects in order, dispatching the ones the host owns.
    pub(super) fn apply(&mut self, effects: Vec<PeerEffect>) {
        let mut pending: Option<Pending> = None;
        for effect in effects {
            match effect {
                PeerEffect::Frame {
                    dir: Direction::Send,
                    value,
                } => {
                    if let Some(message) = self.sent(&value) {
                        self.report_all(&message);
                    }
                }
                PeerEffect::Frame {
                    dir: Direction::Recv,
                    value,
                } => pending = Some(self.received(value)),
                PeerEffect::Notification { method, params } => {
                    self.notification(pending.take(), &method, params.as_ref());
                }
                PeerEffect::ServerRequest { id, method, params } => {
                    self.server_request(pending.take(), id, &method, params.as_ref());
                }
                PeerEffect::Malformed { line } => {
                    let tenants: Vec<(u64, Arc<dyn ChannelHandlers>)> = self
                        .tenants
                        .iter()
                        .map(|(id, entry)| (*id, Arc::clone(&entry.handlers)))
                        .collect();
                    for (_, handlers) in tenants {
                        handlers.malformed(&line);
                    }
                }
                PeerEffect::Settle { id, result } => self.settle(id, result),
                PeerEffect::Write { wire, ticket } => {
                    self.out.push(HostEffect::Write { wire, ticket })
                }
                PeerEffect::ArmTimer { key, ms } => self.out.push(HostEffect::ArmTimer { key, ms }),
                PeerEffect::CancelTimer { key } => self.out.push(HostEffect::CancelTimer { key }),
                PeerEffect::Failed { message } => self.report_all(&message),
            }
        }
    }

    /// A request the host made itself: its answer goes back into the walk.
    pub(super) fn settle(&mut self, id: u64, result: Result<Value, PeerError>) {
        if id == self.initialize_call {
            self.initialized(&result);
            return;
        }
        let Some(purpose) = self.own.remove(&id) else {
            self.calls.shift_remove(&id);
            self.out.push(HostEffect::Settle { id, result });
            return;
        };
        match purpose {
            OwnPurpose::Read { thread, hold } => self.read_settled(&thread, hold, result),
            OwnPurpose::Unsubscribe { tenant } => self.unsubscribed(tenant),
            OwnPurpose::Interrupt { tenant, attempt } => {
                self.interrupt_answered(tenant, attempt, &result)
            }
            OwnPurpose::ShellList { tenant, thread } => {
                self.terminals_listed(tenant, &thread, &result)
            }
            OwnPurpose::ShellStop { tenant } => self.terminal_stopped(tenant, &result),
        }
    }
}
