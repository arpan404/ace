// SPDX-License-Identifier: Apache-2.0
//! Frame intake and batching (`actor.ts:303`-`:352`). A batch's boundary is the firing instant:
//! every synchronous entry first runs `catch_up`, so whichever timer fired seals before the next
//! frame lands.

use crate::actor::deps::BatchAck;
use crate::actor::flow;
use crate::actor::mailbox::{self, BatchOp};
use crate::actor::state::{FrameRef, Pending};
use crate::frames::envelope::{Envelope, envelope_error};
use crate::futures::channel::oneshot;
use crate::ports::PortError;
use crate::{Core, EngineError, ThreadId};
use std::rc::Rc;

/// A frame as the caller hands it over.
pub struct FrameInput {
    pub frame: FrameRef,
    pub envelope: Envelope,
    pub channel_sdk: bool,
    pub measure: Measure,
    /// A native session's acknowledgement: its read gate fails when the batch rejects.
    pub native_ack: Option<oneshot::Sender<Result<(), String>>>,
}

/// How the caller measured the frame.
pub enum Measure {
    /// The admission certificate's bytes (plus the bridge's 512).
    Certified { bytes: usize },
    /// `Buffer.byteLength(boundedJson(frame, max))`, or the call's error message.
    Bounded(Result<usize, String>),
}

/// `frame()`'s answer, before the shell attaches its promise.
pub enum Ack {
    Done,
    Rejected(String),
    /// The frame joined the open batch; its JavaScript acknowledgement's call id, when it has one.
    Batch(Option<u64>),
    AfterFlush(oneshot::Receiver<()>),
}

/// Whether a timer's oneshot fired; the mailbox polled it, and the value is still there.
fn fired(timer: &mut crate::ports::Timer) -> bool {
    matches!(timer.fired.try_recv(), Ok(Some(())))
}

/// Decision 3, synchronous catch-up: a fired actor timer enqueues its tick (which seals first),
/// and a fired batch timer seals.
pub fn catch_up(core: &Rc<Core>, thread: &ThreadId) {
    let fired_now = core.with_state(|state| {
        let Some(actor) = state.actors.by_thread.get_mut(thread) else {
            return (false, false);
        };
        let tick = actor.timer.as_mut().is_some_and(|(timer, _)| fired(timer));
        let batch = actor.batch_timer.as_mut().is_some_and(fired);
        (tick, batch)
    });
    let Ok((tick, batch)) = fired_now else {
        return;
    };
    if tick {
        mailbox::fire_tick(core, thread);
    }
    if batch {
        seal(core, thread);
    }
}

/// `frame()`: the checks and the batch join, in `actor.ts:303`'s order.
pub fn frame(core: &Rc<Core>, thread: &ThreadId, generation: u64, input: FrameInput) -> Ack {
    catch_up(core, thread);
    let mut input = input;
    let mut native_ack = input.native_ack.take();
    let state = core.with_state(|state| {
        state.actors.by_thread.get(thread).map(|actor| {
            (
                actor.stopped,
                actor.generation,
                actor.poisoned,
                actor.overflowed,
            )
        })
    });
    let Ok(Some((stopped, current, poisoned, overflowed))) = state else {
        return Ack::Done;
    };
    if stopped || generation != current {
        return Ack::Done;
    }
    if poisoned {
        refuse(native_ack.take(), "Provider frame failed to commit");
        return Ack::Rejected("Provider frame failed to commit".to_string());
    }
    if let Some(field) = envelope_error(&input.envelope) {
        let message = format!("Provider frame envelope is malformed: {field}");
        refuse(native_ack.take(), "Provider frame failed to commit");
        enqueue_failure(core, thread, message);
        return Ack::AfterFlush(after_flush(core, thread));
    }
    let certified = matches!(&input.measure, Measure::Certified { .. });
    if input.channel_sdk && !certified {
        refuse(native_ack.take(), "Provider frame failed to commit");
        enqueue_failure(
            core,
            thread,
            "SDK frame lacks matching encoded admission certificate".to_string(),
        );
        return Ack::AfterFlush(after_flush(core, thread));
    }
    let limits = core.with_state(|state| state.limits).unwrap_or_default();
    let bytes = match input.measure {
        Measure::Certified { bytes } => bytes + 512,
        Measure::Bounded(Err(message)) => {
            refuse(native_ack.take(), "Provider frame failed to commit");
            enqueue_failure(core, thread, message);
            return Ack::AfterFlush(after_flush(core, thread));
        }
        Measure::Bounded(Ok(bytes)) => bytes,
    };
    if bytes as u64 > limits.max_frame_bytes {
        refuse(native_ack.take(), "Provider frame failed to commit");
        enqueue_failure(core, thread, "Provider frame capacity exceeded".to_string());
        return Ack::AfterFlush(after_flush(core, thread));
    }
    if overflowed {
        refuse(native_ack.take(), "Provider frame failed to commit");
        return Ack::Rejected("Provider mailbox capacity exceeded".to_string());
    }
    // One promise per batch: the binding allocates it when this frame opens a batch, never per
    // frame, and a joined frame carries none of its own.
    let opens_batch = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .is_some_and(|actor| actor.pending_ack.is_none())
        })
        .unwrap_or(false);
    let js_ack = if opens_batch {
        core.actor_deps.borrow().clone().acks.alloc()
    } else {
        None
    };
    let decision = core
        .with_state(|state| {
            let limits = state.limits;
            let actor = state.actors.by_thread.get_mut(thread)?;
            actor.pending.push(Pending {
                frame: input.frame,
                generation,
                bytes,
            });
            actor.pending_bytes += bytes;
            flow::update_pressure(actor, &limits);
            let ack = actor.pending_ack.get_or_insert_with(BatchAck::default);
            if let Some(sender) = native_ack {
                ack.native.push(sender);
            }
            let joined = if ack.js.is_none() {
                ack.js = js_ack;
                false
            } else {
                true
            };
            let batch_call = actor.pending_ack.as_ref().and_then(|ack| ack.js);
            Some((
                state.flush_depth > 0
                    || actor.queued + actor.pending.len() >= limits.max_queued_frames as usize
                    || actor.queued_bytes + actor.pending_bytes >= limits.max_queued_bytes as usize
                    || actor.pending.len() >= 256
                    || actor.pending_bytes >= 262_144,
                joined,
                batch_call,
            ))
        })
        .ok()
        .flatten();
    let (seal_now, joined, batch_call) = decision.unwrap_or((false, false, None));
    if joined {
        // A promise allocated for a frame that turned out to join an existing batch (a port the
        // allocation called re-entered and opened one) settles at once; the caller returns the
        // batch's.
        if let Some(call) = js_ack {
            core.actor_deps.borrow().clone().acks.settle(call, None);
        }
    }
    arm_batch_timer(core, thread);
    if seal_now {
        seal(core, thread);
    }
    Ack::Batch(batch_call)
}

