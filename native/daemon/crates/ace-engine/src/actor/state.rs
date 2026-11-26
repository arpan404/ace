// SPDX-License-Identifier: Apache-2.0
//! Actor instances and the registry that admits them (`actor.ts:52`-`:147`).

use crate::actor::deps::{ActorDeps, ActorTranslator, BatchAck};
use crate::actor::mailbox::Op;
use crate::executor::TaskId;
use crate::futures::channel::oneshot;
use crate::ports::Timer;
use crate::{Core, EngineError, ThreadId};
use ace_adapter_api::Frame;
use indexmap::IndexMap;
use std::cell::{Ref, RefCell, RefMut};
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
pub struct ActorInstance {
    pub id: ThreadId,
    pub generation: u64,
    /// This actor instance's identity: an evicted actor's task must not act on its replacement.
    pub instance: u64,
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
    pub staged: IndexMap<u64, Rc<RefCell<crate::actor::mailbox::Staged>>>,
    pub waker: Option<Waker>,
    pub translator: Option<(u64, ActorTranslator)>,
    pub deps: Option<Rc<ActorDeps>>,
}

impl ActorInstance {
    pub fn new(id: ThreadId, generation: u64) -> ActorInstance {
        ActorInstance {
            id,
            generation,
            instance: 0,
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
            staged: IndexMap::new(),
            waker: None,
            translator: None,
            deps: None,
        }
    }

    /// `backlog()` (`actor.ts:583`).
    pub fn backlog(&self) -> (usize, usize) {
        (
            self.queued + self.pending.len(),
            self.queued_bytes + self.pending_bytes,
        )
    }

    /// Restores a borrowed translator only while its session still owns this instance.
    pub fn return_translator(&mut self, taken: Option<(u64, ActorTranslator)>) {
        if self.translator.is_none()
            && taken
                .as_ref()
                .is_some_and(|(generation, _)| *generation == self.generation)
        {
            self.translator = taken;
        }
    }

    /// `retireGeneration()` (`actor.ts:149`), then `ActorLinks::expire`.
    pub fn retire_generation(&mut self) -> u64 {
        let generation = self.generation;
        self.generation += 1;
        generation
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
    /// The pledged actors, each with its index in `by_thread`, kept only for a rollback.
    pub kept_aside: RefCell<Vec<(usize, Seat, ActorRef)>>,
    pub state: RefCell<PromotionState>,
    pub owner: std::rc::Weak<Core>,
}

/// A dropped promotion never committed: the reservation is released, the pledged victims go
/// back untouched, and the provisional actor is discarded (E5.2 step 7).
impl Drop for Promotion {
    fn drop(&mut self) {
        if self.state.borrow().done {
            return;
        }
        if let Some(core) = self.owner.upgrade() {
            let _ = crate::actor::restore_promotion(&core, self);
        }
    }
}

/// Nothing a discarded actor held resolves: its acknowledgements reject, as a failed commit does.
/// A JavaScript acknowledgement is settled through its facade call, exactly as `settle` does.
pub(crate) fn discard_acks(core: &Core, actor: &ActorRef) {
    let (pending, pending_ack, mailbox, timer, batch_timer) = {
        let mut actor = actor.borrow_mut();
        // A slot that never reached its actor never admits: the transaction's deferred admission
        // is a no-op, so it cannot charge a restored actor for work that was discarded.
        for shared in actor.staged.values() {
            *shared.borrow_mut() = crate::actor::mailbox::Staged::Discarded;
        }
        (
            std::mem::take(&mut actor.pending),
            actor.pending_ack.take(),
            std::mem::take(&mut actor.mailbox),
            actor.timer.take().map(|(timer, _)| timer.key),
            actor.batch_timer.take().map(|timer| timer.key),
        )
    };
    for key in [timer, batch_timer].into_iter().flatten() {
        core.ports.cancel_timer(key);
    }
    // Frames this actor will never translate release the shell's objects with it.
    crate::actor::intake::release_handles(core, actor, &pending);
    for op in mailbox.iter() {
        if let Op::Batch(batch) = op {
            // Only what the batch still owns: a fold that ran before the discard already took the
            // live handles.
            let owned = batch.handles.borrow_mut().take_all();
            if !owned.is_empty() {
                crate::actor::mailbox::release_js_handles(core, actor, &owned);
            }
        }
    }
    let mut acks: Vec<BatchAck> = Vec::new();
    if let Some(ack) = pending_ack {
        acks.push(ack);
    }
    for op in mailbox {
        match op {
            Op::Batch(batch) => acks.push(batch.ack),
            Op::Settle(ack) => acks.push(ack),
            _ => {}
        }
    }
    for mut ack in acks {
        let js = ack.js;
        ack.reject("Provider frame failed to commit");
        if let Some(call) = js {
            let deps = instance_deps(core, actor);
            deps.acks
                .settle(call, Some("Provider frame failed to commit".to_string()));
        }
    }
}

pub type ActorRef = Rc<RefCell<ActorInstance>>;

pub struct Seat {
    pub order: u64,
    pub provisional: bool,
}

/// The thread actors. Insertion order is the TypeScript `Map`'s.
#[derive(Default)]
pub struct Actors {
    pub by_thread: IndexMap<ThreadId, ActorRef>,
    pub seats: IndexMap<ThreadId, Seat>,
    /// Pledged victims kept aside for a rollback, by instance. Their session still holds them, so
    /// a frame or flow call made during the transaction resolves here: the actor comes back
    /// untouched on a rollback, and its batch is sealed when a commit evicts it.
    pub aside: IndexMap<u64, ActorRef>,
    /// Evicted actors whose accepted tail still belongs to engine flush and close.
    pub stopping: IndexMap<u64, ActorRef>,
    /// Slots held by actors created in a transaction that has not committed.
    pub reserved: IndexMap<ThreadId, ()>,
    /// Victims pledged by an uncommitted creation; the promotion keeps the actors aside.
    pub pledges: IndexMap<ThreadId, ()>,
    /// Flushes that asked every actor to seal its pending frame batch (the probe's count).
    pub seals: u32,
    /// The next staged slot's id.
    pub next_slot: u64,
    /// The next actor's insertion order.
    pub next_seat: u64,
    /// The next actor instance's identity.
    pub next_instance: u64,
}

impl Actors {
    pub fn get(&self, thread: &str) -> Option<Ref<'_, ActorInstance>> {
        self.by_thread.get(thread).map(|actor| actor.borrow())
    }

