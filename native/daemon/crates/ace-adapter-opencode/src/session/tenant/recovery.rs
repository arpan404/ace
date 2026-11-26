// SPDX-License-Identifier: Apache-2.0
//! The tenant's side of a recovery pass (`session.ts:508`-`:572`): `resync`'s
//! single in-flight read, `prepareReplay`'s eight passes, and the host the
//! walk in `session/recovery.rs` reads.
//!
//! The walk's requests are `http` ports; a reply returns here through `reply`
//! and advances the same machine. Nothing awaits: every entry point returns
//! after publishing its request or its settle.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{SessionErrorWire, SessionEvent};
use ace_json::Value;
use indexmap::IndexMap;
use std::sync::atomic::Ordering;

use super::super::history::{Failure, Read as HistoryRead, Step as HistoryStep};
use super::super::http::{Owner, Reply};
use super::super::ownership::Info;
use super::super::recovery::{Recovery, RecoveryError, RecoveryHost, Step};
use super::OpenCodeTenant;

/// The code a failed pass settles with. It is never a transport code, so the
/// facade's `transientFailure` reads a refusal as final (`recovery-failure.ts`).
pub const RECOVERY_FAILED: &str = "ACE_SESSION_RECOVERY";
/// `if (pass >= 8) throw new Error("OpenCode ancestry recovery incomplete")`.
const MAX_PASSES: usize = 8;
/// `OpenCode ancestry recovery incomplete` (`session.ts:555`).
const ANCESTRY_INCOMPLETE: &str = "OpenCode ancestry recovery incomplete";

/// `this.recoveryRead` (`:509`) and `prepareReplay`'s loop (`:550`).
#[derive(Default)]
pub(crate) struct RecoveryRun {
    /// The read in flight, and the owner its requests name.
    read: Option<(Recovery, Owner)>,
    /// Every `resync` caller's settle id, joined to the read in flight.
    waiters: Vec<u64>,
    /// `prepareReplay` while it waits for a read: the next pass and its id.
    prepare: Option<Prepare>,
}

struct Prepare {
    pass: usize,
    id: u64,
}

impl OpenCodeTenant {
    /// `server.eventWatermark` at the reply the facade is about to deliver: the
    /// walk reads `started = p.watermark()` there, as the TypeScript's promise
    /// continuation did.
    pub fn set_watermark(&self, watermark: u64) {
        self.watermark.store(watermark, Ordering::SeqCst);
    }

    /// `resync` (`:508`-`:513`): a read already in flight is joined, and `id`
    /// settles with it.
    pub fn resync(&self, id: u64) {
        self.start_read(Owner::Recovery, Some(id));
    }

    /// `prepareReplay` (`:550`-`:570`): up to eight reads, then the positive
    /// snapshots and the probes' reconciliation.
    pub fn prepare_replay(&self, id: u64) {
        self.lock_recovery().prepare = Some(Prepare { pass: 0, id });
        self.prepare_eval(0, id);
    }

    /// One reply of the read in flight; a reply nobody waits on is dropped.
    pub(crate) fn recovery_reply(&self, reply: &Reply) {
        let outcome = {
            let mut run = self.lock_recovery();
            match run.read.take() {
                None => Ok(None),
                Some((mut machine, owner)) => match machine.step(reply, self) {
                    Ok(Step::Request { op, params }) => {
                        run.read = Some((machine, owner.clone()));
                        Ok(Some((owner, op, params)))
                    }
                    Ok(Step::Done) => Ok(None),
                    Err(error) => Err(error.to_string()),
                },
            }
        };
        match outcome {
            Ok(Some((owner, op, params))) => self.request_http(owner, op, params),
            Ok(None) => self.finish_read(None),
            Err(message) => self.finish_read(Some(message)),
        }
    }

    /// `resync`'s read, or a join on the one already running.
    fn start_read(&self, owner: Owner, waiter: Option<u64>) {
        let request = {
            let mut run = self.lock_recovery();
            if let Some(id) = waiter {
                run.waiters.push(id);
            }
            if run.read.is_some() {
                return;
            }
            if self.closed() || self.opening() {
                None
            } else {
                self.lock_evidence().pass();
                let (machine, step) = Recovery::begin(&self.root());
                match step {
                    Step::Request { op, params } => {
                        run.read = Some((machine, owner.clone()));
                        Some((owner, op, params))
                    }
                    Step::Done => None,
                }
            }
        };
        match request {
            Some((owner, op, params)) => self.request_http(owner, op, params),
            // `readSnapshots` returned before reading: its promise is settled.
            None => self.finish_read(None),
        }
    }

    /// The read ended: every joined caller settles, then `prepareReplay`'s loop
    /// either runs another pass or emits its replay.
    fn finish_read(&self, failure: Option<String>) {
        let (waiters, prepare) = {
            let mut run = self.lock_recovery();
            run.read = None;
            (std::mem::take(&mut run.waiters), run.prepare.take())
        };
        for id in waiters {
            match &failure {
                Some(message) => self.settle_failure(id, message.clone()),
                None => self.settle(id, Ok("null")),
            }
        }
        let Some(prepare) = prepare else {
            return;
        };
        match failure {
            // `await this.resync()` rejected, so the loop's promise rejects too.
            Some(message) => self.settle_failure(prepare.id, message),
            None => self.prepare_eval(prepare.pass, prepare.id),
        }
    }

