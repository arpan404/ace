// SPDX-License-Identifier: Apache-2.0
//! The mailbox task's own work: the writable gate, one op's run and settle, the park and the
//! flush (`actor.ts:254`-`:266`, `:431`-`:442`, `:589`-`:608`).

use super::RunFn;
use super::queue::admit_run;
use crate::actor::deps::BatchAck;
use crate::actor::state::{Actor, FrameRef};
use crate::actor::{flow, fold, intake, timer};
use crate::futures::channel::oneshot;
use crate::{Core, EngineError, ThreadId};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::Poll;

/// `runWhenWritable` (`actor.ts:254`): the store's gate, re-checked in the turn that runs the op.
pub async fn run_when_writable(
    core: &Rc<Core>,
    thread: &ThreadId,
    instance: u64,
    run: &mut RunFn,
) -> Result<(), EngineError> {
    loop {
        // A retry resumes after an eviction: the batch belongs to the actor that queued it.
        let alive = core
            .with_state(|state| {
                state
                    .actors
                    .by_thread
                    .get(thread)
                    .is_some_and(|actor| actor.instance == instance)
            })
            .unwrap_or(false);
        if !alive {
            return Ok(());
        }
        let poisoned = core
            .with_state(|state| {
                state
                    .actors
                    .by_thread
                    .get(thread)
                    .is_none_or(|actor| actor.poisoned)
            })
            .unwrap_or(true);
        if poisoned {
            return Ok(());
        }
        let live = core.actor_deps.borrow().live.clone();
        if live.writable_now() {
            match run(core) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if live.is_store_retry(&error) {
                        let timer = core.ports.set_timer(100.0);
                        let _ = timer.fired.await;
                        continue;
                    }
                    return Err(error);
                }
            }
        }
        live.writable().await;
    }
}

/// Settles every acknowledgement attached to an op after it ran (`actor.ts:431`).
pub fn settle(core: &Core, thread: &ThreadId, frames: usize, bytes: usize, ack: BatchAck) -> bool {
    let reject = core
        .with_state(|state| {
            let limits = state.limits;
            let Some(actor) = state.actors.by_thread.get_mut(thread) else {
                return true;
            };
            actor.queued = actor.queued.saturating_sub(frames);
            actor.queued_bytes = actor.queued_bytes.saturating_sub(bytes);
            flow::update_pressure(actor, &limits);
            actor.poisoned || actor.overflowed
        })
        .unwrap_or(true);
    let mut ack = ack;
    let js = ack.js;
    if reject {
        ack.reject("Provider frame failed to commit");
    } else {
        ack.resolve();
    }
    if let Some(call) = js {
        let deps = core.actor_deps.borrow().clone();
        deps.acks.settle(
            call,
            reject.then(|| "Provider frame failed to commit".to_string()),
        );
        return true;
    }
    false
}

/// An op whose actor was replaced under it: its acknowledgement rejects, and nothing is charged
/// to the actor that now owns the thread.
pub fn settle_orphaned(core: &Core, ack: BatchAck) -> bool {
    let mut ack = ack;
    let js = ack.js;
    ack.reject("Provider frame failed to commit");
    if let Some(call) = js {
        let deps = core.actor_deps.borrow().clone();
        deps.acks
            .settle(call, Some("Provider frame failed to commit".to_string()));
        return true;
    }
    false
}

/// A refused batch's settle-only marker: it rejects whatever the actor's state now.
pub fn settle_rejected(core: &Core, ack: BatchAck) -> bool {
    let mut ack = ack;
    let js = ack.js;
    ack.reject("Provider frame failed to commit");
    if let Some(call) = js {
        let deps = core.actor_deps.borrow().clone();
        deps.acks
            .settle(call, Some("Provider frame failed to commit".to_string()));
        return true;
    }
    false
}

/// The mailbox task's own wait: the front entry, or a park on both timers.
pub async fn park(core: &Rc<Core>, thread: &ThreadId) -> bool {
    let mut once = false;
    let ready = futures::future::poll_fn(|cx| {
        if once {
            return Poll::Ready(true);
        }
        once = true;
        core.register_waker(thread.clone(), cx.waker().clone());
        let polled = core.with_state(|state| {
            let Some(actor) = state.actors.by_thread.get_mut(thread) else {
                return Poll::Ready(false);
            };
            let mut fired = false;
            if let Some(timer) = actor.batch_timer.as_mut()
                && Pin::new(&mut timer.fired).poll(cx).is_ready()
            {
                fired = true;
            }
            if let Some((timer, _)) = actor.timer.as_mut()
                && Pin::new(&mut timer.fired).poll(cx).is_ready()
            {
                fired = true;
            }
            if fired {
                Poll::Ready(true)
            } else {
                Poll::Pending
            }
        });
        match polled {
            Ok(polled) => polled,
            Err(_) => Poll::Ready(false),
        }
    });
    ready.await
}

