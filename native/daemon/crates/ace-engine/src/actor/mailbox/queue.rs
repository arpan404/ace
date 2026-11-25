// SPDX-License-Identifier: Apache-2.0
//! The queue itself: what an op is, how it is admitted, staged and selected (`actor.ts:191`-`:252`).

use super::limits;
use crate::actor::deps::BatchAck;
use crate::actor::state::Pending;
use crate::actor::{flow, fold, intake};
use crate::executor::{Deferred, Lane};
use crate::{Core, EngineError, ThreadId};
use std::cell::RefCell;
use std::rc::{Rc, Weak};

/// A run an operation performs; `FnMut` because a busy store retries the same run.
pub type RunFn = Box<dyn FnMut(&Rc<Core>) -> Result<(), EngineError>>;

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
fn admit(core: &Core, thread: &ThreadId, bytes: usize, frames: usize) -> Option<bool> {
    let limits = limits(core);
    core.with_state(|state| {
        let actor = state.actors.by_thread.get(thread)?;
        if actor.stopped || actor.overflowed {
            return Some(false);
        }
        Some(true)
    })
    .ok()
    .flatten()
    .filter(|accepted| *accepted)?;

    let over = core
        .with_state(|state| {
            let actor = state.actors.by_thread.get(thread)?;
            Some(
                actor.queued + frames > limits.max_queued_frames as usize
                    || actor.queued_bytes + bytes > limits.max_queued_bytes as usize,
            )
        })
        .ok()
        .flatten()
        .unwrap_or(true);
    if over {
        core.with_state(|state| {
            if let Some(actor) = state.actors.by_thread.get_mut(thread) {
                actor.overflowed = true;
                // Preserve the accepted prefix, then fail explicitly instead of dropping facts.
                actor.mailbox.push_back(Op::Overflow);
            }
        })
        .ok();
        return Some(false);
    }
    core.with_state(|state| {
        let limits = state.limits;
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.queued += frames;
            actor.queued_bytes += bytes;
            flow::update_pressure(actor, &limits);
        }
    })
    .ok();
    Some(true)
}

/// `enqueue(run)` (`actor.ts:191`): seal first, then admit the wrapped run. A timer that fired
/// before this call is caught up first, so its tick keeps its place ahead of this op.
pub fn enqueue(core: &Rc<Core>, thread: &ThreadId, run: RunFn) {
    intake::catch_up(core, thread);
    intake::seal(core, thread);
    if core.store.is_open() {
        stage(core, thread, run);
        return;
    }
    admit_run(core, thread, run);
}

/// A run the caller made must open its own transaction, exactly as `accept` wraps it
/// (`actor.ts:195`–`:197`): the op is one outermost write, never a bare port call.
fn atomic_run(run: RunFn) -> RunFn {
    let mut inner = run;
    Box::new(move |core: &Rc<Core>| core.store.atomic(|_tx| inner(core)))
}

/// `accept` outside a transaction: the capacity check, then the queue.
pub(crate) fn admit_run(core: &Rc<Core>, thread: &ThreadId, run: RunFn) {
    let Some(true) = admit(core, thread, 0, 1) else {
        return;
    };
    let run = atomic_run(run);
    core.with_state(|state| {
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.mailbox.push_back(Op::Run(Box::new(RunOp {
                run,
                bytes: 0,
                frames: 1,
                ack: None,
            })));
        }
    })
    .ok();
    core.record_wake(thread);
}

/// A run made inside an open transaction: a staged slot keeps its place, counts nothing, and is
/// admitted only once committed (step 7).
fn stage(core: &Rc<Core>, thread: &ThreadId, run: RunFn) {
    let slot = core
        .with_state(|state| {
            let next = state.actors.next_slot;
            state.actors.next_slot += 1;
            let shared = Rc::new(RefCell::new(Staged::Pending));
            if let Some(actor) = state.actors.by_thread.get_mut(thread) {
                actor.staged.insert(next, Rc::clone(&shared));
                actor.mailbox.push_back(Op::Staged(next));
            }
            next
        })
        .ok();
    let Some(slot) = slot else {
        return;
    };
    let shared = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .and_then(|actor| actor.staged.get(&slot).cloned())
        })
        .ok()
        .flatten();
    let Some(shared) = shared else {
        return;
    };
    let guard = StagedAdmit {
        owner: Rc::downgrade(core),
        thread: thread.clone(),
        slot,
        shared,
        run: Some(run),
        admitted: false,
    };
    let future = Box::pin(async move {
        let mut guard = guard;
        guard.admitted = true;
        if let Some(core) = guard.owner.upgrade() {
            admit_staged(&core, &guard.thread, guard.slot, guard.run.take());
        }
        guard.run = None;
    });
    core.defer(Deferred::Spawn(Lane::Work, future));
    core.record_wake(thread);
}

