// SPDX-License-Identifier: Apache-2.0
//! The actor's state (`actor.ts:52`–`:147`). Everything here is plain data: the translator is a
//! port and lives in `ActorDeps.translators`, and every read or change is one short `with_state`
//! closure that copies out what the next step needs.

use crate::actor::deps::{ActorTranslator, BatchAck};
use crate::actor::mailbox::Op;
use crate::executor::TaskId;
use crate::futures::channel::oneshot;
use crate::ports::Timer;
use crate::{Core, EngineError, ThreadId};
use ace_adapter_api::Frame;
use indexmap::IndexMap;
use std::cell::RefCell;
use std::rc::Rc;
use std::task::Waker;

/// One retained input lease (`actor.ts:154`–`:190`).
pub struct Lease {
    pub token: u64,
    pub run_id: Option<String>,
}

/// One frame waiting for its batch.
pub struct Pending {
    pub frame: FrameRef,
    pub generation: u64,
    pub bytes: usize,
}

/// Where a frame came from: a JavaScript session's object, held by the shell under a handle, or
/// a native session's typed frame (ADR 0223 §7, "Native both").
pub enum FrameRef {
    /// A JavaScript session's frame, held by the shell under a handle; `sdk` is its channel.
    Js {
        handle: u32,
        sdk: bool,
    },
    Native(Box<Frame>),
}

impl FrameRef {
    /// Whether the frame is on the `sdk` channel, for an SDK batch's rules.
    pub fn is_sdk(&self) -> bool {
        match self {
            FrameRef::Js { sdk, .. } => *sdk,
            FrameRef::Native(frame) => frame.channel == "sdk",
        }
    }
}

/// A deadline timer, with the instant it was armed at (`actor.ts:109`).
pub struct ArmedTimer {
    pub at: f64,
    pub armed_at: f64,
}

/// One thread's actor.
pub struct Actor {
    pub id: ThreadId,
    pub generation: u64,
    pub poisoned: bool,
    pub persistence_failed: bool,
    pub idle_since: Option<f64>,
    pub idle_due: bool,
    pub release_requested: bool,
    /// `actor.session !== undefined`, set by E5.6 or the probe.
    pub session_attached: bool,
    pub leases: IndexMap<u64, Lease>,
    pub queued: usize,
    pub queued_bytes: usize,
    pub pending: Vec<Pending>,
    pub pending_bytes: usize,
    /// The open batch's acknowledgement (decision 4).
    pub pending_ack: Option<BatchAck>,
    /// The batch timer and its fired receiver, polled by the mailbox task (decision 3).
    pub batch_timer: Option<Timer>,
    pub overflowed: bool,
    pub pressure: bool,
    pub drains: Vec<oneshot::Sender<()>>,
    /// `flush` waiters: resolved when the mailbox is idle.
    pub flush_waiters: Vec<oneshot::Sender<()>>,
    pub mailbox: std::collections::VecDeque<Op>,
    /// An op is mid-run and still holds its `queued` until it ends.
    pub running: bool,
    pub timer: Option<(Timer, ArmedTimer)>,
    pub stopped: bool,
    pub mailbox_task: Option<TaskId>,
    /// Inside an open transaction the actor holds its slot but is not committed yet.
    pub provisional: bool,
    pub staged: IndexMap<u64, Rc<RefCell<crate::actor::mailbox::Staged>>>,
    pub waker: Option<Waker>,
}

impl Actor {
    pub fn new(id: ThreadId, generation: u64) -> Actor {
        Actor {
            id,
            generation,
            poisoned: false,
            persistence_failed: false,
            idle_since: None,
            idle_due: false,
            release_requested: false,
            session_attached: false,
            leases: IndexMap::new(),
            queued: 0,
            queued_bytes: 0,
            pending: Vec::new(),
            pending_bytes: 0,
            pending_ack: None,
            batch_timer: None,
            overflowed: false,
            pressure: false,
            drains: Vec::new(),
            flush_waiters: Vec::new(),
            mailbox: std::collections::VecDeque::new(),
            running: false,
            timer: None,
            stopped: false,
            mailbox_task: None,
            provisional: false,
            staged: IndexMap::new(),
            waker: None,
        }
    }

    /// `backlog()` (`actor.ts:583`).
    pub fn backlog(&self) -> (usize, usize) {
        (
            self.queued + self.pending.len(),
            self.queued_bytes + self.pending_bytes,
        )
    }

    /// `retireGeneration()` (`actor.ts:149`), then `ActorLinks::expire`.
    pub fn retire_generation(&mut self) -> u64 {
        let generation = self.generation;
        self.generation += 1;
        generation
    }

    /// The translator's own deadline, when one is attached.
    pub fn next_deadline(&self, deps: &crate::actor::deps::ActorDeps) -> Option<i64> {
        let mut translators = deps.translators.borrow_mut();
        let (_, translator) = translators.get_mut(&self.id)?;
        match translator {
            ActorTranslator::Js(js) => js.next_deadline(),
            ActorTranslator::Native(native) => native.next_deadline(),
        }
    }
}

/// Why a promotion is still pending: an actor created in an open transaction, or a victim it
/// pledged, waits for the transaction's outcome.
#[derive(Default)]
pub struct PromotionState {
    pub done: bool,
    pub rolled_back: bool,
}

/// One transaction's actor-creation reservations and pledged victims.
pub struct Promotion {
    pub created: ThreadId,
    pub pledges: Vec<ThreadId>,
    pub kept_aside: Vec<Actor>,
    pub state: RefCell<PromotionState>,
    pub owner: std::rc::Weak<Core>,
}

/// The thread actors. Insertion order is the TypeScript `Map`'s.
#[derive(Default)]
pub struct Actors {
    pub by_thread: IndexMap<ThreadId, Actor>,
    /// Slots held by actors created in a transaction that has not committed.
    pub reserved: IndexMap<ThreadId, ()>,
    /// Committed promotions, completed in commit order by the next sync entry or poll.
    pub promotions: Vec<Rc<Promotion>>,
    /// Flushes that asked every actor to seal its pending frame batch (the probe's count).
    pub seals: u32,
    /// The next staged slot's id.
    pub next_slot: u64,
}

impl Actors {
    /// The occupied slots: committed actors plus held reservations.
    pub fn occupied(&self) -> usize {
        self.by_thread
            .values()
            .filter(|actor| !actor.provisional)
            .count()
            + self.reserved.len()
    }

    /// Actors in insertion order, skipping actors kept aside for a rollback.
    pub fn live(&self) -> impl Iterator<Item = &Actor> {
        self.by_thread.values()
    }
}

/// The re-entrancy bug the actor never makes: `with_state` refused a nested borrow.
pub fn reentrant(core: &Core, error: EngineError) {
    core.ports.report(error.to_string());
}
