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
}

/// The store seam: the shell's transaction context, any transaction's one lifecycle.
pub struct EngineStore {
    pub(crate) ports: Rc<dyn Ports>,
    pub(crate) stack: Rc<dyn EngineStack>,
    pub(crate) outermost: Cell<bool>,
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
}
