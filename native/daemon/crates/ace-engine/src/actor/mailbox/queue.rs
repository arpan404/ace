// SPDX-License-Identifier: Apache-2.0
//! The queue itself: what an op is, how it is admitted, staged and selected (`actor.ts:191`-`:252`).

use super::limits;
use crate::actor::deps::BatchAck;
use crate::actor::state::{ActorInstance, ActorRef, Pending, current};
use crate::actor::{flow, fold, intake};
use crate::executor::Deferred;
use crate::{Core, EngineError, ThreadId};
use std::cell::RefCell;
use std::rc::{Rc, Weak};

/// A run an operation performs; `FnMut` because a busy store retries the same run.
pub type RunFn = Box<dyn FnMut(&Rc<Core>, &ActorRef) -> Result<(), EngineError>>;

/// What a sealed batch remembers across a retry: translation runs once (translators keep state),
/// and a retried batch never streams its facts a second time.
#[derive(Default)]
pub struct BatchMemory {
    pub translated: Option<fold::Translation>,
    pub streamed: Option<bool>,
    pub status_before: Option<ace_json::Value>,
    pub journal_written: bool,
}

/// One sealed frame batch.
pub struct BatchOp {
    pub frames: Vec<Pending>,
    pub bytes: usize,
    pub ack: BatchAck,
    pub admitted: bool,
    pub memory: BatchMemory,
}

/// One generic operation (`enqueue`), wrapped in `store.atomic` as `accept` wraps it.
pub struct RunOp {
    pub run: RunFn,
    pub bytes: usize,
    pub frames: usize,
    pub ack: Option<BatchAck>,
}

/// One mailbox entry.
pub enum Op {
    Batch(Box<BatchOp>),
    Run(Box<RunOp>),
    /// A refused batch's settle-only marker: it rejects after the ops before it.
    Settle(BatchAck),
    /// The overflow op: end the session visibly, then clear the flag.
    Overflow,
    /// A slot waiting for its transaction's commit.
    Staged(u64),
}

/// What a staged slot became.
pub enum Staged {
    Pending,
    Ready(Box<RunOp>),
    Discarded,
}

/// What the mailbox task found at the front.
pub enum Next {
    Run(Op),
    /// A staged slot is still waiting for its transaction.
    Wait,
    /// Nothing queued: park on the timers.
    Park,
    /// The actor is gone.
    Exit,
}

/// `acceptOperation(run, bytes, frames)` (`actor.ts:198`): the capacity check, then the queue.
fn admit(
    actor: &mut ActorInstance,
    limits: &crate::limits::EngineLimits,
    bytes: usize,
    frames: usize,
) -> bool {
    if actor.stopped || actor.overflowed {
        return false;
    }
    if actor.queued + frames > limits.max_queued_frames as usize
        || actor.queued_bytes + bytes > limits.max_queued_bytes as usize
    {
        actor.overflowed = true;
        // Keep the accepted prefix and fail explicitly after it.
        actor.mailbox.push_back(Op::Overflow);
        return false;
    }
    actor.queued += frames;
    actor.queued_bytes += bytes;
    flow::update_pressure(actor, limits);
    true
}

/// `enqueue(run)` (`actor.ts:191`): seal first, then admit the wrapped run. A timer that fired
/// before this call is caught up first, so its tick keeps its place ahead of this op.
pub fn enqueue(core: &Rc<Core>, thread: &ThreadId, run: RunFn) {
    let Some(actor) = current(core, thread) else {
        return;
    };
    enqueue_instance(core, &actor, run);
}

pub(crate) fn enqueue_instance(core: &Rc<Core>, actor: &ActorRef, run: RunFn) {
    intake::catch_up_instance(core, actor);
    intake::seal_instance(core, actor);
    if core.store.is_open() {
        stage(core, actor, run);
    } else {
        admit_instance_run(core, actor, run);
    }
}

/// A run the caller made must open its own transaction, exactly as `accept` wraps it
/// (`actor.ts:195`–`:197`): the op is one outermost write, never a bare port call.
fn atomic_run(run: RunFn) -> RunFn {
    let mut inner = run;
    Box::new(move |core, actor| core.store.atomic(|_tx| inner(core, actor)))
}

