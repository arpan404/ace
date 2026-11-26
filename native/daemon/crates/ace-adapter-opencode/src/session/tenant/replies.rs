// SPDX-License-Identifier: Apache-2.0
//! The replies the facade feeds back (`session.ts:345`-`:362`, `ancestry.ts:94`-`:128`):
//! one `http` request per SDK call, answered with `reply(id, ok, json)`.
//!
//! A reply with no waiter is dropped: the pass that asked may have ended, or the
//! probe may have settled while its chain was in flight.

use ace_adapter_api::FrameDirection;
use ace_json::{Value, json};

use super::super::ownership::parse_info;

use super::super::ancestry::ProbeHost;
use super::super::http::{Owner, Reply};
use super::super::lookup::Step as LookupStep;
use super::OpenCodeTenant;

impl OpenCodeTenant {
    /// One `http` port for an SDK call, with the owner that waits on it.
    pub(crate) fn request_http(&self, owner: Owner, op: &'static str, params: Value) {
        let event = self.lock_http().request(owner, op, params);
        self.queue.publish(vec![event]);
    }

    /// `reply(id, ok, json)`: a request nobody waits on is dropped, and so is
    /// every reply after the tenant closed.
    pub fn reply(&self, id: u64, ok: bool, json: &str) {
        let Some(owner) = self.lock_http().take(id) else {
            return;
        };
        if self.closed() {
            return;
        }
        let reply = Reply::parse(ok, json);
        match owner {
            Owner::Moved(session) => self.moved_reply(&session, reply.ok, &reply.body),
            Owner::Ancestry(probed) => self.ancestry_reply(&probed, &reply),
            // The pass's requests and the replay's re-read both advance the one
            // read in flight (`session.ts:508`-`:513`, `:550`-`:570`).
            Owner::Recovery | Owner::Replay => self.recovery_reply(&reply),
        }
    }

    /// One chain reply (`ancestry.ts:96`-`:128`): the next hop, the admission,
    /// or the probe's failure.
    fn ancestry_reply(&self, probed: &str, reply: &Reply) {
        let Some(lookup) = self.lock_lookups().shift_remove(probed) else {
            return;
        };
        if self.lock_ancestry().guard(probed).is_none() {
            // The probe settled while this request was in flight.
            return;
        }
        let mut lookup = lookup;
        let needs_recovery = self.lock_ancestry().needs_recovery(probed);
        let step = lookup.step(
            reply,
            &|id| self.has_session(id),
            needs_recovery,
            self.recovering(),
        );
        match step {
            LookupStep::Request(params) => {
                self.lock_lookups().insert(probed.to_owned(), lookup);
                self.request_http(Owner::Ancestry(probed.to_owned()), "session.get", params);
            }
            LookupStep::Finished => {
                self.lock_ancestry().finish(probed, self);
            }
            LookupStep::Waiting => {
                // A pass is already running: it covers these facts.
            }
            LookupStep::NeedsRecovery | LookupStep::Failed(_) => self.lookup_failed(probed),
            LookupStep::Admit(chain) => self.admit_chain(probed, chain),
        }
    }

    /// `for (const info of chain.toReversed()) admit(info, info.parentID); info(info)`.
    /// A failed admission, frame or replay fails the lookup, as the TypeScript's
    /// `catch` does; the probe then waits for a pass.
    fn admit_chain(&self, probed: &str, chain: Vec<Value>) {
        {
            let mut ownership = self.lock_ownership();
            for value in &chain {
                let Some(info) = parse_info(value) else {
                    drop(ownership);
                    return self.lookup_failed(probed);
                };
                if ownership.admit(&info, info.parent_id).is_err() {
                    drop(ownership);
                    return self.lookup_failed(probed);
                }
            }
        }
        for value in &chain {
            if self
                .emit(
                    FrameDirection::Recv,
                    "snapshot.info",
                    &json!({ "info": value }),
                )
                .is_err()
            {
                return self.lookup_failed(probed);
            }
        }
        if self.lock_ancestry().needs_recovery(probed) || self.recovering() {
            return self.lookup_failed(probed);
        }
        // The guard ends before the replay: `receive` re-enters `prove`.
        let events = self.lock_ancestry().events(probed);
        for (data, watermark) in events {
            if <Self as ProbeHost>::receive(self, &data, watermark).is_err() {
                return self.lookup_failed(probed);
            }
        }
        self.lock_ancestry().finish(probed, self);
    }

    /// The chain's `catch`: the probe keeps its facts for the next pass.
    fn lookup_failed(&self, probed: &str) {
        if !self.lock_ancestry().mark_failed(probed) {
            return;
        }
        let trigger = self.lock_ancestry().trigger(probed).unwrap_or(Value::Null);
        <Self as ProbeHost>::failed(self, &trigger);
    }
}
