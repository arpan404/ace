// SPDX-License-Identifier: Apache-2.0
//! The transaction stack's binding (docs/store/porting-guide.md, task 5.5). The state lives in
//! `ace_store::writer::transaction`; this file translates frame handles and the finished JSON.
//! Begin opens the frame and returns its handle; exactly one of succeed or fail finishes it.

use ace_store::Connection;
use ace_store::writer::transaction::{Frame, TransactionStack, finish_json};
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Arc;

use crate::fail;

/// The largest integer a JavaScript number holds exactly (`Number.isSafeInteger`).
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A non-negative JavaScript integer the stack accepts as a count or id.
fn count(value: f64, name: &str) -> napi::Result<u64> {
    if value.is_finite() && value.fract() == 0.0 && (0.0..=MAX_SAFE).contains(&value) {
        return Ok(value as u64);
    }
    Err(napi::Error::from_reason(format!(
        "transaction {name} must be a JavaScript integer"
    )))
}

fn index(value: f64, name: &str) -> napi::Result<usize> {
    let value = count(value, name)?;
    usize::try_from(value)
        .map_err(|_| napi::Error::from_reason(format!("transaction {name} is too large")))
}

/// The stack behind `ACE_STORE_WRITER=transactions`: one per connection handle.
#[napi]
pub struct NativeTransactionStack {
    connection: Arc<Connection>,
    stack: TransactionStack,
    frames: HashMap<u64, Frame>,
    next: u64,
}

impl NativeTransactionStack {
    pub fn new(connection: Arc<Connection>) -> NativeTransactionStack {
        NativeTransactionStack {
            connection,
            stack: TransactionStack::new(),
            frames: HashMap::new(),
            next: 0,
        }
    }

    fn take(&mut self, frame: f64) -> napi::Result<Frame> {
        let id = count(frame, "frame")?;
        self.frames
            .remove(&id)
            .ok_or_else(|| napi::Error::from_reason("transaction frame is not open"))
    }
}

#[napi]
impl NativeTransactionStack {
    /// `BEGIN IMMEDIATE` at depth 0, else `SAVEPOINT nested_<n>`; returns the frame handle.
    #[napi(catch_unwind)]
    pub fn begin(&mut self, own: Option<f64>) -> napi::Result<f64> {
        let own = match own {
            Some(id) => Some(count(id, "settlement")?),
            None => None,
        };
        let frame = self
            .stack
            .begin(self.connection.as_ref(), own)
            .map_err(fail)?;
        let id = self.next;
        self.next += 1;
        self.frames.insert(id, frame);
        Ok(id as f64)
    }

    /// The caller's event list grew to `len` (events written inside the open transaction).
    #[napi(catch_unwind)]
    pub fn note_events(&mut self, len: f64) -> napi::Result<()> {
        self.stack.note_events(index(len, "events")?);
        Ok(())
    }

    /// `run` returned: finish the frame and return the steps as JSON.
    #[napi(catch_unwind)]
    pub fn succeed(&mut self, frame: f64) -> napi::Result<String> {
        let frame = self.take(frame)?;
        let finish = self.stack.succeed(self.connection.as_ref(), frame);
        Ok(finish_json(&finish))
    }

    /// `run` threw: finish the frame and return the steps as JSON.
    #[napi(catch_unwind)]
    pub fn fail(&mut self, frame: f64) -> napi::Result<String> {
        let frame = self.take(frame)?;
        let finish = self.stack.fail(self.connection.as_ref(), frame);
        Ok(finish_json(&finish))
    }
}
