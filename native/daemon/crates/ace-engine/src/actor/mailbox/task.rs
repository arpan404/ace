// SPDX-License-Identifier: Apache-2.0
//! The mailbox task's own work: the writable gate, one op's run and settle, the park and the
//! flush (`actor.ts:254`-`:266`, `:431`-`:442`, `:589`-`:608`).

use super::RunFn;
use super::queue::admit_instance_run;
use crate::actor::deps::BatchAck;
use crate::actor::state::{ActorInstance, ActorRef, FrameRef, current, instance_deps};
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
    actor: &ActorRef,
    run: &mut RunFn,
) -> Result<bool, EngineError> {
    loop {
        if actor.borrow().poisoned {
            return Ok(false);
        }
        let live = instance_deps(core, actor).live.clone();
        if live.writable_now() {
            match run(core, actor) {
                Ok(()) => return Ok(true),
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
    let Some(actor) = current(core, thread) else {
        return settle_ack(&core.actor_deps.borrow().clone(), ack, true);
    };
    settle_instance(core, &actor, frames, bytes, ack)
}

pub(crate) fn settle_instance(
    core: &Core,
    actor: &ActorRef,
    frames: usize,
    bytes: usize,
    ack: BatchAck,
) -> bool {
    let limits = super::limits(core);
    let reject = {
        let mut actor = actor.borrow_mut();
        actor.queued = actor.queued.saturating_sub(frames);
        actor.queued_bytes = actor.queued_bytes.saturating_sub(bytes);
        flow::update_pressure(&mut actor, &limits);
        actor.poisoned || actor.overflowed
    };
    settle_ack(&instance_deps(core, actor), ack, reject)
}

fn settle_ack(deps: &crate::actor::ActorDeps, mut ack: BatchAck, reject: bool) -> bool {
    let js = ack.js;
    if reject {
        ack.reject("Provider frame failed to commit");
    } else {
        ack.resolve();
    }
    if let Some(call) = js {
        deps.acks.settle(
            call,
            reject.then(|| "Provider frame failed to commit".to_string()),
        );
    }
    js.is_some()
}

/// The JavaScript frame objects a batch holds, by handle.
pub fn js_handles(frames: &[crate::actor::state::Pending]) -> Vec<u32> {
    frames
        .iter()
        .filter_map(|pending| match &pending.frame {
            crate::actor::state::FrameRef::Js { handle, .. } => Some(*handle),
            crate::actor::state::FrameRef::Native(_) => None,
        })
        .collect()
}

/// Releases the shell's frame objects for a batch that will never translate.
pub fn release_js_handles(core: &Core, actor: &ActorRef, handles: &[u32]) {
    if !handles.is_empty() {
        instance_deps(core, actor).acks.release(handles);
    }
}

/// A refused batch settles after the work ahead of it.
pub(crate) fn settle_rejected_instance(core: &Core, actor: &ActorRef, ack: BatchAck) -> bool {
    settle_ack(&instance_deps(core, actor), ack, true)
}

/// The mailbox task's own wait: the front entry, or a park on both timers.
pub async fn park(actor: &ActorRef) {
    let mut once = false;
    futures::future::poll_fn(|cx| {
        if once {
            actor.borrow_mut().waker = None;
            return Poll::Ready(());
        }
        once = true;
        {
            let mut actor = actor.borrow_mut();
            actor.waker = Some(cx.waker().clone());
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
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        }
    })
    .await
}

/// `backlog()` (`actor.ts:583`).
pub fn backlog(core: &Core, thread: &ThreadId) -> (usize, usize) {
    core.with_state(|state| {
        state
            .actors
            .get(thread)
            .map(|actor| actor.backlog())
            .unwrap_or((0, 0))
    })
    .unwrap_or((0, 0))
}

/// `flush()` (`actor.ts:589`): seal, wait for writability, then until the mailbox is idle.
pub async fn flush(core: Rc<Core>, thread: ThreadId, exclude: Option<crate::executor::TaskId>) {
    if let Some(actor) = current(&core, &thread) {
        flush_instance(&core, &actor, exclude).await;
    } else {
        let live = core.actor_deps.borrow().live.clone();
        live.writable().await;
        live.flush_live_writes();
    }
}

pub(crate) async fn flush_instance(
    core: &Rc<Core>,
    actor: &ActorRef,
    exclude: Option<crate::executor::TaskId>,
) {
    intake::catch_up_instance(core, actor);
    intake::seal_instance(core, actor);
    let live = instance_deps(core, actor).live.clone();
    live.writable().await;
    loop {
        let receiver = {
            let mut state = actor.borrow_mut();
            let own = state.mailbox_task.is_some() && state.mailbox_task == exclude;
            if own || (!state.running && state.mailbox.is_empty()) {
                break;
            }
            let (sender, receiver) = oneshot::channel();
            state.flush_waiters.push(sender);
            receiver
        };
        core.record_actor_wake(actor);
        let _ = receiver.await;
    }
    live.flush_live_writes();
}

/// The mailbox's idle step: resolve the flush waiters once nothing is left.
pub fn resolve_flush_waiters(actor: &mut ActorInstance) -> bool {
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
pub fn actor_quiescent(actor: &ActorInstance) -> bool {
    actor.pending.is_empty() && actor.mailbox.is_empty() && !actor.running
}

/// The tick a fired actor timer stands for (`actor.ts:564`).
pub fn fire_tick(core: &Rc<Core>, actor: &ActorRef) {
    admit_now(
        core,
        actor,
        Box::new(move |core, actor| {
            let id = actor.borrow().id.clone();
            let thread = &id;
            let now = core.ports.now();
            let deps = instance_deps(core, actor);
            let mut taken = actor.borrow_mut().translator.take();
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
            actor.borrow_mut().return_translator(taken);
            facts.push(ace_json::json!({"type": "tick"}));
            // A busy store retries the tick, as the TypeScript's `runWhenWritable` does; any
            // other failure reaches the mailbox's own failure path.
            fold::apply_instance(core, actor, &facts)?;
            let release = timer::release_at(&actor.borrow(), deps.idle_ms);
            if release.is_some_and(|release| now >= release) {
                actor.borrow_mut().idle_due = true;
                timer::disarm_instance(core, actor);
            }
            deps.links.wake(core, thread);
            Ok(())
        }),
    );
}

/// Work of the first kind: a zone that does not depend on an enclosing transaction (a timer's
/// tick) seals and admits at once, so a rollback cannot discard it.
fn admit_now(core: &Rc<Core>, actor: &ActorRef, run: RunFn) {
    intake::seal_instance(core, actor);
    admit_instance_run(core, actor, run);
}