    pub fn get_mut(&self, thread: &str) -> Option<RefMut<'_, ActorInstance>> {
        self.by_thread.get(thread).map(|actor| actor.borrow_mut())
    }

    pub fn remove(&mut self, thread: &str) -> Option<(ActorRef, Seat)> {
        let actor = self.by_thread.shift_remove(thread)?;
        let seat = self.seats.shift_remove(thread)?;
        Some((actor, seat))
    }

    /// The occupied slots: committed actors plus held reservations.
    pub fn occupied(&self) -> usize {
        self.seats.values().filter(|seat| !seat.provisional).count() + self.reserved.len()
    }

    pub fn instances(&self) -> impl Iterator<Item = &ActorRef> {
        self.by_thread.values().chain(self.stopping.values())
    }

    /// The actor one session holds, by its instance: current, kept aside for a rollback, or
    /// stopped but still finishing its accepted tail.
    pub fn instance(&self, thread: &str, instance: u64) -> Option<ActorRef> {
        self.by_thread
            .get(thread)
            .filter(|actor| actor.borrow().instance == instance)
            .or_else(|| self.aside.get(&instance))
            .or_else(|| self.stopping.get(&instance))
            .filter(|actor| actor.borrow().id == thread)
            .cloned()
    }

    /// Actors in insertion order, skipping actors kept aside for a rollback.
    pub fn live(&self) -> impl Iterator<Item = Ref<'_, ActorInstance>> {
        self.by_thread.values().map(|actor| actor.borrow())
    }
}

/// The dependencies that belong to a session, or the engine defaults for a bare actor.
pub fn instance_deps(core: &Core, actor: &ActorRef) -> Rc<ActorDeps> {
    actor
        .borrow()
        .deps
        .clone()
        .unwrap_or_else(|| core.actor_deps.borrow().clone())
}

/// Captures the current actor for a synchronous entry.
pub fn current(core: &Core, thread: &str) -> Option<ActorRef> {
    core.with_state(|state| state.actors.by_thread.get(thread).cloned())
        .ok()
        .flatten()
}

/// The re-entrancy bug the actor never makes: `with_state` refused a nested borrow.
pub fn reentrant(core: &Core, error: EngineError) {
    core.ports.report(error.to_string());
}

/// Resolves a session's original actor, even after its seat has been reused.
pub fn session_instance(core: &Core, thread: &str, instance: u64) -> Option<ActorRef> {
    core.with_state(|state| state.actors.instance(thread, instance))
        .ok()
        .flatten()
}
