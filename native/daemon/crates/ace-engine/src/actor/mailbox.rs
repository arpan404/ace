// SPDX-License-Identifier: Apache-2.0
//! The per-thread mailbox (`actor.ts:191`–`:266`, `:589`–`:608`): one ordered queue of sealed
//! batches, ticks and engine operations, run one per poll by the actor's own task.

use crate::actor::deps::BatchAck;
use crate::actor::state::{Actor, FrameRef, Pending};
use crate::actor::{flow, fold, intake, timer};
use crate::executor::{Deferred, Lane};
use crate::futures::channel::oneshot;
use crate::{Core, EngineError, ThreadId};
use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::{Rc, Weak};
use std::task::Poll;

/// A run an operation performs; `FnMut` because a busy store retries the same run.
pub type RunFn = Box<dyn FnMut(&Rc<Core>) -> Result<(), EngineError>>;

/// What a sealed batch remembers across a retry: translation runs once (translators keep state),
/// and a retried batch never streams its facts a second time.
#[derive(Default)]
pub struct BatchMemory {
    pub translated: Option<fold::Translation>,
    pub streamed: Option<bool>,
    pub status_before: Option<ace_json::Value>,
    pub journal_written: bool,
}

/// One sealed frame batch.
pub struct BatchOp {
    pub frames: Vec<Pending>,
    pub bytes: usize,
    pub ack: BatchAck,
    pub admitted: bool,
    pub memory: BatchMemory,
}

/// One generic operation (`enqueue`), wrapped in `store.atomic` as `accept` wraps it.
pub struct RunOp {
    pub run: RunFn,
    pub bytes: usize,
    pub frames: usize,
    pub ack: Option<BatchAck>,
}

/// One mailbox entry.
pub enum Op {
    Batch(Box<BatchOp>),
    Run(Box<RunOp>),
    /// A refused batch's settle-only marker: it rejects after the ops before it.
    Settle(BatchAck),
    /// The overflow op: end the session visibly, then clear the flag.
    Overflow,
    /// A slot waiting for its transaction's commit.
    Staged(u64),
}

/// What a staged slot became.
pub enum Staged {
    Pending,
    Ready(Box<RunOp>),
    Discarded,
}

/// What the mailbox task found at the front.
pub enum Next {
    Run(Op),
    /// A staged slot is still waiting for its transaction.
    Wait,
    /// Nothing queued: park on the timers.
    Park,
    /// The actor is gone.
    Exit,
}

fn limits(core: &Core) -> crate::limits::EngineLimits {
    core.with_state(|state| state.limits).unwrap_or_default()
}

/// `acceptOperation(run, bytes, frames)` (`actor.ts:198`): the capacity check, then the queue.
fn admit(core: &Core, thread: &ThreadId, bytes: usize, frames: usize) -> Option<bool> {
    let limits = limits(core);
    core.with_state(|state| {
        let actor = state.actors.by_thread.get(thread)?;
        if actor.stopped || actor.overflowed {
            return Some(false);
        }
        Some(true)
    })
    .ok()
    .flatten()
    .filter(|accepted| *accepted)?;

    let over = core
        .with_state(|state| {
            let actor = state.actors.by_thread.get(thread)?;
            Some(
                actor.queued + frames > limits.max_queued_frames as usize
                    || actor.queued_bytes + bytes > limits.max_queued_bytes as usize,
            )
        })
        .ok()
        .flatten()
        .unwrap_or(true);
    if over {
        core.with_state(|state| {
            if let Some(actor) = state.actors.by_thread.get_mut(thread) {
                actor.overflowed = true;
                // Preserve the accepted prefix, then fail explicitly instead of dropping facts.
                actor.mailbox.push_back(Op::Overflow);
            }
        })
        .ok();
        return Some(false);
    }
    core.with_state(|state| {
        let limits = state.limits;
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.queued += frames;
            actor.queued_bytes += bytes;
            flow::update_pressure(actor, &limits);
        }
    })
    .ok();
    Some(true)
}

/// `enqueue(run)` (`actor.ts:191`): seal first, then admit the wrapped run.
pub fn enqueue(core: &Rc<Core>, thread: &ThreadId, run: RunFn) {
    intake::seal(core, thread);
    if core.store.is_open() {
        stage(core, thread, run);
        return;
    }
    admit_run(core, thread, run);
}

/// `accept` outside a transaction: the capacity check, then the queue.
fn admit_run(core: &Rc<Core>, thread: &ThreadId, run: RunFn) {
    let Some(true) = admit(core, thread, 0, 1) else {
        return;
    };
    core.with_state(|state| {
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.mailbox.push_back(Op::Run(Box::new(RunOp {
                run,
                bytes: 0,
                frames: 1,
                ack: None,
            })));
        }
    })
    .ok();
    core.record_wake(thread);
}