    /// One turn of `prepareReplay`'s loop, before its next read.
    fn prepare_eval(&self, pass: usize, id: u64) {
        if !self.needs_snapshots() {
            return self.finish_prepare(id);
        }
        if pass >= MAX_PASSES {
            return self.settle_failure(id, String::from(ANCESTRY_INCOMPLETE));
        }
        self.lock_recovery().prepare = Some(Prepare { pass: pass + 1, id });
        self.start_read(Owner::Replay, None);
    }

    /// `ancestry.needsSnapshots(...) || ancestry.needsShellSnapshots(...)`.
    fn needs_snapshots(&self) -> bool {
        let ancestry = self.lock_ancestry();
        let evidence = self.lock_evidence();
        ancestry.needs_snapshots(&|session| evidence.complete(session), self)
            || ancestry
                .needs_shell_snapshots(&|shell, owner| evidence.complete_shell(shell, owner), self)
    }

    /// `prepareReplay`'s tail: the positive snapshots, then the probes.
    fn finish_prepare(&self, id: u64) {
        for snapshot in self.lock_evidence().positive() {
            if let Err(error) = self.emit(FrameDirection::Recv, snapshot.channel, &snapshot.data) {
                return self.settle_failure(id, error.0);
            }
        }
        match self.lock_ancestry().reconciled(self) {
            Ok(()) => self.settle(id, Ok("null")),
            Err(message) => self.settle_failure(id, message),
        }
    }

    /// A settle that carries the pass's own failure.
    fn settle_failure(&self, id: u64, message: String) {
        self.queue.publish(vec![SessionEvent::Settle {
            id,
            result: Err(SessionErrorWire {
                code: RECOVERY_FAILED,
                message,
            }),
        }]);
    }
}

impl RecoveryHost for OpenCodeTenant {
    fn watermark(&self) -> u64 {
        self.watermark.load(Ordering::SeqCst)
    }

    fn verify(&self, info: &Info<'_>) -> Result<(), RecoveryError> {
        self.lock_ownership()
            .verify(info)
            .map_err(|error| RecoveryError::Ownership(error.to_string()))
    }

    fn admit(&self, info: &Info<'_>, parent: &str) -> Result<(), RecoveryError> {
        self.lock_ownership()
            .admit(info, parent)
            .map_err(|error| RecoveryError::Ownership(error.to_string()))
    }

    fn direct_children(&self, id: &str) -> Vec<String> {
        self.lock_ownership()
            .direct_children(id)
            .iter()
            .cloned()
            .collect()
    }

    fn session_directories(&self) -> Vec<String> {
        let ownership = self.lock_ownership();
        let mut seen = indexmap::IndexSet::new();
        let mut directories = Vec::new();
        for owner in ownership.sessions().values() {
            if seen.insert(owner.directory.clone()) {
                directories.push(owner.directory.clone());
            }
        }
        directories
    }

    fn session_directory(&self, id: &str) -> Option<String> {
        self.lock_ownership()
            .sessions()
            .get(id)
            .map(|owner| owner.directory.clone())
    }

    fn shells(&self) -> IndexMap<String, String> {
        self.lock_ownership().shells().clone()
    }

    fn pending_shells(&self) -> IndexMap<String, String> {
        self.lock_ancestry().shells()
    }

    fn live_messages(&self, id: &str) -> Vec<String> {
        self.lock_translator().live_messages(id)
    }

    fn execution_observed(&self, id: &str) -> bool {
        self.lock_execution().contains(id)
    }

    fn history_begin(&self, id: &str) -> (HistoryRead, HistoryStep) {
        self.lock_history().begin(id)
    }

    fn history_step(
        &self,
        read: &mut HistoryRead,
        reply: &Reply,
        deliver: &mut dyn FnMut(&Value) -> Result<(), RecoveryError>,
    ) -> Result<HistoryStep, Failure<RecoveryError>> {
        self.lock_history().step(read, reply, deliver)
    }

    fn frame(&self, channel: &'static str, data: &Value) -> Result<(), RecoveryError> {
        self.emit(FrameDirection::Recv, channel, data)
            .map_err(|error| RecoveryError::Tenant(error.0))
    }

    fn receive(&self, data: &Value) -> Result<(), RecoveryError> {
        self.receive_value(data, self.watermark())
            .map_err(|error| RecoveryError::Tenant(error.0))
    }

    fn stage(
        &self,
        channel: &'static str,
        data: &Value,
        session: &str,
        started: u64,
    ) -> Result<(), RecoveryError> {
        let started = started.min(self.recovery_started());
        self.lock_evidence()
            .stage(channel, data, session, started)
            .map_err(|error| RecoveryError::Evidence(error.to_string()))
    }

    fn shell_snapshot(&self, id: &str, owner: &str, started: u64) -> Result<(), RecoveryError> {
        self.lock_evidence()
            .shell(id, owner, started)
            .map_err(|error| RecoveryError::Evidence(error.to_string()))
    }
}
