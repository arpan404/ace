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
pub mod task;
pub mod timer;

pub use deps::{
    ActorDeps, ActorLinks, ActorRepo, ActorTranslator, BatchAck, JsBatchTranslator, Route,
    ScheduleView, TranslatedFrame, Unported,
};
#[cfg(feature = "engine-probe")]
pub use probe::run_op_opened;
pub use promotion::restore_promotion;
pub use state::{ActorInstance, ActorRef, Actors, FrameRef, Pending};
pub use task::spawn_mailbox;
pub use timer::keeps_timer;

use crate::executor::TaskId;
use crate::{Core, EngineError, State, ThreadId};
use std::rc::Rc;

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
                .find(|(id, _)| {
                    !state.actors.seats[*id].provisional
                        && !victims.contains(id)
                        && !skipped.contains(id)
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
            // The victim leaves at the call, and every acknowledgement it still held settles.
            promotion::evict_now(core, victim);
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
    let mut actor = ActorInstance::new(thread.clone(), generation);
    actor.release_requested = released;
    actor.deps = Some(Rc::clone(&deps));
    actor.instance = core.with_state(|state| {
        let instance = state.actors.next_instance;
        state.actors.next_instance += 1;
        instance
    })?;
    let actor = Rc::new(std::cell::RefCell::new(actor));
    if !open {
        core.with_state(|state| {
            state.actors.seats.insert(
                thread.clone(),
                state::Seat {
                    order: seat,
                    provisional: open,
                },
            );
            state.actors.by_thread.insert(thread.clone(), actor);
        })?;
        spawn_mailbox(core, thread);
        return Ok(());
    }
    // Capture the victims' positions, then remove from the highest index down so the captured
    // positions stay exact. The kept-aside actors are restored there on a rollback.
    let mut aside = Vec::new();
    let mut positions: Vec<(usize, ThreadId)> = Vec::new();
    for victim in &victims {
        if let Some(index) = core.with_state(|state| state.actors.by_thread.get_index_of(victim))? {
            positions.push((index, victim.clone()));
        }
    }
    positions.sort_unstable_by_key(|(index, _)| std::cmp::Reverse(*index));
    for (index, victim) in positions {
        if let Some((victim_actor, seat)) = core.with_state(|state| state.actors.remove(&victim))? {
            aside.push((index, seat, victim_actor));
        }
    }
    core.with_state(|state| {
        state.actors.seats.insert(
            thread.clone(),
            state::Seat {
                order: seat,
                provisional: open,
            },
        );
        state.actors.by_thread.insert(thread.clone(), actor);
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
    if let Some(actor) = state::current(core, thread) {
        stop_instance(core, &actor);
    }
}

pub(crate) fn stop_instance(core: &Rc<Core>, actor: &ActorRef) {
    intake::catch_up_instance(core, actor);
    intake::seal_instance(core, actor);
    let drains = {
        let mut state = actor.borrow_mut();
        state.stopped = true;
        state.pressure = false;
        std::mem::take(&mut state.drains)
    };
    timer::disarm_instance(core, actor);
    leases::release_instance_inputs(core, actor);
    for drain in drains {
        let _ = drain.send(());
    }
    core.record_actor_wake(actor);
}

/// `flush_all` (E5.1's `actor::flush_all`): seal and flush every actor, excluding the caller.
pub async fn flush_all(core: &Rc<Core>, exclude: Option<TaskId>) -> Result<(), EngineError> {
    let instances: Vec<_> = core.with_state(|state| {
        state.actors.seals += 1;
        state.actors.instances().cloned().collect()
    })?;
    for actor in instances {
        mailbox::task::flush_instance(core, &actor, exclude).await;
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
    }
}

/// Terminal close also drops wakers when the deadline cut the mailbox joins short.
pub(crate) fn release_wakers(core: &Core) {
    let wakers: Vec<_> = core
        .with_state(|state| {
            state
                .actors
                .instances()
                .filter_map(|actor| actor.borrow_mut().waker.take())
                .collect()
        })
        .unwrap_or_default();
    drop(wakers);
}

/// Whether the actors hold no work E5.1 must wait for.
pub fn quiescent(state: &State, exclude: Option<TaskId>) -> bool {
    state.actors.instances().all(|actor| {
        let actor = actor.borrow();
        let own = exclude.is_some() && actor.mailbox_task == exclude;
        mailbox::actor_quiescent(&actor) || own
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