/// A run made inside an open transaction: a staged slot keeps its place, counts nothing, and is
/// admitted only once committed (step 7).
fn stage(core: &Rc<Core>, thread: &ThreadId, run: RunFn) {
    let slot = core
        .with_state(|state| {
            let next = state.actors.next_slot;
            state.actors.next_slot += 1;
            let shared = Rc::new(RefCell::new(Staged::Pending));
            if let Some(actor) = state.actors.by_thread.get_mut(thread) {
                actor.staged.insert(next, Rc::clone(&shared));
                actor.mailbox.push_back(Op::Staged(next));
            }
            next
        })
        .ok();
    let Some(slot) = slot else {
        return;
    };
    let shared = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .and_then(|actor| actor.staged.get(&slot).cloned())
        })
        .ok()
        .flatten();
    let Some(shared) = shared else {
        return;
    };
    let guard = StagedAdmit {
        owner: Rc::downgrade(core),
        thread: thread.clone(),
        slot,
        shared,
        run: Some(run),
        admitted: false,
    };
    let future = Box::pin(async move {
        let mut guard = guard;
        guard.admitted = true;
        if let Some(core) = guard.owner.upgrade() {
            admit_staged(&core, &guard.thread, guard.slot, guard.run.take());
        }
        guard.run = None;
    });
    core.defer(Deferred::Spawn(Lane::Work, future));
    core.record_wake(thread);
}

/// Owns a staged slot's op: on rollback it is dropped, which discards the slot and wakes the
/// mailbox to skip it.
struct StagedAdmit {
    owner: Weak<Core>,
    thread: ThreadId,
    slot: u64,
    shared: Rc<RefCell<Staged>>,
    run: Option<RunFn>,
    admitted: bool,
}

impl Drop for StagedAdmit {
    fn drop(&mut self) {
        if self.admitted {
            return;
        }
        if let Some(core) = self.owner.upgrade() {
            *self.shared.borrow_mut() = Staged::Discarded;
            core.record_wake(&self.thread);
        }
    }
}

/// On commit, the staged slot is admitted exactly where TypeScript's `accept` would run it: the
/// capacity check against the counts as they are now.
fn admit_staged(core: &Rc<Core>, thread: &ThreadId, slot: u64, run: Option<RunFn>) {
    let Some(run) = run else {
        return;
    };
    let Some(true) = admit(core, thread, 0, 1) else {
        discard_staged(core, thread, slot);
        return;
    };
    let shared = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .and_then(|actor| actor.staged.get(&slot).cloned())
        })
        .ok()
        .flatten();
    if let Some(shared) = shared {
        *shared.borrow_mut() = Staged::Ready(Box::new(RunOp {
            run,
            bytes: 0,
            frames: 1,
            ack: None,
        }));
    }
    core.record_wake(thread);
}

/// Drops a slot that was not admitted, and wakes the mailbox to skip it.
fn discard_staged(core: &Core, thread: &ThreadId, slot: u64) {
    let shared = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .and_then(|actor| actor.staged.get(&slot).cloned())
        })
        .ok()
        .flatten();
    if let Some(shared) = shared {
        *shared.borrow_mut() = Staged::Discarded;
    }
    core.record_wake(thread);
}

/// Takes the front entry, resolving staged slots.
pub fn take_next(core: &Core, thread: &ThreadId) -> Next {
    loop {
        let entry = core.with_state(|state| {
            let actor = state.actors.by_thread.get_mut(thread)?;
            let Some(front) = actor.mailbox.front() else {
                return Some(None);
            };
            match front {
                Op::Staged(slot) => Some(Some((true, *slot))),
                _ => Some(Some((false, 0))),
            }
        });
        match entry {
            Ok(None) | Err(_) => return Next::Exit,
            // The mailbox is empty.
            Ok(Some(Some((_, 0)))) if false => return Next::Park,
            Ok(Some(front)) => {
                let Some((staged, slot)) = front else {
                    return Next::Park;
                };
                if !staged {
                    let op = core.with_state(|state| {
                        state
                            .actors
                            .by_thread
                            .get_mut(thread)
                            .and_then(|actor| actor.mailbox.pop_front())
                    });
                    return match op {
                        Ok(Some(op)) => Next::Run(op),
                        _ => Next::Exit,
                    };
                }
                let ready = core.with_state(|state| {
                    let actor = state.actors.by_thread.get_mut(thread)?;
                    let shared = actor.staged.get(&slot)?.clone();
                    let mut state_borrow = shared.borrow_mut();
                    match &mut *state_borrow {
                        Staged::Ready(_) => {
                            let Staged::Ready(run) =
                                std::mem::replace(&mut *state_borrow, Staged::Discarded)
                            else {
                                unreachable!()
                            };
                            actor.staged.shift_remove(&slot);
                            actor.mailbox.pop_front();
                            Some(Next::Run(Op::Run(run)))
                        }
                        Staged::Discarded => {
                            actor.staged.shift_remove(&slot);
                            actor.mailbox.pop_front();
                            Some(Next::Park)
                        }
                        Staged::Pending => Some(Next::Wait),
                    }
                });
                match ready {
                    Ok(Some(Next::Park)) => continue,
                    Ok(Some(next)) => return next,
                    _ => return Next::Exit,
                }
            }
        }
    }
}

/// `runWhenWritable` (`actor.ts:254`): the store's gate, re-checked in the turn that runs the op.
pub async fn run_when_writable(
    core: &Rc<Core>,
    thread: &ThreadId,
    run: &mut RunFn,
) -> Result<(), EngineError> {
    loop {
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
    enqueue(
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
            if let Err(error) = fold::apply(core, thread, &facts) {
                crate::actor::failure::fail(core, thread, error);
            }
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
