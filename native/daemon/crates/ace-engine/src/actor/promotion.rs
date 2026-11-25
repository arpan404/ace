// SPDX-License-Identifier: Apache-2.0
//! One transaction's actor creation (`index.ts:528`-`:562`, step 7): the provisional actor takes
//! its slot at the commit, and the pledged victims are stopped and evicted there, exactly where
//! the TypeScript evicted them at the call. A rollback restores them untouched.

use crate::actor::{deps, mailbox, spawn_mailbox, state};
use crate::executor::Lane;
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
    let thread = promotion.created.clone();
    let held = core
        .with_state(|state| state.actors.reserved.contains_key(&thread))
        .unwrap_or(false);
    if !held {
        let counts = restore_promotion(core, promotion);
        lost_reservation(core, &thread, counts);
        return;
    }
    let deps = core.actor_deps.borrow().clone();
    // The victims stop the way the TypeScript's eviction stopped them: their leases release,
    // their drains resolve, and every acknowledgement they still hold settles as failed.
    let aside = std::mem::take(&mut *promotion.kept_aside.borrow_mut());
    for (_, mut actor) in aside {
        let id = actor.id.clone();
        let generation = actor.generation;
        let instance = actor.instance;
        let ops = take_ops(&mut actor);
        stop_aside(core, &deps, actor);
        // A parked task of an evicted victim wakes once to see it owns nothing.
        core.record_wake(&id);
        // The victim's sealed work commits, as the TypeScript's tail did after `stop()`.
        spawn_drain(core, &id, instance, generation, ops);
    }
    core.with_state(|state| {
        state.actors.reserved.shift_remove(&thread);
        for victim in &promotion.pledges {
            state.actors.pledges.shift_remove(victim);
        }
        if let Some(actor) = state.actors.by_thread.get_mut(&thread) {
            actor.provisional = false;
        }
    })
    .ok();
    spawn_mailbox(core, &thread);
}

/// A non-transactional eviction: `stop()` seals the pending frames, the actor leaves the map at
/// once, and its accepted work drains on the pump (as the TypeScript's tail did), busy retries
/// included, once the store lets it write.
pub fn evict_now(core: &Rc<Core>, thread: &ThreadId) {
    let deps = core.actor_deps.borrow().clone();
    crate::actor::stop(core, thread);
    let taken = core
        .with_state(|state| {
            state.actors.by_thread.get_mut(thread).map(|actor| {
                let ops = take_ops(actor);
                (ops, actor.generation, actor.instance)
            })
        })
        .ok()
        .flatten()
        .unwrap_or_default();
    let (ops, generation, instance) = taken;
    let actor = core
        .with_state(|state| state.actors.by_thread.shift_remove(thread))
        .ok()
        .flatten();
    if let Some(actor) = actor {
        stop_aside(core, &deps, actor);
    }
    // The evicted actor's task parks on its timer; waking it lets it see it owns nothing.
    core.record_wake(thread);
    spawn_drain(core, thread, instance, generation, ops);
}

/// Takes an actor's accepted work: unsealed pending frames become one batch, then the mailbox.
fn take_ops(actor: &mut state::Actor) -> Vec<mailbox::Op> {
    let mut ops = Vec::new();
    if !actor.pending.is_empty() {
        let frames = std::mem::take(&mut actor.pending);
        let bytes = actor.pending_bytes;
        actor.pending_bytes = 0;
        let ack = actor.pending_ack.take().unwrap_or_default();
        ops.push(mailbox::Op::Batch(Box::new(mailbox::BatchOp {
            frames,
            bytes,
            ack,
            admitted: true,
            memory: Default::default(),
        })));
    }
    while let Some(op) = actor.mailbox.pop_front() {
        ops.push(op);
    }
    ops
}

/// Drains an evicted actor's accepted work on the pump, one op per poll, as the mailbox would.
fn spawn_drain(
    core: &Rc<Core>,
    thread: &ThreadId,
    instance: u64,
    generation: u64,
    ops: Vec<mailbox::Op>,
) {
    if ops.is_empty() {
        return;
    }
    let owned = Rc::clone(core);
    let id = thread.clone();
    let task = core.executor.spawn(Lane::Work, async move {
        let mut queue = ops.into_iter();
        let mut failed = false;
        for op in queue.by_ref() {
            if !crate::actor::drain_op(&owned, &id, instance, generation, op).await {
                failed = true;
                break;
            }
        }
        if failed {
            // The first real failure poisoned the actor: the rest rejects and releases.
            reject_rest(&owned, queue);
        }
    });
    task.detach();
}

/// Rejects and releases everything a failed drain will not run.
fn reject_rest(core: &Rc<Core>, queue: impl Iterator<Item = mailbox::Op>) {
    for op in queue {
        match op {
            mailbox::Op::Batch(batch) => {
                let handles = mailbox::js_handles(&batch.frames);
                mailbox::release_js_handles(core, &handles);
                mailbox::settle_drained(core, batch.ack, false);
            }
            mailbox::Op::Run(run) => {
                if let Some(ack) = run.ack {
                    mailbox::settle_drained(core, ack, false);
                }
            }
            mailbox::Op::Settle(ack) => mailbox::settle_drained(core, ack, false),
            _ => {}
        }
    }
}

/// Stops an actor that a promotion moved aside: what `stop()` does, for one that is no longer
/// in the map.
fn stop_aside(core: &Rc<Core>, deps: &Rc<deps::ActorDeps>, mut actor: state::Actor) {
    let tokens: Vec<u64> = actor.leases.keys().copied().collect();
    if !tokens.is_empty() {
        deps.links.release_leases(core, &tokens);
    }
    for drain in actor.drains.drain(..) {
        let _ = drain.send(());
    }
    if let Some((timer, _)) = actor.timer.as_ref() {
        core.ports.cancel_timer(timer.key);
    }
    let id = actor.id.clone();
    state::discard_acks(core, actor);
    deps.repo.evict(core, &id);
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
            match state.actors.by_thread.get(&created) {
                Some(actor) if actor.provisional => state.actors.by_thread.shift_remove(&created),
                _ => None,
            }
        })
        .ok()
        .flatten();
    let mut aside = std::mem::take(&mut *promotion.kept_aside.borrow_mut());
    aside.sort_unstable_by_key(|(index, _)| *index);
    for (index, actor) in aside {
        let id = actor.id.clone();
        core.with_state(|state| {
            let at = index.min(state.actors.by_thread.len());
            state.actors.by_thread.shift_insert(at, id, actor);
        })
        .ok();
    }
    // Restored actors go back to their old seats, so a transaction that pledged two victims
    // restores the same order it found, whatever order its promotions drop in.
    core.with_state(|state| {
        state
            .actors
            .by_thread
            .sort_by(|_, left, _, right| left.seat.cmp(&right.seat))
    })
    .ok();
    let mut counts = (0, 0);
    if let Some(actor) = discarded {
        counts = (actor.staged.len(), actor.mailbox.len());
        state::discard_acks(core, actor);
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
