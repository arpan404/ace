// SPDX-License-Identifier: Apache-2.0
//! The actor's own task (`actor.ts:303`-`:443`): one op per poll, a yield between ops, and the
//! park on the actor's timers. A task only ever acts for the actor instance that spawned it.

use crate::actor::deps::BatchAck;
use crate::actor::{failure, fold, intake, mailbox};
use crate::executor::{Lane, TaskId};
use crate::{Core, EngineError, ThreadId};
use std::rc::Rc;

/// This thread's actor instance, when it is still the one a task belongs to.
pub(crate) fn instance_of(core: &Core, thread: &ThreadId) -> Option<u64> {
    core.with_state(|state| {
        state
            .actors
            .by_thread
            .get(thread)
            .map(|actor| actor.instance)
    })
    .ok()
    .flatten()
}

/// Whether `instance` is still this thread's actor: an evicted one is replaced by a new instance.
pub(crate) fn alive(core: &Core, thread: &ThreadId, instance: u64) -> bool {
    instance_of(core, thread).is_some_and(|current| current == instance)
}

/// Spawns an actor's mailbox task and records its id.
pub fn spawn_mailbox(core: &Rc<Core>, thread: &ThreadId) -> TaskId {
    let inner = Rc::clone(core);
    let id = thread.clone();
    let instance = instance_of(core, thread).unwrap_or(0);
    let (task_id, task) = core.executor.spawn_next(Lane::Work, async move {
        mailbox_loop(inner, id, instance).await
    });
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
async fn mailbox_loop(core: Rc<Core>, thread: ThreadId, instance: u64) {
    loop {
        // A replacement actor owns the mailbox now: this task's work belongs to the old one.
        // With no replacement the thread's waker is this task's to take away.
        if !alive(&core, &thread, instance) {
            if instance_of(&core, &thread).is_none() {
                core.unregister_waker(&thread);
            }
            return;
        }
        intake::catch_up(&core, &thread);
        match mailbox::take_next(&core, &thread) {
            crate::actor::mailbox::Next::Exit => {
                if alive(&core, &thread, instance) || instance_of(&core, &thread).is_none() {
                    core.unregister_waker(&thread);
                }
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
                let end_turn = run_op(&core, &thread, instance, op).await;
                // The op settled: the mailbox is idle again, and a flush waiting on it resumes.
                // An evicted actor's task never clears its replacement's state.
                core.with_state(|state| {
                    if let Some(actor) = state.actors.by_thread.get_mut(&thread)
                        && actor.instance == instance
                    {
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
async fn run_op(core: &Rc<Core>, thread: &ThreadId, instance: u64, op: mailbox::Op) -> bool {
    match op {
        mailbox::Op::Batch(mut batch) => {
            let frames = batch.frames.len();
            let bytes = batch.bytes;
            let handles = mailbox::js_handles(&batch.frames);
            let ack = std::mem::take(&mut batch.ack);
            let thread_copy = thread.clone();
            let mut run: mailbox::RunFn =
                Box::new(move |core: &Rc<Core>| fold::fold_batch(core, &thread_copy, &mut batch));
            run_and_settle(
                core,
                thread,
                instance,
                &mut run,
                frames,
                bytes,
                Some(ack),
                handles,
            )
            .await
        }
        mailbox::Op::Run(mut run_op) => {
            let mut call = run_op.run;
            let frames = run_op.frames;
            let bytes = run_op.bytes;
            let ack = run_op.ack.take();
            run_and_settle(
                core,
                thread,
                instance,
                &mut call,
                frames,
                bytes,
                ack,
                Vec::new(),
            )
            .await
        }
        mailbox::Op::Settle(ack) => mailbox::settle_rejected(core, ack),
        mailbox::Op::Overflow => {
            // The overflow behind the same writable gate as any op: a held store waits, as the
            // TypeScript's `runWhenWritable` does, instead of aborting the session mid-write.
            let op_thread = thread.clone();
            let mut run: mailbox::RunFn =
                Box::new(move |core: &Rc<Core>| failure::overflow(core, &op_thread));
            match mailbox::run_when_writable(core, thread, instance, &mut run).await {
                Ok(_) => {}
                Err(error) => failure::fail(core, thread, error),
            }
            false
        }
        mailbox::Op::Staged(_) => false,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_and_settle(
    core: &Rc<Core>,
    thread: &ThreadId,
    instance: u64,
    run: &mut mailbox::RunFn,
    frames: usize,
    bytes: usize,
    ack: Option<BatchAck>,
    handles: Vec<u32>,
) -> bool {
    // The pump never runs inside a transaction; the check confirms it.
    let outcome = if core.store.is_open() {
        Err(EngineError::NotOutermost)
    } else {
        mailbox::run_when_writable(core, thread, instance, run).await
    };
    let ran = match outcome {
        Ok(ran) => ran,
        Err(error) => {
            failure::fail(core, thread, error);
            false
        }
    };
    if !ran {
        // The batch never translated: the shell's frame objects go with its acknowledgement.
        mailbox::release_js_handles(core, &handles);
    }
    if !alive(core, thread, instance) {
        // The actor was evicted while this op waited: its acknowledgement rejects, and the
        // replacement's backlog is untouched.
        return match ack {
            Some(ack) => mailbox::settle_orphaned(core, ack),
            None => false,
        };
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
pub(crate) async fn yield_once() {
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
