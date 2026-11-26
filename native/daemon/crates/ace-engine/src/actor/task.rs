// SPDX-License-Identifier: Apache-2.0
//! The actor's own task (`actor.ts:303`-`:443`): one op per poll, a yield between ops, and the
//! park on the actor's timers. A task only ever acts for the actor instance that spawned it.

use crate::actor::deps::BatchAck;
use crate::actor::state::{ActorRef, current};
use crate::actor::{failure, fold, intake, mailbox};
use crate::executor::Lane;
use crate::{Core, EngineError, ThreadId};
use std::cell::RefCell;
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
    loop {
        intake::catch_up_instance(&core, &actor);
        let next = mailbox::queue::select_next(&mut actor.borrow_mut());
        match next {
            mailbox::Next::Exit => {
                let instance = {
                    let mut state = actor.borrow_mut();
                    state.waker = None;
                    state.mailbox_task = None;
                    mailbox::resolve_flush_waiters(&mut state);
                    state.instance
                };
                core.with_state(|state| state.actors.stopping.shift_remove(&instance))
                    .ok();
                return;
            }
            mailbox::Next::Wait => yield_once().await,
            mailbox::Next::Park => {
                mailbox::resolve_flush_waiters(&mut actor.borrow_mut());
                mailbox::park(&actor).await;
            }
            mailbox::Next::Run(op) => {
                let end_turn = run_op(&core, &actor, op).await;
                {
                    let mut state = actor.borrow_mut();
                    state.running = false;
                    state.in_flight = None;
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
async fn run_op(core: &Rc<Core>, actor: &ActorRef, op: mailbox::Op) -> bool {
    match op {
        mailbox::Op::Batch(mut batch) => {
            let frames = batch.frames.len();
            let bytes = batch.bytes;
            let handles = Rc::clone(&batch.handles);
            let ack = Rc::clone(&batch.ack);
            let mut run: mailbox::RunFn =
                Box::new(move |core, actor| fold::fold_batch(core, actor, &mut batch));
            run_and_settle(
                core,
                actor,
                &mut run,
                frames,
                bytes,
                Some(ack),
                Some(handles),
            )
            .await
        }
        mailbox::Op::Run(run_op) => {
            let mut call = run_op.run;
            let frames = run_op.frames;
            let bytes = run_op.bytes;
            let ack = run_op.ack.clone();
            run_and_settle(core, actor, &mut call, frames, bytes, ack, None).await
        }
        mailbox::Op::Settle(ack) => mailbox::settle_rejected_instance(core, actor, ack),
        mailbox::Op::Overflow => {
            // The overflow behind the same writable gate as any op: a held store waits, as the
            // TypeScript's `runWhenWritable` does, instead of aborting the session mid-write.
            let mut run: mailbox::RunFn = Box::new(failure::overflow);
            if let Err(error) = mailbox::run_when_writable(core, actor, &mut run).await {
                failure::fail_instance(core, actor, error);
            }
            false
        }
        mailbox::Op::Staged(_) => false,
    }
}

async fn run_and_settle(
    core: &Rc<Core>,
    actor: &ActorRef,
    run: &mut mailbox::RunFn,
    frames: usize,
    bytes: usize,
    ack: Option<mailbox::SharedAck>,
    handles: Option<Rc<RefCell<mailbox::Handles>>>,
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
            failure::fail_instance(core, actor, error);
            false
        }
    };
    if !ran && let Some(handles) = handles {
        // The batch never translated, or the failure came after translation consumed the live
        // handles: only what the batch still owns goes back to the shell.
        mailbox::release_owned(core, actor, &handles);
    }
    mailbox::task::settle_instance(
        core,
        actor,
        frames,
        bytes,
        ack.unwrap_or_else(|| Rc::new(RefCell::new(BatchAck::default()))),
    )
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
