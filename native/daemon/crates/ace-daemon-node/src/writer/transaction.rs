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
    /// The committed decisions only, before publication; returns the tokens still to release.
    fn release_runs(&self, tokens: Vec<u64>) -> Vec<u64> {
        let _ = tokens;
        Vec::new()
    }
    fn drop_tokens(&self, tokens: Vec<u64>);
}

/// A finish's tokens and the sink that receives them, taken out of the state so the caller
/// can drop its borrow before the sink runs.
type Dispatch = (Rc<dyn AfterCommitSink>, Vec<u64>);

/// The one transaction stack a connection owns.
#[derive(Default)]
pub struct StackState {
    stack: TransactionStack,
    /// Open frames by their handle.
    frames: HashMap<u64, Frame>,
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
        !self.frames.is_empty()
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
        Ok((id, open))
    }

    /// Records a finish's released and dropped tokens. Only an outermost commit releases, and
    /// its own frame id is the id `releaseWakes` is called with, so no alias is ever held.
    /// The dropped tokens and their sink come back to the caller, which drops its borrow
    /// before the sink runs: a sink that re-enters the stack must find it free.
    fn record(&mut self, frame: u64, finish: &Finish) -> Option<Dispatch> {
        if !finish.released.is_empty() {
            self.released
                .entry(frame)
                .or_default()
                .extend(finish.released.iter().copied());
        }
        if finish.dropped.is_empty() {
            return None;
        }
        self.sink
            .as_ref()
            .and_then(Weak::upgrade)
            .map(|sink| (sink, finish.dropped.clone()))
    }

    /// The tokens `frame` released and the sink to hand them to, taken out of the state so the
    /// caller can drop its borrow before the sink runs.
    fn take_release(&mut self, frame: f64) -> napi::Result<Option<Dispatch>> {
        let id = count(frame, "frame")?;
        let tokens = self.released.remove(&id).unwrap_or_default();
        if tokens.is_empty() {
            return Ok(None);
        }
        let sink = self.sink.as_ref().and_then(Weak::upgrade);
        Ok(sink.map(|sink| (sink, tokens)))
    }

    /// The bookkeeping a probe reads: open frames and released token lists.
    pub fn entry_counts(&self) -> (usize, usize) {
        (self.frames.len(), self.released.len())
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
        let (finish, dropped) = {
            let mut state = self.state.borrow_mut();
            let (id, frame) = state.take(frame)?;
            let finish = state.stack.succeed(self.connection.as_ref(), frame);
            let dropped = state.record(id, &finish);
            (finish, dropped)
        };
        if let Some((sink, tokens)) = dropped {
            sink.drop_tokens(tokens);
        }
        Ok(finish_json(&finish))
    }

    /// The frame's work failed: rolled back, its dropped tokens handed to the sink at once.
    #[napi(catch_unwind)]
    pub fn fail(&self, frame: f64) -> napi::Result<String> {
        let (finish, dropped) = {
            let mut state = self.state.borrow_mut();
            let (id, frame) = state.take(frame)?;
            let finish = state.stack.fail(self.connection.as_ref(), frame);
            let dropped = state.record(id, &finish);
            (finish, dropped)
        };
        if let Some((sink, tokens)) = dropped {
            sink.drop_tokens(tokens);
        }
        Ok(finish_json(&finish))
    }

    /// The committed decisions of a frame's outermost transaction, before its publication: a
    /// promoted actor is visible to every commit listener, as the TypeScript's eviction was.
    #[napi(catch_unwind)]
    pub fn release_runs(&self, frame: f64) -> napi::Result<()> {
        let id = count(frame, "frame")?;
        let taken = {
            let mut state = self.state.borrow_mut();
            let tokens = state.released.remove(&id).unwrap_or_default();
            let sink = state.sink.as_ref().and_then(Weak::upgrade);
            (sink, tokens)
        };
        let (sink, tokens) = taken;
        let Some(sink) = sink else {
            return Ok(());
        };
        let remaining = sink.release_runs(tokens);
        if !remaining.is_empty() {
            let mut state = self.state.borrow_mut();
            state.released.entry(id).or_default().extend(remaining);
        }
        Ok(())
    }

    /// The shell's committed path calls this after every publish and settlement of the frame's
    /// transaction; an unknown frame id is a no-op.
    #[napi(catch_unwind)]
    pub fn release_wakes(&self, frame: f64) {
        let taken = {
            let mut state = self.state.borrow_mut();
            state.take_release(frame)
        };
        let Ok(Some((sink, tokens))) = taken else {
            return;
        };
        sink.release(tokens);
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

#[cfg(test)]
mod tests {
    use super::*;
    use ace_store::{Connection, OpenOptions};

    /// A sink that touches the stack while it runs: the release must not hold the state's
    /// borrow, or this re-entry finds it taken.
    struct Reentrant {
        state: std::cell::RefCell<Option<Rc<RefCell<StackState>>>>,
        released: std::cell::RefCell<Vec<u64>>,
    }

    impl AfterCommitSink for Reentrant {
        fn release(&self, tokens: Vec<u64>) {
            let state = self.state.borrow().clone().expect("the sink is attached");
            assert!(!state.borrow().is_open(), "the stack is free");
            self.released.borrow_mut().extend(tokens);
        }

        fn drop_tokens(&self, _tokens: Vec<u64>) {}
    }

    fn stack() -> (Rc<RefCell<StackState>>, NativeTransactionStack) {
        let connection = Connection::open(
            ":memory:",
            OpenOptions {
                read_only: false,
                timeout_ms: 0,
            },
        )
        .expect("open in-memory store");
        let state = Rc::new(RefCell::new(StackState::default()));
        (
            Rc::clone(&state),
            NativeTransactionStack::new(connection, state),
        )
    }

    #[test]
    fn a_reentrant_sink_runs_after_the_release_borrow_is_dropped() {
        let (state, stack) = stack();
        state
            .borrow_mut()
            .released
            .entry(3)
            .or_default()
            .extend([7, 9]);
        let sink = Rc::new(Reentrant {
            state: std::cell::RefCell::new(Some(Rc::clone(&state))),
            released: std::cell::RefCell::new(Vec::new()),
        });
        attach_sink(&state, Rc::downgrade(&sink) as Weak<dyn AfterCommitSink>);
        stack.release_wakes(3.0);
        assert_eq!(*sink.released.borrow(), vec![7, 9]);
        assert!(state.borrow().released.is_empty(), "the list was taken");
    }
}
