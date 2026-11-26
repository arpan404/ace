// SPDX-License-Identifier: Apache-2.0
//! One transaction's actor creation (`index.ts:528`-`:562`, step 7): the provisional actor takes
//! its slot at the commit, and the pledged victims are stopped and evicted there, exactly where
//! the TypeScript evicted them at the call. A rollback restores them untouched.

use crate::actor::{spawn_mailbox, state, stop_instance};
use crate::{Core, ThreadId};
use std::rc::Rc;

/// The commit: the provisional actor takes the slot its reservation held, and the pledged
/// victims are stopped and evicted, which is what the TypeScript did at the call. A reservation
/// missing here is an invariant break, never a normal path: the actor is discarded and its work
/// fails visibly instead of acknowledging as success.
pub fn commit_promotion(core: &Rc<Core>, promotion: &Rc<state::Promotion>) {
    {
        let mut state = promotion.state.borrow_mut();
        if state.done || state.rolled_back {
            return;
        }
        state.done = true;
    }
    if core.closing.get() {
        // Close has already retired every registry a promotion could move into. A deferred commit
        // that fires now must not spawn a mailbox, re-insert a seat or add a stopping entry: the
        // kept-aside actors are retired with the rest.
        retire_kept_aside(core, promotion);
        return;
    }
    let thread = promotion.created.clone();
    let held = core
        .with_state(|state| state.actors.reserved.contains_key(&thread))
        .unwrap_or(false);
    if !held {
        let counts = restore_promotion(core, promotion);
        lost_reservation(core, &thread, counts);
        return;
    }
    core.with_state(|state| {
        state.actors.reserved.shift_remove(&thread);
        if let Some(seat) = state.actors.seats.get_mut(&thread) {
            seat.provisional = false;
        }
        for victim in &promotion.pledges {
            state.actors.pledges.shift_remove(victim);
        }
    })
    .ok();
    spawn_mailbox(core, &thread);
    let aside = std::mem::take(&mut *promotion.kept_aside.borrow_mut());
    for (_, _, actor) in aside {
        let instance = actor.borrow().instance;
        core.with_state(|state| state.actors.aside.shift_remove(&instance))
            .ok();
        stop_evicted(core, actor);
    }
}

/// Retire the actors a promotion kept for a rollback it can no longer make.
fn retire_kept_aside(core: &Rc<Core>, promotion: &state::Promotion) {
    let aside = std::mem::take(&mut *promotion.kept_aside.borrow_mut());
    for (_, _, actor) in aside {
        let instance = actor.borrow().instance;
        core.with_state(|state| state.actors.aside.shift_remove(&instance))
            .ok();
        crate::actor::retire_instance(core, &actor);
    }
}

/// Remove the seat immediately. The mailbox task keeps the accepted tail.
pub fn evict_now(core: &Rc<Core>, thread: &ThreadId) {
    let removed = core
        .with_state(|state| state.actors.remove(thread))
        .ok()
        .flatten();
    if let Some((actor, _)) = removed {
        stop_evicted(core, actor);
    }
}

fn stop_evicted(core: &Rc<Core>, actor: state::ActorRef) {
    let (instance, thread, has_mailbox) = {
        let state = actor.borrow();
        (
            state.instance,
            state.id.clone(),
            state.mailbox_task.is_some(),
        )
    };
    let deps = state::instance_deps(core, &actor);
    if has_mailbox {
        core.with_state(|state| state.actors.stopping.insert(instance, Rc::clone(&actor)))
            .ok();
    }
    stop_instance(core, &actor);
    deps.repo.evict(core, &thread);
}

/// A promotion that will not commit: release its reservation, restore the pledged victims at
/// their old positions, and remove the provisional actor (its acknowledgements still rejecting).
pub fn restore_promotion(core: &Rc<Core>, promotion: &state::Promotion) -> (usize, usize) {
    let created = promotion.created.clone();
    let discarded = core
        .with_state(|state| {
            for victim in &promotion.pledges {
                state.actors.pledges.shift_remove(victim);
            }
            state.actors.reserved.shift_remove(&created);
            // Only the provisional actor this promotion created is discarded: by now another
            // promotion's rollback may have restored this thread's committed actor in its place.
            state
                .actors
                .seats
                .get(&created)
                .is_some_and(|seat| seat.provisional)
                .then(|| state.actors.remove(&created))
                .flatten()
        })
        .ok()
        .flatten();
    let mut aside = std::mem::take(&mut *promotion.kept_aside.borrow_mut());
    aside.sort_unstable_by_key(|(index, _, _)| *index);
    let closing = core.closing.get();
    for (index, seat, actor) in aside {
        let id = actor.borrow().id.clone();
        let instance = actor.borrow().instance;
        if closing {
            // Close already retired every registry a promotion could restore into: the kept-aside
            // actor is retired with the rest rather than resurrected into a closed engine.
            core.with_state(|state| state.actors.aside.shift_remove(&instance))
                .ok();
            crate::actor::retire_instance(core, &actor);
            continue;
        }
        core.with_state(|state| {
            state.actors.aside.shift_remove(&instance);
            let at = index.min(state.actors.by_thread.len());
            state.actors.seats.insert(id.clone(), seat);
            state.actors.by_thread.shift_insert(at, id, actor);
        })
        .ok();
    }
    // Restored actors go back to their old seats, so a transaction that pledged two victims
    // restores the same order it found, whatever order its promotions drop in.
    core.with_state(|state| {
        let actors = &mut state.actors;
        actors
            .by_thread
            .sort_by(|left, _, right, _| actors.seats[left].order.cmp(&actors.seats[right].order));
    })
    .ok();
    let mut counts = (0, 0);
    if let Some((actor, _)) = discarded {
        counts = {
            let state = actor.borrow();
            (state.staged.len(), state.mailbox.len())
        };
        state::discard_acks(core, &actor);
    }
    counts
}

/// A reservation that could not be used at promotion: the actor's work is failed visibly and
/// the durable work behind it is woken to redeliver through a fresh actor.
fn lost_reservation(core: &Rc<Core>, thread: &ThreadId, counts: (usize, usize)) {
    let deps = core.actor_deps.borrow().clone();
    let (staged, queued) = counts;
    for _ in 0..staged.max(queued) {
        core.ports.report(format!(
            "Engine actor capacity reservation lost for {thread}"
        ));
    }
    if staged == 0 && queued == 0 {
        core.ports.report(format!(
            "Engine actor capacity reservation lost for {thread}"
        ));
    }
    deps.links.wake(core, thread);
}
