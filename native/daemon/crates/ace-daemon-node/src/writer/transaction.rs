// SPDX-License-Identifier: Apache-2.0
//! The transaction stack's binding (docs/store/porting-guide.md, task 5.5; E5.1's shared stack).
//! The state lives in `ace_store::writer::transaction`; this file translates frame handles, the
//! finished JSON, and the after-commit token lists keyed by their top-level frame.
//!
//! One `StackState` per connection, created on first use: the TypeScript shell and the Rust
//! engine reach the same stack, so a Rust `atomic` nests in a JavaScript one and the other way.
//! `succeed`/`fail` hand the dropped tokens to the sink at once and keep the released ones keyed
//! by the top-level frame; the shell calls `releaseWakes(frame)` after that transaction's own
//! publication. No borrow of the state is held while the sink runs.

use ace_store::Connection;
use ace_store::writer::transaction::{Finish, Frame, TransactionStack, finish_json};
use napi_derive::napi;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};
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

/// Where released after-commit tokens go: the engine's deferred work.
pub trait AfterCommitSink {
    fn release(&self, tokens: Vec<u64>);
    fn drop_tokens(&self, tokens: Vec<u64>);
}

/// The one transaction stack a connection owns.
#[derive(Default)]
pub struct StackState {
    stack: TransactionStack,
    /// Open frames by their handle.
    frames: HashMap<u64, Frame>,
    /// Each open frame's top-level frame id. Kept until the frame's wakes are released.
    tops: HashMap<u64, u64>,
    /// The open frames' top ids, innermost last (frames nest LIFO).
    open: Vec<u64>,
    next_frame: u64,
    /// Released tokens, keyed by the top-level frame they were released in.
    released: HashMap<u64, Vec<u64>>,
    sink: Option<Weak<dyn AfterCommitSink>>,
}

impl StackState {
    /// Whether a top-level transaction is open on this connection.
    pub fn is_open(&self) -> bool {
        self.stack.is_open()
    }

    /// Whether the stack is inside a transaction (top-level or savepoint).
    pub fn in_transaction(&self) -> bool {
        !self.open.is_empty()
    }

    /// Inside an open transaction: `token` joins the after-commit list. Outside: false.
    pub fn after_commit(&mut self, token: u64) -> bool {
        self.stack.after_commit(token)
    }

    fn take(&mut self, frame: f64) -> napi::Result<(u64, Frame)> {
        let id = count(frame, "frame")?;
        let open = self
            .frames
            .remove(&id)
            .ok_or_else(|| napi::Error::from_reason("transaction frame is not open"))?;
        let top = self.open.pop().unwrap_or(id);
        Ok((top, open))
    }

    /// Records a finish's released and dropped tokens.
    fn record(&mut self, top: u64, finish: &Finish) {
        if !finish.released.is_empty() {
            self.released
                .entry(top)
                .or_default()
                .extend(finish.released.iter().copied());
        }
        if !finish.dropped.is_empty()
            && let Some(sink) = self.sink.as_ref().and_then(Weak::upgrade)
        {
            sink.drop_tokens(finish.dropped.clone());
        }
    }

    fn release_frame(&mut self, frame: f64) -> napi::Result<()> {
        let id = count(frame, "frame")?;
        let top = self.tops.remove(&id).unwrap_or(id);
        let tokens = self
            .released
            .remove(&top)
            .or_else(|| self.released.remove(&id))
            .unwrap_or_default();
        if tokens.is_empty() {
            return Ok(());
        }
        if let Some(sink) = self.sink.as_ref().and_then(Weak::upgrade) {
            sink.release(tokens);
        }
        Ok(())
    }

    /// Detaches the sink at engine close, returning what no publication released yet.
    pub fn detach(&mut self) -> Vec<u64> {
        self.sink = None;
        let mut tokens = Vec::new();
        for (_, list) in self.released.drain() {
            tokens.extend(list);
        }
        tokens
    }
}

/// Attaches the engine's after-commit sink to a connection's stack.
pub fn attach_sink(state: &Rc<RefCell<StackState>>, sink: Weak<dyn AfterCommitSink>) {
    state.borrow_mut().sink = Some(sink);
}

/// The stack behind `ACE_STORE_WRITER=transactions`: one per connection handle.
#[napi]
pub struct NativeTransactionStack {
    connection: Arc<Connection>,
    state: Rc<RefCell<StackState>>,
}

impl NativeTransactionStack {
    pub fn new(
        connection: Arc<Connection>,
        state: Rc<RefCell<StackState>>,
    ) -> NativeTransactionStack {
        NativeTransactionStack { connection, state }
    }

    pub fn state(&self) -> &Rc<RefCell<StackState>> {
        &self.state
    }
}

#[napi]
impl NativeTransactionStack {
    /// `BEGIN IMMEDIATE` at depth 0, else `SAVEPOINT nested_<n>`; returns the frame handle.
    #[napi(catch_unwind)]
    pub fn begin(&self, own: Option<f64>) -> napi::Result<f64> {
        let own = match own {
            Some(id) => Some(count(id, "settlement")?),
            None => None,
        };
        let mut state = self.state.borrow_mut();
        let frame = state
            .stack
            .begin(self.connection.as_ref(), own)
            .map_err(fail)?;
        let id = state.next_frame;
        state.next_frame += 1;
        let top = state.open.last().copied().unwrap_or(id);
        state.open.push(top);
        state.tops.insert(id, top);
        state.frames.insert(id, frame);
        Ok(id as f64)
    }

    /// The caller's event list grew to `len` (events written inside the open transaction).
    #[napi(catch_unwind)]
    pub fn note_events(&self, len: f64) -> napi::Result<()> {
        let len = count(len, "length")? as usize;
        self.state.borrow_mut().stack.note_events(len);
        Ok(())
    }

    /// The frame's work returned: its finish as JSON, its tokens recorded.
    #[napi(catch_unwind)]
    pub fn succeed(&self, frame: f64) -> napi::Result<String> {
        let mut state = self.state.borrow_mut();
        let (top, frame) = state.take(frame)?;
        let finish = state.stack.succeed(self.connection.as_ref(), frame);
        state.record(top, &finish);
        Ok(finish_json(&finish))
    }

    /// The frame's work failed: rolled back, its dropped tokens handed to the sink at once.
    #[napi(catch_unwind)]
    pub fn fail(&self, frame: f64) -> napi::Result<String> {
        let mut state = self.state.borrow_mut();
        let (top, frame) = state.take(frame)?;
        let finish = state.stack.fail(self.connection.as_ref(), frame);
        state.record(top, &finish);
        Ok(finish_json(&finish))
    }

    /// The shell's committed path calls this after every publish and settlement of the frame's
    /// transaction; an unknown frame id is a no-op.
    #[napi(catch_unwind)]
    pub fn release_wakes(&self, frame: f64) {
        let mut state = self.state.borrow_mut();
        let _ = state.release_frame(frame);
    }

    /// Detaches the engine's sink; the tokens no publication released yet are returned.
    #[napi(catch_unwind)]
    pub fn detach_sink(&self) -> Vec<f64> {
        self.state
            .borrow_mut()
            .detach()
            .into_iter()
            .map(|token| token as f64)
            .collect()
    }
}
