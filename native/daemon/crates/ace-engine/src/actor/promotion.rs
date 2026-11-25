// SPDX-License-Identifier: Apache-2.0
//! One transaction's actor creation (`index.ts:528`-`:562`, step 7): the provisional actor takes
//! its slot at the commit, and the pledged victims are stopped and evicted there, exactly where
//! the TypeScript evicted them at the call. A rollback restores them untouched.

use crate::actor::{deps, failure, fold, mailbox, spawn_mailbox, state};
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
        let ops = take_ops(&mut actor);
        stop_aside(core, &deps, actor);
        // A parked task of an evicted victim wakes once to see it owns nothing.
        core.record_wake(&id);
        // The victim's sealed work commits, as the TypeScript's tail did after `stop()`.
        spawn_drain(core, &id, generation, ops);
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

/// Takes an actor's accepted work out: unsealed pending frames become one batch, then the
/// mailbox's ops. Nothing is rejected; the drain runs them.
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

/// Spawns the drain of an evicted actor's accepted work, once the store lets it write.
fn spawn_drain(core: &Rc<Core>, thread: &ThreadId, generation: u64, ops: Vec<mailbox::Op>) {
    if ops.is_empty() {
        return;
    }
    let deps = core.actor_deps.borrow().clone();
    let owned = Rc::clone(core);
    let id = thread.clone();
    let task = core.executor.spawn(Lane::Work, async move {
        deps.live.writable().await;
        drain(owned, id, generation, ops).await;
    });
    task.detach();
}

/// A non-transactional eviction: `stop()` seals the pending frames, the actor leaves the map at
/// once, and the sealed work drains once the store is writable, as the TypeScript's tail did.
pub fn evict_now(core: &Rc<Core>, thread: &ThreadId) {
    let deps = core.actor_deps.borrow().clone();
    crate::actor::stop(core, thread);
    let taken = core
        .with_state(|state| {
            state.actors.by_thread.get_mut(thread).map(|actor| {
                let ops = take_ops(actor);
                (ops, actor.generation)
            })
        })
        .ok()
        .flatten()
        .unwrap_or_default();
    let (ops, generation) = taken;
    let actor = core
        .with_state(|state| state.actors.by_thread.shift_remove(thread))
        .ok()
        .flatten();
    if let Some(actor) = actor {
        stop_aside(core, &deps, actor);
    }
    // The evicted actor's task parks on its timer; waking it lets it see it owns nothing.
    core.record_wake(thread);
    spawn_drain(core, thread, generation, ops);
}

/// Runs the sealed ops an eviction took: busy errors retry, the first real failure poisons and
/// the rest reject with their handles released, and an overflow ends the session as the
/// mailbox loop's would.
async fn drain(core: Rc<Core>, thread: ThreadId, generation: u64, ops: Vec<mailbox::Op>) {
    let deps = core.actor_deps.borrow().clone();
    let mut queue = ops.into_iter();
    while let Some(op) = queue.next() {
        match op {
            mailbox::Op::Batch(mut batch) => {
                let frames = batch.frames.len();
                let bytes = batch.bytes;
                let handles = mailbox::js_handles(&batch.frames);
                let ack = std::mem::take(&mut batch.ack);
                let outcome = retry(&deps, || {
                    fold::fold_batch_for(&core, &thread, generation, &mut batch)
                })
                .await;
                match outcome {
                    Ok(()) => {
                        let _ = (frames, bytes);
                        mailbox::settle_drained(&core, ack, true);
                    }
                    Err(error) => {
                        mailbox::release_js_handles(&core, &handles);
                        mailbox::settle_drained(&core, ack, false);
                        failure::fail(&core, &thread, error);
                        reject_rest(&core, &thread, &mut queue);
                        return;
                    }
                }
            }
            mailbox::Op::Run(mut run) => {
                let ack = run.ack.take();
                let outcome = retry(&deps, || (run.run)(&core)).await;
                match outcome {
                    Ok(()) => {
                        if let Some(ack) = ack {
                            mailbox::settle_drained(&core, ack, true);
                        }
                    }
                    Err(error) => {
                        if let Some(ack) = ack {
                            mailbox::settle_drained(&core, ack, false);
                        }
                        failure::fail(&core, &thread, error);
                        reject_rest(&core, &thread, &mut queue);
                        return;
                    }
                }
            }
            mailbox::Op::Settle(ack) => mailbox::settle_drained(&core, ack, false),
            mailbox::Op::Overflow => {
                if let Err(error) = failure::overflow(&core, &thread) {
                    failure::fail(&core, &thread, error);
                    reject_rest(&core, &thread, &mut queue);
                    return;
                }
            }
            mailbox::Op::Staged(_) => {}
        }
    }
}

/// Rejects and releases everything an eviction will not run.
fn reject_rest(core: &Rc<Core>, _thread: &ThreadId, queue: &mut impl Iterator<Item = mailbox::Op>) {
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
            mailbox::Op::Settle(ack) => {
                mailbox::settle_drained(core, ack, false);
            }
            _ => {}
        }
    }
}

/// Runs one op, retrying a busy store as the TypeScript's `runWhenWritable` does.
async fn retry(
    deps: &Rc<deps::ActorDeps>,
    mut run: impl FnMut() -> Result<(), crate::EngineError>,
) -> Result<(), crate::EngineError> {
    loop {
        match run() {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !deps.live.is_store_retry(&error) {
                    return Err(error);
                }
                deps.live.writable().await;
            }
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