/// A native session's acknowledgement for a frame that never became a batch: its gate fails.
fn refuse(ack: Option<oneshot::Sender<Result<(), String>>>, message: &str) {
    if let Some(sender) = ack {
        let _ = sender.send(Err(message.to_string()));
    }
}

/// A frame the actor must refuse visibly: the failing op, then the flush its promise waits on.
fn enqueue_failure(core: &Rc<Core>, thread: &ThreadId, message: String) {
    mailbox::enqueue(
        core,
        thread,
        Box::new(move |_core: &Rc<Core>| Err(EngineError::Port(PortError::Threw(message.clone())))),
    );
}

/// The receiver the shell's promise for an unaccepted frame waits on.
fn after_flush(core: &Rc<Core>, thread: &ThreadId) -> oneshot::Receiver<()> {
    let (sender, receiver) = oneshot::channel();
    core.with_state(|state| {
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.flush_waiters.push(sender);
        }
    })
    .ok();
    receiver
}

/// Arms the 1 ms batch timer when none is armed (`actor.ts:340`).
pub fn arm_batch_timer(core: &Rc<Core>, thread: &ThreadId) {
    let needs = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .is_some_and(|actor| actor.batch_timer.is_none())
        })
        .unwrap_or(false);
    if !needs {
        return;
    }
    let timer = core.ports.set_batch_timer(1.0);
    core.with_state(|state| {
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.batch_timer = Some(timer);
        }
    })
    .ok();
    core.record_wake(thread);
}

/// `sealFrames()`'s take: cancel the batch timer and move the pending frames into one op.
pub fn seal(core: &Rc<Core>, thread: &ThreadId) {
    let taken = core.with_state(|state| {
        let actor = state.actors.by_thread.get_mut(thread)?;
        let timer = actor.batch_timer.take();
        if actor.pending.is_empty() {
            return Some((None, None));
        }
        let frames = std::mem::take(&mut actor.pending);
        let bytes = actor.pending_bytes;
        actor.pending_bytes = 0;
        let ack = actor.pending_ack.take().unwrap_or_default();
        Some((timer, Some((frames, bytes, ack))))
    });
    let Ok(Some((timer, batch))) = taken else {
        return;
    };
    if let Some(timer) = timer {
        core.ports.cancel_timer(timer.key);
    }
    let Some((frames, bytes, ack)) = batch else {
        return;
    };
    let op = BatchOp {
        frames,
        bytes,
        ack,
        admitted: false,
        memory: Default::default(),
    };
    accept_batch(core, thread, op);
}

/// The batch's admission: a refused batch still settles its acknowledgement after the ops before
/// it (`actor.ts:430`).
fn accept_batch(core: &Rc<Core>, thread: &ThreadId, mut op: BatchOp) {
    let frames = op.frames.len();
    let refused = core
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get(thread)
                .is_none_or(|actor| actor.stopped || actor.overflowed)
        })
        .unwrap_or(true);
    if refused {
        push_settle(core, thread, op.ack);
        return;
    }
    let limits = core.with_state(|state| state.limits).unwrap_or_default();
    let over = core
        .with_state(|state| {
            let actor = state.actors.by_thread.get(thread)?;
            Some(
                actor.queued + frames > limits.max_queued_frames as usize
                    || actor.queued_bytes + op.bytes > limits.max_queued_bytes as usize,
            )
        })
        .ok()
        .flatten()
        .unwrap_or(true);
    if over {
        core.with_state(|state| {
            if let Some(actor) = state.actors.by_thread.get_mut(thread) {
                actor.overflowed = true;
                actor.mailbox.push_back(mailbox::Op::Overflow);
            }
        })
        .ok();
        push_settle(core, thread, op.ack);
        return;
    }
    op.admitted = true;
    core.with_state(|state| {
        let limits = state.limits;
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.queued += frames;
            actor.queued_bytes += op.bytes;
            flow::update_pressure(actor, &limits);
            actor.mailbox.push_back(mailbox::Op::Batch(Box::new(op)));
        }
    })
    .ok();
    core.record_wake(thread);
}

fn push_settle(core: &Rc<Core>, thread: &ThreadId, ack: BatchAck) {
    core.with_state(|state| {
        if let Some(actor) = state.actors.by_thread.get_mut(thread) {
            actor.mailbox.push_back(mailbox::Op::Settle(ack));
        }
    })
    .ok();
    core.record_wake(thread);
}
