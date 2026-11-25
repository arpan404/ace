// SPDX-License-Identifier: Apache-2.0
//! The thread actors (E5.2): the one mailbox that orders a thread's frames, ticks and engine
//! operations, and the task that folds them one per poll.

pub mod deps;
pub mod failure;
pub mod flow;
pub mod fold;
pub mod frame_ack;
pub mod intake;
pub mod leases;
pub mod mailbox;
pub mod native;
#[cfg(feature = "engine-probe")]
pub mod probe;
pub mod promotion;
pub mod rules;
pub mod state;
pub mod timer;

pub use deps::{
    ActorDeps, ActorLinks, ActorRepo, ActorTranslator, BatchAck, JsBatchTranslator, Route,
    ScheduleView, TranslatedFrame, Unported,
};
#[cfg(feature = "engine-probe")]
pub use probe::run_op_opened;
pub use promotion::restore_promotion;
pub use state::{Actor, Actors, FrameRef, Pending};
pub use timer::keeps_timer;

use crate::executor::{Lane, TaskId};
use crate::{Core, EngineError, State, ThreadId};
use std::rc::Rc;

/// Spawns an actor's mailbox task and records its id.
pub fn spawn_mailbox(core: &Rc<Core>, thread: &ThreadId) -> TaskId {
    let inner = Rc::clone(core);
    let id = thread.clone();
    let (task_id, task) = core
        .executor
        .spawn_next(Lane::Work, async move { mailbox_loop(inner, id).await });
    core.with_state(|state| {
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.mailbox_task = Some(task_id);
        }
    })
    .ok();
    task.detach();
    task_id
}

/// One actor's task: catch up, run one op, yield; or park on both timers.
async fn mailbox_loop(core: Rc<Core>, thread: ThreadId) {
    loop {
        intake::catch_up(&core, &thread);
        match mailbox::take_next(&core, &thread) {
            crate::actor::mailbox::Next::Exit => {
                core.unregister_waker(&thread);
                return;
            }
            mailbox::Next::Wait => yield_once().await,
            mailbox::Next::Park => {
                let idle = core
                    .with_state(|state| {
                        state
                            .actors
                            .by_thread
                            .get_mut(&thread)
                            .is_some_and(mailbox::resolve_flush_waiters)
                    })
                    .unwrap_or(true);
                if idle {
                    // A flush may have waited for the flag before the mailbox went idle.
                    core.with_state(|state| {
                        if let Some(actor) = state.actors.by_thread.get_mut(&thread) {
                            mailbox::resolve_flush_waiters(actor);
                        }
                    })
                    .ok();
                }
                if !mailbox::park(&core, &thread).await {
                    core.unregister_waker(&thread);
                    return;
                }
            }
            mailbox::Next::Run(op) => {
                let end_turn = run_op(&core, &thread, op).await;
                // The op settled: the mailbox is idle again, and a flush waiting on it resumes.
                core.with_state(|state| {
                    if let Some(actor) = state.actors.by_thread.get_mut(&thread) {
                        actor.running = false;
                        mailbox::resolve_flush_waiters(actor);
                    }
                })
                .ok();
                if end_turn {
                    core.executor.end_turn();
                }
                yield_once().await;
            }
        }
    }
}

/// Runs one mailbox entry and settles its acknowledgement.
async fn run_op(core: &Rc<Core>, thread: &ThreadId, op: mailbox::Op) -> bool {
    match op {
        mailbox::Op::Batch(mut batch) => {
            let frames = batch.frames.len();
            let bytes = batch.bytes;
            let ack = std::mem::take(&mut batch.ack);
            let thread_copy = thread.clone();
            let mut run: mailbox::RunFn =
                Box::new(move |core: &Rc<Core>| fold::fold_batch(core, &thread_copy, &mut batch));
            run_and_settle(core, thread, &mut run, frames, bytes, Some(ack)).await
        }
        mailbox::Op::Run(mut run_op) => {
            let mut call = run_op.run;
            let frames = run_op.frames;
            let bytes = run_op.bytes;
            let ack = run_op.ack.take();
            run_and_settle(core, thread, &mut call, frames, bytes, ack).await
        }
        mailbox::Op::Settle(ack) => mailbox::settle_rejected(core, ack),
        mailbox::Op::Overflow => {
            // The overflow behind the same writable gate as any op: a held store waits, as the
            // TypeScript's `runWhenWritable` does, instead of aborting the session mid-write.
            let op_thread = thread.clone();
            let mut run: mailbox::RunFn =
                Box::new(move |core: &Rc<Core>| failure::overflow(core, &op_thread));
            if let Err(error) = mailbox::run_when_writable(core, thread, &mut run).await {
                failure::fail(core, thread, error);
            }
            false
        }
        mailbox::Op::Staged(_) => false,
    }
}

