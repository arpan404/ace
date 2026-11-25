// SPDX-License-Identifier: Apache-2.0
//! The actor's own task (`actor.ts:303`-`:443`): one op per poll, a yield between ops, and the
//! park on the actor's timers. A task only ever acts for the actor instance that spawned it.

use crate::actor::deps::BatchAck;
use crate::actor::state::{ActorRef, current};
use crate::actor::{failure, fold, intake, mailbox};
use crate::executor::Lane;
use crate::{Core, EngineError, ThreadId};
use std::rc::Rc;

/// Spawns an actor's mailbox task and records its id.
pub fn spawn_mailbox(core: &Rc<Core>, thread: &ThreadId) {
    let Some(actor) = current(core, thread) else {
        return;
    };
    let inner = Rc::clone(core);
    let owned = Rc::clone(&actor);
    let (task_id, task) = core
        .executor
        .spawn_next(Lane::Work, async move { mailbox_loop(inner, owned).await });
    actor.borrow_mut().mailbox_task = Some(task_id);
    task.detach();
}

/// One actor's task: catch up, run one op, yield, or park on both timers.
async fn mailbox_loop(core: Rc<Core>, actor: ActorRef) {
    let thread = actor.borrow().id.clone();
    loop {
        if actor.borrow().detached {
            return;
        }
        intake::catch_up_instance(&core, &actor);
        let next = mailbox::queue::select_next(&mut actor.borrow_mut());
        match next {
            mailbox::Next::Exit => {
                core.unregister_waker(&thread);
                return;
            }
            mailbox::Next::Wait => yield_once().await,
            mailbox::Next::Park => {
                mailbox::resolve_flush_waiters(&mut actor.borrow_mut());
                mailbox::park(&core, &thread, &actor).await;
            }
            mailbox::Next::Run(op) => {
                let end_turn = run_op(&core, &thread, &actor, op).await;
                {
                    let mut state = actor.borrow_mut();
                    state.running = false;
                    mailbox::resolve_flush_waiters(&mut state);
                }
                if end_turn {
                    core.executor.end_turn();
                }
                yield_once().await;
            }
        }
    }
}

/// Runs one mailbox entry and settles its acknowledgement.
async fn run_op(core: &Rc<Core>, thread: &ThreadId, actor: &ActorRef, op: mailbox::Op) -> bool {
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
                Some(actor),
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
                Some(actor),
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
            match mailbox::run_when_writable(core, Some(actor), &mut run).await {
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
    actor: Option<&ActorRef>,
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
        mailbox::run_when_writable(core, actor, run).await
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
    let Some(actor) = actor else {
        // The actor is gone: the fold's outcome settles the acknowledgement, nothing is charged.
        if let Some(ack) = ack {
            mailbox::settle_drained(core, ack, ran);
        }
        return ran;
    };
    if actor.borrow().detached {
        // The actor was evicted while this op waited: its acknowledgement rejects, and the
        // replacement's backlog is untouched.
        return match ack {
            Some(ack) => mailbox::settle_orphaned(core, ack),
            None => false,
        };
    }
    match ack {
        Some(ack) => mailbox::task::settle_instance(core, actor, frames, bytes, ack),
        None => {
            mailbox::task::settle_instance(core, actor, frames, bytes, BatchAck::default());
            false
        }
    }
}

/// Runs one op an eviction took, on the pump, through the same wrapper the mailbox uses: the
/// fold runs with the actor's captured generation and its outcome settles the acknowledgement.
pub async fn drain_op(
    core: &Rc<Core>,
    thread: &ThreadId,
    generation: u64,
    op: mailbox::Op,
) -> bool {
    match op {
        mailbox::Op::Batch(mut batch) => {
            let frames = batch.frames.len();
            let bytes = batch.bytes;
            let handles = mailbox::js_handles(&batch.frames);
            let ack = std::mem::take(&mut batch.ack);
            let thread_copy = thread.clone();
            let mut run: mailbox::RunFn = Box::new(move |core: &Rc<Core>| {
                fold::fold_batch_for(core, &thread_copy, generation, &mut batch)
            });
            run_and_settle(
                core,
                thread,
                None,
                &mut run,
                frames,
                bytes,
                Some(ack),
                handles,
            )
            .await
        }
        mailbox::Op::Run(mut run) => {
            let frames = run.frames;
            let bytes = run.bytes;
            let ack = run.ack.take();
            let mut call = run.run;
            run_and_settle(
                core,
                thread,
                None,
                &mut call,
                frames,
                bytes,
                ack,
                Vec::new(),
            )
            .await
        }
        mailbox::Op::Settle(ack) => {
            mailbox::settle_drained(core, ack, false);
            false
        }
        mailbox::Op::Overflow => {
            let op_thread = thread.clone();
            let mut run: mailbox::RunFn =
                Box::new(move |core: &Rc<Core>| failure::overflow(core, &op_thread));
            matches!(
                mailbox::run_when_writable(core, None, &mut run).await,
                Ok(true)
            )
        }
        mailbox::Op::Staged(_) => true,
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
