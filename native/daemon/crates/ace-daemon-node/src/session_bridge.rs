// SPDX-License-Identifier: Apache-2.0
//! A native session's port to JavaScript (E3.0c): the session's ordered event
//! queue, posted to one threadsafe function as at most one call at a time, and
//! the read gate's controls. Every rule lives in `ace_adapter_api::bridge`; this
//! module only owns the addon's posting task and translates calls.

// napi-derive registers exports only outside test builds, so in the lib test
// target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionEvent};
use napi::Status;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::supervisor::runtime;

/// The most frames one call carries, and the most frame text.
const BATCH_FRAMES: usize = 256;
const BATCH_BYTES: usize = 256 * 1024;

/// The facade's callback: one encoded batch of `[[kind, ...fields], ...]`.
type Events = ThreadsafeFunction<String, ()>;

/// What the posting task and the port's methods share.
struct PortState {
    queue: EventQueue,
    gate: ReadGate,
    /// The facade's callback, released once the batch holding `Drained` ran.
    events: Mutex<Option<Arc<Events>>>,
    /// The call in flight finished: the next batch may be posted.
    ack: tokio::sync::Notify,
    /// The single claim of ADR 0223 §4: at most one call is posted at a time.
    posted: AtomicBool,
    /// The session's intake can read again after a batch was taken.
    resume: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl PortState {
    fn events(&self) -> Option<Arc<Events>> {
        self.events
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(Arc::clone))
    }

    /// Drops the last reference to the function: node may exit.
    fn release(&self) {
        if let Ok(mut slot) = self.events.lock() {
            slot.take();
        }
    }
}

/// One native session's port to JavaScript. The session bindings make one,
/// never JavaScript; its methods are the facade's flow control.
#[napi]
pub struct SessionPort {
    state: Arc<PortState>,
}

impl SessionPort {
    /// Starts posting `queue` to `events`, and gives the facade the `gate`'s
    /// controls. Called by a session binding while its core is being made.
    pub fn new(events: Events, queue: EventQueue, gate: ReadGate) -> napi::Result<Self> {
        let state = Arc::new(PortState {
            queue,
            gate,
            events: Mutex::new(Some(Arc::new(events))),
            ack: tokio::sync::Notify::new(),
            posted: AtomicBool::new(false),
            resume: Mutex::new(None),
        });
        runtime()?.spawn(post(Arc::clone(&state)));
        Ok(Self { state })
    }
}

#[napi]
impl SessionPort {
    /// The engine's `outputFlow.paused()`, mirrored onto the child's pumps.
    #[napi(catch_unwind)]
    pub fn set_paused(&self, paused: bool) {
        self.state.gate.set_paused(paused);
    }

    /// A frame's commit failed: stop intake, and never resume.
    #[napi(catch_unwind)]
    pub fn fail(&self) {
        self.state.gate.fail();
    }

    /// A close started: read on to EOF, still queueing everything read.
    #[napi(catch_unwind)]
    pub fn drain(&self) {
        self.state.gate.drain();
    }

    /// The session's queue can take more: re-open its intake if it is under
    /// the bound. Called by the posting task after every batch it takes.
    pub fn set_resume(&self, resume: Arc<dyn Fn() + Send + Sync>) {
        if let Ok(mut slot) = self.state.resume.lock() {
            *slot = Some(resume);
        }
    }
}

/// Posts the queue to JavaScript, one batch at a time, in queue order. The wake
/// is the queue's own (a publish wakes this task); the ack is the previous
/// call's return, so a batch is never posted before the one before it ran.
async fn post(state: Arc<PortState>) {
    loop {
        state.queue.wait().await;
        // One claim, taken before the batch is read and released after its call
        // returned: two calls are never in flight, so order is the queue's.
        if state.posted.swap(true, Ordering::SeqCst) {
            state.ack.notified().await;
            continue;
        }
        let batch = state.queue.take_batch(BATCH_FRAMES, BATCH_BYTES);
        if let Ok(resume) = state.resume.lock()
            && let Some(resume) = resume.as_ref()
        {
            resume();
        }
        if batch.is_empty() {
            state.posted.store(false, Ordering::SeqCst);
            continue;
        }
        let last = batch
            .iter()
            .any(|event| matches!(event, SessionEvent::Drained));
        let encoded = match ace_json::ser::to_string(&batch) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("native session batch failed to encode: {error}");
                state.posted.store(false, Ordering::SeqCst);
                continue;
            }
        };
        let Some(events) = state.events() else {
            break;
        };
        let finished = Arc::clone(&state);
        let status = events.call_with_return_value(
            Ok(encoded),
            ThreadsafeFunctionCallMode::NonBlocking,
            move |_result, _env| {
                if last {
                    // The batch holding Drained ran: nothing more will be posted.
                    finished.release();
                }
                finished.posted.store(false, Ordering::SeqCst);
                if !last {
                    finished.ack.notify_one();
                }
                Ok(())
            },
        );
        if status != Status::Ok {
            // The environment is closing: nothing can be delivered any more.
            break;
        }
        if last {
            break;
        }
        state.ack.notified().await;
    }
}