async fn run_and_settle(
    core: &Rc<Core>,
    thread: &ThreadId,
    run: &mut mailbox::RunFn,
    frames: usize,
    bytes: usize,
    ack: Option<BatchAck>,
) -> bool {
    // The pump never runs inside a transaction; the check confirms it.
    let outcome = if core.store.is_open() {
        Err(EngineError::NotOutermost)
    } else {
        mailbox::run_when_writable(core, thread, run).await
    };
    if let Err(error) = outcome {
        failure::fail(core, thread, error);
    }
    match ack {
        Some(ack) => mailbox::settle(core, thread, frames, bytes, ack),
        None => {
            mailbox::settle(core, thread, frames, bytes, BatchAck::default());
            false
        }
    }
}

/// A macrotask: the next poll runs the work queued behind this turn.
async fn yield_once() {
    let mut yielded = false;
    crate::futures::future::poll_fn(|cx| {
        if yielded {
            return std::task::Poll::Ready(());
        }
        yielded = true;
        cx.waker().wake_by_ref();
        std::task::Poll::Pending
    })
    .await
}

/// `actor(id)` (`index.ts:528`–`:562`): the actor, created at capacity or inside a transaction.
pub fn get_or_create(core: &Rc<Core>, thread: &ThreadId) -> Result<(), EngineError> {
    if core.with_state(|state| state.actors.by_thread.contains_key(thread))? {
        return Ok(());
    }
    let deps = core.actor_deps.borrow().clone();
    let limits = core.with_state(|state| state.limits)?;
    let retiring = deps.repo.retiring_count(core)?;
    let room = limits.max_active_threads as usize + retiring;
    let open = core.store.is_open();
    // Victims in insertion order: outside a transaction they are evicted at the call; inside one
    // they are pledged and moved aside, so a lookup of one builds a fresh actor (step 7).
    let mut victims: Vec<ThreadId> = Vec::new();
    let mut skipped: Vec<ThreadId> = Vec::new();
    loop {
        let occupied = core.with_state(|state| state.actors.occupied())?;
        if occupied.saturating_sub(victims.len()) < room {
            break;
        }
        let candidate = core.with_state(|state| {
            state
                .actors
                .by_thread
                .iter()
                .find(|(id, actor)| {
                    !actor.provisional && !victims.contains(id) && !skipped.contains(id)
                })
                .map(|(id, _)| id.clone())
        })?;
        let Some(candidate) = candidate else {
            break;
        };
        if deps.repo.reserved_slot(core, &candidate)? {
            // A retiring session keeps its actor until its close completes: skip, never pledge.
            skipped.push(candidate);
            continue;
        }
        victims.push(candidate);
        if !open {
            break;
        }
    }
    if !open {
        for victim in &victims {
            stop(core, victim);
            deps.repo.evict(core, victim);
            core.with_state(|state| {
                state.actors.by_thread.shift_remove(victim);
            })?;
        }
        if core.with_state(|state| state.actors.occupied())? >= room {
            return Err(EngineError::ActorCapacityExceeded);
        }
    } else if core
        .with_state(|state| state.actors.occupied())?
        .saturating_sub(victims.len())
        >= room
    {
        // Every remaining actor holds a slot: throw at the call, as TypeScript does.
        return Err(EngineError::ActorCapacityExceeded);
    }
    let released = deps.repo.released_thread(core, thread)?;
    // A fresh actor takes the stored maximum, whichever backend retired the last generation.
    let generation = deps.repo.latest_generation(core, thread)?;
    let seat = core.with_state(|state| {
        let seat = state.actors.next_seat;
        state.actors.next_seat += 1;
        seat
    })?;
    let mut actor = Actor::new(thread.clone(), generation, seat);
    actor.release_requested = released;
    if !open {
        core.with_state(|state| {
            state.actors.by_thread.insert(thread.clone(), actor);
        })?;
        spawn_mailbox(core, thread);
        return Ok(());
    }
    // Capture the victims' positions, then remove from the highest index down so the captured
    // positions stay exact. The kept-aside actors are restored there on a rollback.
    let mut aside: Vec<(usize, Actor)> = Vec::new();
    let mut positions: Vec<(usize, ThreadId)> = Vec::new();
    for victim in &victims {
        if let Some(index) = core.with_state(|state| state.actors.by_thread.get_index_of(victim))? {
            positions.push((index, victim.clone()));
        }
    }
    positions.sort_unstable_by_key(|(index, _)| std::cmp::Reverse(*index));
    for (index, victim) in positions {
        if let Some(victim_actor) =
            core.with_state(|state| state.actors.by_thread.shift_remove(&victim))?
        {
            aside.push((index, victim_actor));
        }
    }
    core.with_state(|state| {
        state.actors.by_thread.insert(thread.clone(), actor);
        if let Some(created) = state.actors.by_thread.get_mut(thread) {
            created.provisional = true;
        }
        state.actors.reserved.insert(thread.clone(), ());
    })?;
    let promotion = Rc::new(state::Promotion {
        created: thread.clone(),
        pledges: victims.clone(),
        kept_aside: std::cell::RefCell::new(aside),
        state: std::cell::RefCell::new(state::PromotionState::default()),
        owner: Rc::downgrade(core),
    });
    core.with_state(|state| {
        for victim in &victims {
            state.actors.pledges.insert(victim.clone(), ());
        }
    })?;
    // The promotion runs at the commit itself, so the next synchronous lookup sees it, exactly
    // as the TypeScript's eviction at the call was visible at once (step 7).
    let owner = Rc::clone(core);
    let committed = Rc::clone(&promotion);
    core.defer(crate::executor::Deferred::Run(Box::new(move || {
        promotion::commit_promotion(&owner, &committed);
    })));
    core.record_wake(thread);
    Ok(())
}

