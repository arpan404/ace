// SPDX-License-Identifier: Apache-2.0
//! The connection's one live buffer, reached from Rust (ADR 0223 §5). The engine appends its
//! events to the same buffer the shell drives, with the buffer's flush run as a pump task, so it
//! is never inside another transaction. The shell implements this trait over its public methods;
//! the trait itself holds the actor's decisions and no I/O.

use crate::Core;
use crate::EngineError;
use crate::executor::{Deferred, Lane};
use crate::futures::future::LocalBoxFuture;
use ace_json::Value;
use std::rc::Rc;

/// One buffered write's snapshot: the thread's header and records, written with the batch.
pub trait LiveSnapshot {
    /// Inside the flush's transaction, before it commits. A failure rolls the batch back and
    /// lets the store retry it.
    fn persist(&self) -> Result<(), EngineError>;
    /// After the outermost commit, before the buffer retires the batch.
    fn committed(&self);
}

/// The store's write gates and live buffer.
pub trait LiveStore {
    /// `Store.writableNow()`: the exact condition `writable()` returns on.
    fn writable_now(&self) -> bool;
    /// `Store.writable()`: resolves once writes may proceed.
    fn writable(&self) -> LocalBoxFuture<'static, ()>;
    /// `Store.isHistoryWriting()`.
    fn history_writing(&self) -> bool;
    /// `Store.liveWriteBlocked()`.
    fn live_write_blocked(&self) -> bool;
    /// `Store.prepareLiveWrite(bytes)`: the admission the mailbox retries.
    fn prepare_live_write(&self, bytes: f64) -> Result<(), EngineError>;
    /// Append the engine's events to the connection's one live buffer, in the order the engine
    /// produced them. The buffer is not the transaction stack, so no frame is needed.
    fn buffer_live_write(
        &self,
        thread: &str,
        events: &[Value],
        at: f64,
        snapshot: Rc<dyn LiveSnapshot>,
    ) -> Result<(), EngineError>;
    /// The shell's deadline and retry timer ask for one flush task (`flush_due`).
    fn run_scheduled(&self);
    /// `Store.flushLiveWrites()`: the store's own flush, run by the caller.
    fn flush_live_writes(&self);
    /// `isStoreRetry` (`store-busy.ts:27`).
    fn is_store_retry(&self, error: &EngineError) -> bool;
}

/// The shell's deadline and retry timer ask for one live-buffer flush. It runs as a pump task:
/// deferred now, spawned after the outermost commit, and coalesced while one is queued, so a
/// flush is never inside another transaction (ADR 0223 §5).
pub fn flush_due(core: &Rc<Core>, live: &Rc<dyn LiveStore>) {
    let Ok(first) = core.with_state(|state| {
        let first = !state.live_flush.get();
        state.live_flush.set(true);
        first
    }) else {
        return;
    };
    if !first {
        return;
    }
    let Ok(ticket) = core.with_state(|state| FlushTicket(Rc::clone(&state.live_flush))) else {
        return;
    };
    let live = Rc::clone(live);
    core.defer(Deferred::Spawn(
        Lane::Work,
        Box::pin(async move {
            // Released as the task starts, so a deadline that fires meanwhile queues the next.
            drop(ticket);
            live.run_scheduled();
        }),
    ));
}

/// Clears the queued flag whether the flush task runs or a rollback drops it.
struct FlushTicket(Rc<std::cell::Cell<bool>>);

impl Drop for FlushTicket {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

/// Before the store's live buffer is wired, every call names the item that lands it.
pub struct UnportedLive;

impl LiveStore for UnportedLive {
    fn writable_now(&self) -> bool {
        false
    }

    fn writable(&self) -> LocalBoxFuture<'static, ()> {
        Box::pin(async {})
    }

    fn history_writing(&self) -> bool {
        false
    }

    fn live_write_blocked(&self) -> bool {
        false
    }

    fn prepare_live_write(&self, _bytes: f64) -> Result<(), EngineError> {
        Err(EngineError::not_ported("the live write admission", "E5.3"))
    }

    fn buffer_live_write(
        &self,
        _thread: &str,
        _events: &[Value],
        _at: f64,
        _snapshot: Rc<dyn LiveSnapshot>,
    ) -> Result<(), EngineError> {
        Err(EngineError::not_ported("the live write buffer", "E5.3"))
    }

    fn run_scheduled(&self) {}

    fn flush_live_writes(&self) {}

    fn is_store_retry(&self, _error: &EngineError) -> bool {
        false
    }
}
