// SPDX-License-Identifier: Apache-2.0
//! The engine's wiring into the executor and the transaction stack: the pump's notifier, the
//! shared stack handle, the after-commit sink and the turn's budget.

use ace_engine::EngineStack;
use ace_engine::executor::{Budget, Notified, Notifier};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::writer::transaction::{self, StackState};
use napi::Status;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;

/// The pump's threadsafe function: strong by default, dynamically ref'd and unref'd by the
/// facade's holder count, with an unbounded queue (at most one call is ever pending).
type PumpTsfn = ThreadsafeFunction<(), (), (), Status, false, false, 0>;

/// The one threadsafe function, shared with the notifier and released at close.
pub(crate) type PumpHandle = Arc<Mutex<Option<PumpTsfn>>>;

/// The notifier over the shell's pump entry: the second holder of the one threadsafe function.
pub(crate) struct Bell {
    pub(crate) pump: PumpHandle,
}

impl Notifier for Bell {
    fn notify(&self) -> Notified {
        let pump = match self.pump.lock() {
            Ok(pump) => pump,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(pump) = pump.as_ref() else {
            return Notified::Closing;
        };
        match pump.call((), ThreadsafeFunctionCallMode::NonBlocking) {
            Status::Ok => Notified::Posted,
            Status::Closing => Notified::Closing,
            _ => Notified::Posted,
        }
    }
}

/// The shared stack the TypeScript shell and the engine both open transactions on.
pub(crate) struct SharedStack {
    pub(crate) state: Rc<RefCell<StackState>>,
}

impl EngineStack for SharedStack {
    fn is_open(&self) -> bool {
        self.state.borrow().is_open()
    }

    fn after_commit(&self, token: u64) -> bool {
        self.state.borrow_mut().after_commit(token)
    }

    fn detach(&self) -> Vec<u64> {
        self.state.borrow_mut().detach()
    }
}

/// The engine's sink: released tokens wake the tasks the synchronous entry deferred.
pub(crate) struct Sink {
    pub(crate) after: Rc<ace_engine::executor::AfterCommit>,
}

impl transaction::AfterCommitSink for Sink {
    fn release(&self, tokens: Vec<u64>) {
        self.after.release(&tokens);
    }

    fn release_runs(&self, tokens: Vec<u64>) -> Vec<u64> {
        self.after.release_runs(&tokens)
    }

    fn drop_tokens(&self, tokens: Vec<u64>) {
        self.after.drop_tokens(&tokens);
    }
}

/// The turn's budget: 64 runnables or 4 ms, with intake stopping after 2 ms.
pub(crate) struct InstantBudget {
    start: Instant,
}

impl InstantBudget {
    pub(crate) fn new() -> InstantBudget {
        InstantBudget {
            start: Instant::now(),
        }
    }
}

impl Budget for InstantBudget {
    fn start(&mut self) {
        self.start = Instant::now();
    }

    fn spent(&self, started: usize) -> bool {
        started >= 64 || self.start.elapsed() >= Duration::from_millis(4)
    }

    fn intake_spent(&self) -> bool {
        self.start.elapsed() >= Duration::from_millis(2)
    }
}