/// `stop()` (`actor.ts:599`): seal first, then stop everything the actor holds.
pub fn stop(core: &Rc<Core>, thread: &ThreadId) {
    intake::seal(core, thread);
    let deps = core.actor_deps.borrow().clone();
    let leases = core
        .with_state(|state| {
            let Some(actor) = state.actors.by_thread.get_mut(thread) else {
                return Vec::new();
            };
            actor.stopped = true;
            actor.pressure = false;
            for drain in actor.drains.drain(..) {
                let _ = drain.send(());
            }
            let tokens: Vec<u64> = actor.leases.keys().copied().collect();
            actor.leases.clear();
            tokens
        })
        .unwrap_or_default();
    timer::disarm(core, thread);
    if !leases.is_empty() {
        deps.links.release_leases(core, &leases);
    }
}

/// `flush_all` (E5.1's `actor::flush_all`): seal and flush every actor, excluding the caller.
pub async fn flush_all(core: &Rc<Core>, exclude: Option<TaskId>) -> Result<(), EngineError> {
    let threads: Vec<ThreadId> = core.with_state(|state| {
        let threads: Vec<ThreadId> = state.actors.by_thread.keys().cloned().collect();
        state.actors.seals += 1;
        threads
    })?;
    for thread in threads {
        mailbox::flush(Rc::clone(core), thread, exclude).await;
    }
    Ok(())
}

/// `close_flush`: every actor seals and flushes, under close's deadline.
pub async fn close_flush(core: &Rc<Core>) -> Result<(), EngineError> {
    flush_all(core, None).await
}

/// `close_stop`: every actor stops, and its waker goes with it.
pub fn close_stop(core: &Rc<Core>) {
    let threads: Vec<ThreadId> = core
        .with_state(|state| state.actors.by_thread.keys().cloned().collect())
        .unwrap_or_default();
    for thread in threads {
        stop(core, &thread);
        core.unregister_waker(&thread);
    }
}

/// Whether the actors hold no work E5.1 must wait for.
pub fn quiescent(state: &State, exclude: Option<TaskId>) -> bool {
    state.actors.by_thread.values().all(|actor| {
        let own = exclude.is_some() && actor.mailbox_task == exclude;
        mailbox::actor_quiescent(actor) || own
    })
}

/// `liveThreadIds()` (`index.ts:1049`): the actors' ids in insertion order.
pub fn live_thread_ids(state: &State) -> Vec<ThreadId> {
    state.actors.by_thread.keys().cloned().collect()
}

/// `observeInputs`, called by E5.3's apply.
pub use leases::observe_inputs;

/// A thread's own rules, for E5.3's calls.
pub use rules::has_running_foreground_command;
