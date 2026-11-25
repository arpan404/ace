// SPDX-License-Identifier: Apache-2.0
//! The peer's effects: writes, timers, settlements, and the host's own calls.

use super::channels::RefusedSend;
use super::*;

impl Inner {
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
        // A send frame the channel refused: its line is dropped instead of
        // written, and its call fails with the refusal (`jsonrpc.ts:291`-`:292`).
        let mut refused: Option<RefusedSend> = None;
        for effect in effects {
            match effect {
                PeerEffect::Frame {
                    dir: Direction::Send,
                    value,
                } => {
                    refused = self.sent(&value);
                }
                PeerEffect::Frame {
                    dir: Direction::Recv,
                    value,
                } => pending = Some(self.received(value)),
                PeerEffect::Notification { method } => {
                    self.notification(pending.take(), &method);
                }
                PeerEffect::ServerRequest { id, method, params } => {
                    self.server_request(pending.take(), id, &method, params.as_ref());
                }
                PeerEffect::Malformed { line } => {
                    for tenant in self.tenant_ids() {
                        self.out.push(HostEffect::Malformed {
                            tenant,
                            line: line.clone(),
                        });
                    }
                }
                PeerEffect::Settle { id, result } => self.settle(id, result),
                PeerEffect::Write { wire, ticket } => match refused.take() {
                    // Every frame a channel sends is vetted before the peer
                    // claims it (`api.rs`), so a refusal here is a defect: the
                    // line still goes out, because an unacknowledged ticket the
                    // host dropped would stall shared stdin, and the channel
                    // hears the refusal.
                    Some(refusal) => {
                        self.out.push(HostEffect::Error {
                            tenant: refusal.tenant,
                            message: refusal.message,
                        });
                        self.out.push(HostEffect::Write { wire, ticket });
                    }
                    None => self.out.push(HostEffect::Write { wire, ticket }),
                },
                PeerEffect::ArmTimer { key, ms } => self.out.push(HostEffect::ArmTimer { key, ms }),
                PeerEffect::CancelTimer { key } => self.out.push(HostEffect::CancelTimer { key }),
                PeerEffect::Failed { message } => self.report_all(&message),
            }
        }
        // A veto's verdict is good for the one frame of this input.
        self.admitted_send = None;
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
            OwnPurpose::ShellList {
                tenant,
                attempt,
                thread,
                scan,
            } => self.terminals_listed(tenant, attempt, &thread, scan, &result),
            OwnPurpose::ShellStop { tenant, attempt } => {
                self.terminal_stopped(tenant, attempt, &result)
            }
        }
    }
}