pub(crate) fn admit_instance_run(core: &Rc<Core>, actor: &ActorRef, run: RunFn) {
    let limits = limits(core);
    {
        let mut actor = actor.borrow_mut();
        if !admit(&mut actor, &limits, 0, 1) {
            return;
        }
        actor.mailbox.push_back(Op::Run(Box::new(RunOp {
            run: atomic_run(run),
            bytes: 0,
            frames: 1,
            ack: None,
        })));
    }
    core.record_actor_wake(actor);
}

/// A run made inside an open transaction: a staged slot keeps its place, counts nothing, and is
/// admitted only once committed (step 7).
fn stage(core: &Rc<Core>, actor: &ActorRef, run: RunFn) {
    if actor.borrow().stopped {
        return;
    }
    let Ok(slot) = core.with_state(|state| {
        let next = state.actors.next_slot;
        state.actors.next_slot += 1;
        next
    }) else {
        return;
    };
    let shared = Rc::new(RefCell::new(Staged::Pending));
    {
        let mut state = actor.borrow_mut();
        state.staged.insert(slot, Rc::clone(&shared));
        state.mailbox.push_back(Op::Staged(slot));
    }
    let guard = StagedAdmit {
        owner: Rc::downgrade(core),
        actor: Rc::downgrade(actor),
        shared,
        committed: false,
    };
    // Commit decisions run in token order. An earlier stage admits before a later promotion
    // seals its victim, including when the victim has already left the thread registry.
    core.defer(Deferred::Run(Box::new(move || guard.commit(run))));
    core.record_actor_wake(actor);
}

struct StagedAdmit {
    owner: Weak<Core>,
    actor: Weak<RefCell<ActorInstance>>,
    shared: Rc<RefCell<Staged>>,
    committed: bool,
}

impl StagedAdmit {
    fn commit(mut self, run: RunFn) {
        self.committed = true;
        let (Some(core), Some(actor)) = (self.owner.upgrade(), self.actor.upgrade()) else {
            return;
        };
        if !matches!(*self.shared.borrow(), Staged::Pending) {
            return;
        }
        let admitted = admit(&mut actor.borrow_mut(), &limits(&core), 0, 1);
        *self.shared.borrow_mut() = if admitted {
            Staged::Ready(Box::new(RunOp {
                run: atomic_run(run),
                bytes: 0,
                frames: 1,
                ack: None,
            }))
        } else {
            Staged::Discarded
        };
        core.record_actor_wake(&actor);
    }
}

impl Drop for StagedAdmit {
    fn drop(&mut self) {
        if !self.committed {
            *self.shared.borrow_mut() = Staged::Discarded;
            if let (Some(core), Some(actor)) = (self.owner.upgrade(), self.actor.upgrade()) {
                core.record_actor_wake(&actor);
            }
        }
    }
}

/// Takes the front entry, resolving staged slots.
pub fn take_next(core: &Core, thread: &ThreadId) -> Next {
    current(core, thread).map_or(Next::Exit, |actor| select_next(&mut actor.borrow_mut()))
}

pub(crate) fn select_next(actor: &mut ActorInstance) -> Next {
    loop {
        let Some(front) = actor.mailbox.front() else {
            return if actor.stopped {
                Next::Exit
            } else {
                Next::Park
            };
        };
        let Op::Staged(slot) = *front else {
            if let Some(op) = actor.mailbox.pop_front() {
                actor.running = true;
                return Next::Run(op);
            }
            return Next::Park;
        };
        let Some(shared) = actor.staged.get(&slot) else {
            return Next::Exit;
        };
        let mut state = shared.borrow_mut();
        if matches!(*state, Staged::Pending) {
            return Next::Wait;
        }
        let entry = std::mem::replace(&mut *state, Staged::Discarded);
        drop(state);
        actor.staged.shift_remove(&slot);
        actor.mailbox.pop_front();
        if let Staged::Ready(run) = entry {
            actor.running = true;
            return Next::Run(Op::Run(run));
        }
    }
}
