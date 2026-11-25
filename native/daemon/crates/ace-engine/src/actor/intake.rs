// SPDX-License-Identifier: Apache-2.0
//! Frame intake and batching (`actor.ts:303`-`:352`). A batch's boundary is the firing instant:
//! every synchronous entry first runs `catch_up`, so whichever timer fired seals before the next
//! frame lands.

use crate::actor::deps::BatchAck;
use crate::actor::flow;
use crate::actor::mailbox::{self, BatchOp};
use crate::actor::state::{ActorRef, FrameRef, Pending, current};
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
    if let Some(actor) = current(core, thread) {
        catch_up_instance(core, &actor);
    }
}

pub(crate) fn catch_up_instance(core: &Rc<Core>, actor: &ActorRef) {
    let (tick, batch) = {
        let mut actor = actor.borrow_mut();
        let tick = actor.timer.as_mut().is_some_and(|(timer, _)| fired(timer));
        let batch = actor.batch_timer.as_mut().is_some_and(fired);
        if !tick && !batch {
            return;
        }
        (tick, batch)
    };
    if tick {
        mailbox::fire_tick(core, actor);
    }
    if batch {
        seal_instance(core, actor);
    }
}

/// `frame()`: the checks and the batch join, in `actor.ts:303`'s order.
pub fn frame(core: &Rc<Core>, thread: &ThreadId, generation: u64, input: FrameInput) -> Ack {
    catch_up(core, thread);
    let mut input = input;
    let mut native_ack = input.native_ack.take();
    let state = core.with_state(|state| {
        state.actors.get(thread).map(|actor| {
            (
                actor.stopped,
                actor.generation,
                actor.poisoned,
                actor.overflowed,
            )
        })
    });
    let Ok(Some((stopped, current, poisoned, overflowed))) = state else {
        // A native session's acknowledgement resolves: the frame was dropped, not failed.
        if let Some(sender) = native_ack.take() {
            let _ = sender.send(Ok(()));
        }
        return Ack::Done;
    };
    if stopped || generation != current {
        if let Some(sender) = native_ack.take() {
            let _ = sender.send(Ok(()));
        }
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
            let mut actor = state.actors.get_mut(thread)?;
            actor.pending.push(Pending {
                frame: input.frame,
                generation,
                bytes,
            });
            actor.pending_bytes += bytes;
            flow::update_pressure(&mut actor, &limits);
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

/// Releases the shell's frame objects a batch will never translate.
pub(crate) fn release_handles(core: &Core, frames: &[Pending]) {
    let handles: Vec<u32> = frames
        .iter()
        .filter_map(|pending| match &pending.frame {
            FrameRef::Js { handle, .. } => Some(*handle),
            FrameRef::Native(_) => None,
        })
        .collect();
    if !handles.is_empty() {
        core.actor_deps.borrow().clone().acks.release(&handles);
    }
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
        if let Some(mut actor) = state.actors.get_mut(thread) {
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
                .get(thread)
                .is_some_and(|actor| actor.batch_timer.is_none())
        })
        .unwrap_or(false);
    if !needs {
        return;
    }
    let timer = core.ports.set_batch_timer(1.0);
    core.with_state(|state| {
        if let Some(mut actor) = state.actors.get_mut(thread) {
            actor.batch_timer = Some(timer);
        }
    })
    .ok();
    core.record_wake(thread);
}

/// `sealFrames()`'s take: cancel the batch timer and move the pending frames into one op.
pub fn seal(core: &Rc<Core>, thread: &ThreadId) {
    if let Some(actor) = current(core, thread) {
        seal_instance(core, &actor);
    }
}

pub(crate) fn seal_instance(core: &Rc<Core>, actor: &ActorRef) {
    let (timer, batch) = {
        let mut state = actor.borrow_mut();
        let timer = state.batch_timer.take();
        let batch = if state.pending.is_empty() {
            None
        } else {
            let frames = std::mem::take(&mut state.pending);
            let bytes = std::mem::take(&mut state.pending_bytes);
            let ack = state.pending_ack.take().unwrap_or_default();
            Some((frames, bytes, ack))
        };
        (timer, batch)
    };
    if let Some(timer) = timer {
        core.ports.cancel_timer(timer.key);
    }
    let Some((frames, bytes, ack)) = batch else {
        return;
    };
    accept_batch(
        core,
        actor,
        BatchOp {
            frames,
            bytes,
            ack,
            admitted: false,
            memory: Default::default(),
        },
    );
}

/// Refused batches settle their acknowledgements after the ops before them.
fn accept_batch(core: &Rc<Core>, actor: &ActorRef, mut op: BatchOp) {
    let frames = op.frames.len();
    let limits = mailbox::limits(core);
    let (thread, release) = {
        let mut state = actor.borrow_mut();
        let over = state.queued + frames > limits.max_queued_frames as usize
            || state.queued_bytes + op.bytes > limits.max_queued_bytes as usize;
        let release = if state.stopped || state.overflowed || over {
            if over && !state.stopped && !state.overflowed {
                state.overflowed = true;
                state.mailbox.push_back(mailbox::Op::Overflow);
            }
            state.mailbox.push_back(mailbox::Op::Settle(op.ack));
            Some(op.frames)
        } else {
            op.admitted = true;
            state.queued += frames;
            state.queued_bytes += op.bytes;
            flow::update_pressure(&mut state, &limits);
            state.mailbox.push_back(mailbox::Op::Batch(Box::new(op)));
            None
        };
        (state.id.clone(), release)
    };
    if let Some(frames) = release {
        release_handles(core, &frames);
    }
    core.record_wake(&thread);
}