/// Owns a staged slot's op: on rollback it is dropped, which discards the slot and wakes the
/// mailbox to skip it.
struct StagedAdmit {
    owner: Weak<Core>,
    thread: ThreadId,
    slot: u64,
    shared: Rc<RefCell<Staged>>,
    run: Option<RunFn>,
    admitted: bool,
}

impl Drop for StagedAdmit {
    fn drop(&mut self) {
        if self.admitted {
            return;
        }
        if let Some(core) = self.owner.upgrade() {
            *self.shared.borrow_mut() = Staged::Discarded;
            core.record_wake(&self.thread);
        }
    }
}

/// On commit, the staged slot is admitted exactly where TypeScript's `accept` would run it: the
/// capacity check against the counts as they are now.
fn admit_staged(core: &Rc<Core>, thread: &ThreadId, slot: u64, run: Option<RunFn>) {
    let Some(run) = run else {
        return;
    };
    // A slot whose actor was discarded in the same transaction is never admitted: nothing is
    // charged to the actor restored in its place.
    let still_pending = core
        .with_state(|state| {
            let shared = state
                .actors
                .by_thread
                .get(thread)?
                .staged
                .get(&slot)?
                .clone();
            Some(matches!(*shared.borrow(), Staged::Pending))
        })
        .ok()
        .flatten()
        .unwrap_or(false);
    if !still_pending {
        return;
    }
    let Some(true) = admit(core, thread, 0, 1) else {
        discard_staged(core, thread, slot);
        return;
    };
    let shared = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .and_then(|actor| actor.staged.get(&slot).cloned())
        })
        .ok()
        .flatten();
    if let Some(shared) = shared {
        *shared.borrow_mut() = Staged::Ready(Box::new(RunOp {
            run: atomic_run(run),
            bytes: 0,
            frames: 1,
            ack: None,
        }));
    }
    core.record_wake(thread);
}

/// Drops a slot that was not admitted, and wakes the mailbox to skip it.
fn discard_staged(core: &Core, thread: &ThreadId, slot: u64) {
    let shared = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .and_then(|actor| actor.staged.get(&slot).cloned())
        })
        .ok()
        .flatten();
    if let Some(shared) = shared {
        *shared.borrow_mut() = Staged::Discarded;
    }
    core.record_wake(thread);
}

/// Takes the front entry, resolving staged slots.
pub fn take_next(core: &Core, thread: &ThreadId) -> Next {
    loop {
        let entry = core.with_state(|state| {
            let actor = state.actors.by_thread.get_mut(thread)?;
            let Some(front) = actor.mailbox.front() else {
                return Some(None);
            };
            match front {
                Op::Staged(slot) => Some(Some((true, *slot))),
                _ => Some(Some((false, 0))),
            }
        });
        match entry {
            Ok(None) | Err(_) => return Next::Exit,
            // The mailbox is empty.
            Ok(Some(Some((_, 0)))) if false => return Next::Park,
            Ok(Some(front)) => {
                let Some((staged, slot)) = front else {
                    return Next::Park;
                };
                if !staged {
                    let op = core.with_state(|state| {
                        let actor = state.actors.by_thread.get_mut(thread)?;
                        let op = actor.mailbox.pop_front();
                        // The op is in flight until it settles, so a flush waits for it even
                        // while it is parked on the store's retry timer.
                        if op.is_some() {
                            actor.running = true;
                        }
                        op
                    });
                    return match op {
                        Ok(Some(op)) => Next::Run(op),
                        _ => Next::Exit,
                    };
                }
                let ready = core.with_state(|state| {
                    let actor = state.actors.by_thread.get_mut(thread)?;
                    let shared = actor.staged.get(&slot)?.clone();
                    let mut state_borrow = shared.borrow_mut();
                    match &mut *state_borrow {
                        Staged::Ready(_) => {
                            let Staged::Ready(run) =
                                std::mem::replace(&mut *state_borrow, Staged::Discarded)
                            else {
                                unreachable!()
                            };
                            actor.staged.shift_remove(&slot);
                            actor.mailbox.pop_front();
                            actor.running = true;
                            Some(Next::Run(Op::Run(run)))
                        }
                        Staged::Discarded => {
                            actor.staged.shift_remove(&slot);
                            actor.mailbox.pop_front();
                            Some(Next::Park)
                        }
                        Staged::Pending => Some(Next::Wait),
                    }
                });
                match ready {
                    Ok(Some(Next::Park)) => continue,
                    Ok(Some(next)) => return next,
                    _ => return Next::Exit,
                }
            }
        }
    }
}