/// `backlog()` (`actor.ts:583`).
pub fn backlog(core: &Core, thread: &ThreadId) -> (usize, usize) {
    core.with_state(|state| {
        state
            .actors
            .by_thread
            .get(thread)
            .map(Actor::backlog)
            .unwrap_or((0, 0))
    })
    .unwrap_or((0, 0))
}

/// `flush()` (`actor.ts:589`): seal, wait for writability, then until the mailbox is idle.
pub async fn flush(core: Rc<Core>, thread: ThreadId, exclude: Option<crate::executor::TaskId>) {
    intake::catch_up(&core, &thread);
    intake::seal(&core, &thread);
    let live = core.actor_deps.borrow().live.clone();
    live.writable().await;
    loop {
        let waiter = core.with_state(|state| {
            let actor = state.actors.by_thread.get_mut(&thread)?;
            let own = actor.mailbox_task.is_some() && actor.mailbox_task == exclude;
            if own || (!actor.running && actor.mailbox.is_empty()) {
                return None;
            }
            let (sender, receiver) = oneshot::channel();
            actor.flush_waiters.push(sender);
            Some(receiver)
        });
        match waiter {
            // The mailbox is idle (or this flush was reached from its own op): done.
            Ok(None) | Err(_) => break,
            Ok(Some(receiver)) => {
                // The mailbox may already be parked; waking it makes it look again and resolve
                // the waiter this flush just added.
                core.record_wake(&thread);
                let _ = receiver.await;
            }
        }
    }
    live.flush_live_writes();
}

/// The mailbox's idle step: resolve the flush waiters once nothing is left.
pub fn resolve_flush_waiters(actor: &mut Actor) -> bool {
    if actor.running || !actor.mailbox.is_empty() {
        return false;
    }
    for waiter in actor.flush_waiters.drain(..) {
        let _ = waiter.send(());
    }
    true
}

/// A batch's frames on the `sdk` channel: the frame's own flag, or the handle's channel.
pub fn frame_is_sdk(frame: &FrameRef) -> bool {
    frame.is_sdk()
}

/// `quiescent`: no pending frames, no ops, no running op.
pub fn actor_quiescent(actor: &Actor) -> bool {
    actor.pending.is_empty() && actor.mailbox.is_empty() && !actor.running
}

/// The tick a fired actor timer stands for (`actor.ts:564`).
pub fn fire_tick(core: &Rc<Core>, thread: &ThreadId) {
    let op_thread = thread.clone();
    admit_now(
        core,
        thread,
        Box::new(move |core: &Rc<Core>| {
            let thread: &String = &op_thread;
            let now = core.ports.now();
            let deps = core.actor_deps.borrow().clone();
            let generation = core
                .with_state(|state| {
                    state
                        .actors
                        .by_thread
                        .get(thread)
                        .map(|actor| actor.generation)
                })
                .ok()
                .flatten()
                .unwrap_or(0);
            let mut taken = deps.take_translator(thread);
            let mut facts: Vec<ace_json::Value> = match &mut taken {
                Some((_, crate::actor::deps::ActorTranslator::Js(js))) => {
                    js.tick(now).unwrap_or_default()
                }
                Some((_, crate::actor::deps::ActorTranslator::Native(native))) => native
                    .tick(now as i64)
                    .into_iter()
                    .filter_map(crate::actor::native::fact_to_value)
                    .collect(),
                None => Vec::new(),
            };
            deps.return_translator(thread, generation, taken);
            facts.push(ace_json::json!({"type": "tick"}));
            // A busy store retries the tick, as the TypeScript's `runWhenWritable` does; any
            // other failure reaches the mailbox's own failure path.
            fold::apply(core, thread, &facts)?;
            let idle_ms = deps.idle_ms;
            let release = core
                .with_state(|state| {
                    state
                        .actors
                        .by_thread
                        .get(thread)
                        .and_then(|actor| timer::release_at(actor, idle_ms))
                })
                .ok()
                .flatten();
            if release.is_some_and(|release| now >= release) {
                core.with_state(|state| {
                    if let Some(actor) = state.actors.by_thread.get_mut(thread) {
                        actor.idle_due = true;
                    }
                })
                .ok();
                timer::disarm(core, thread);
            }
            deps.links.wake(core, thread);
            Ok(())
        }),
    );
}

/// Work of the first kind: a zone that does not depend on an enclosing transaction (a timer's
/// tick) seals and admits at once, so a rollback cannot discard it.
pub fn admit_now(core: &Rc<Core>, thread: &ThreadId, run: RunFn) {
    intake::seal(core, thread);
    admit_run(core, thread, run);
}
