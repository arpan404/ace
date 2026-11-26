// SPDX-License-Identifier: Apache-2.0
//! The store seam: one transaction at a time on the shared stack, with its after-commit tokens.

use crate::error::EngineError;
use crate::ports::Ports;
use crate::state::EngineStack;
use std::cell::Cell;
use std::panic::AssertUnwindSafe;
use std::rc::Rc;

/// One open transaction, as the engine's body sees it: a borrow of the connection, nothing
/// storable and nothing to hold across an await.
pub struct Tx<'a> {
    store: &'a EngineStore,
}

impl Tx<'_> {
    /// The batch joins the open context's event list exactly once.
    pub fn append_events(&self, json: &str) -> Result<(), EngineError> {
        self.store
            .ports
            .append_events(json)
            .map_err(EngineError::Port)
    }

    /// The connection this transaction runs on, for the engine's own statements (E5.3): the
    /// same connection the store's shell opened the frame on.
    pub fn conn(&self) -> &std::sync::Arc<ace_store::Connection> {
        &self.store.conn
    }
}

/// The store seam: the shell's transaction context, any transaction's one lifecycle.
pub struct EngineStore {
    pub(crate) ports: Rc<dyn Ports>,
    pub(crate) stack: Rc<dyn EngineStack>,
    pub(crate) outermost: Cell<bool>,
    /// The connection every transaction frame and the engine's own statements run on (E5.3).
    pub(crate) conn: std::sync::Arc<ace_store::Connection>,
}

impl EngineStore {
    /// Opens through the shell, runs the body synchronously, then closes. A port the body calls
    /// that runs `Store.atomic` nests as a savepoint in the same context; a Rust `atomic` inside
    /// a JavaScript one gets a nested frame in the JavaScript context.
    pub fn atomic<R>(
        &self,
        run: impl FnOnce(&Tx<'_>) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        let frame = self.ports.open_transaction().map_err(EngineError::Port)?;
        let previous = self.outermost.replace(frame.outermost);
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| run(&Tx { store: self })));
        self.outermost.set(previous);
        match result {
            Ok(Ok(value)) => {
                self.ports
                    .close_transaction(frame.token, None)
                    .map_err(EngineError::Port)?;
                Ok(value)
            }
            Ok(Err(error)) => {
                let _ = self
                    .ports
                    .close_transaction(frame.token, Some(error.to_string()));
                Err(error)
            }
            Err(panic) => {
                let _ = self
                    .ports
                    .close_transaction(frame.token, Some("panic".to_string()));
                std::panic::resume_unwind(panic)
            }
        }
    }

    /// `is_outermost`: whether the frame a Rust body is running in is the top-level one. A frame
    /// never resolves an acknowledgement on a savepoint's release (E5.2 asserts this).
    pub fn is_outermost(&self) -> bool {
        self.outermost.get()
    }

    /// Whether a top-level transaction is open on the shared stack.
    pub fn is_open(&self) -> bool {
        self.stack.is_open()
    }

    /// The only way a synchronous entry starts work: joins the after-commit list of the open
    /// transaction, or releases at once outside one.
    pub fn after_commit(&self, token: u64) -> bool {
        self.stack.after_commit(token)
    }

    pub(crate) fn detach(&self) -> Vec<u64> {
        self.stack.detach()
    }

    /// The connection the shell's transaction frames run on (E5.3).
    pub fn conn(&self) -> &std::sync::Arc<ace_store::Connection> {
        &self.conn
    }

    /// `clock.now()`: the engine's clock, for a synchronous entry that needs a time.
    pub fn now(&self) -> f64 {
        self.ports.now()
    }

    /// `store.headSeq()`: the sequence the store has written so far.
    pub fn head_seq(&self) -> Result<f64, EngineError> {
        self.ports.head_seq().map_err(EngineError::Port)
    }

    /// `store.hasLiveWrite(id)`: a buffered live write is pending for the thread.
    pub fn has_live_write(&self, id: &str) -> Result<bool, EngineError> {
        self.ports.has_live_write(id).map_err(EngineError::Port)
    }

    /// `store.rollbackGeneration()`: a number, bumped on every rollback.
    pub fn rollback_generation(&self) -> Result<f64, EngineError> {
        self.ports.rollback_generation().map_err(EngineError::Port)
    }

    /// `options.ids` / the Rust id service: one ace id of `kind`.
    pub fn next_id(&self, kind: &str) -> String {
        self.ports.next_id(kind)
    }

    /// `store.getThread(id)`: the thread row as JSON, or none (`provider-facts.ts:59`).
    pub fn get_thread(&self, id: &str) -> Result<Option<String>, EngineError> {
        self.ports.get_thread(id).map_err(EngineError::Port)
    }

    /// `store.prepareLiveWrite(bytes)` (E5.2's buffer).
    pub fn prepare_live_write(&self, bytes: f64) -> Result<(), EngineError> {
        self.ports
            .prepare_live_write(bytes)
            .map_err(EngineError::Port)
    }

    /// `store.bufferLiveWrite(id, events, now, callbacks)` (E5.2's buffer).
    pub fn buffer_live_write(
        &self,
        id: &str,
        events_json: &str,
        at: f64,
        token: u64,
    ) -> Result<(), EngineError> {
        self.ports
            .buffer_live_write(id, events_json, at, token)
            .map_err(EngineError::Port)
    }

    /// `store.capRaw(raw, threadId)` (E5.2).
    pub fn cap_raw(&self, thread: &str, raw: &str) -> Result<String, EngineError> {
        self.ports.cap_raw(thread, raw).map_err(EngineError::Port)
    }

    /// `store.appendEvents(threadId, payloads, at)`: the store's one event writer, inside the
    /// open transaction (`repository.ts:322`). Engine SQL never writes event rows (Decision 1).
    pub fn write_events(&self, id: &str, payloads_json: &str, at: f64) -> Result<(), EngineError> {
        self.ports
            .write_events(id, payloads_json, at)
            .map_err(EngineError::Port)
    }

    /// Writes event batches the shell held back, in call order, and clears them.
    ///
    /// The binding defers every write so its store hooks never re-enter a held `State` borrow. A
    /// receipt that creates a thread must have its parent `threads` row first: `thread_state`,
    /// sessions and the queue all reference it. `State::save` asks for this flush before its
    /// header insert, so the projection keeps the store's order without the re-entrant hook
    /// running under the receipt.
    pub fn flush_events(&self) -> Result<(), EngineError> {
        self.ports
            .flush_deferred_events()
            .map_err(EngineError::Port)
    }
}
