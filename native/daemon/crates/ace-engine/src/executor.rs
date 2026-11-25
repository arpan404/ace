// SPDX-License-Identifier: Apache-2.0
//! The engine's local executor (ADR 0223 section 4, E5.1).
//!
//! Tasks are `async-task` runnables spawned with `spawn_local`; the engine is single-threaded
//! and lives on the JS thread. One scheduling claim per engine (`claim`) holds `Idle`,
//! `Scheduled`, `Running` or `RunningDirty`, and only the party that moves it into `Scheduled`
//! posts a notification (the binding's threadsafe function), so at most one is ever pending.
//! `pump` is the only place a runnable runs: one turn moves at most 32 inbox items to their
//! tasks, then polls runnables for at most 64 polls or 4 ms, controls first but yielding one
//! work runnable after eight controls in a row.

mod after_commit;
mod claim;
mod turn;
mod wake;

pub use wake::{ExecutorStats, ExecutorWake, Pump};

pub use after_commit::{AfterCommit, Deferred, DeferredHost};

use async_task::{Builder, Runnable, Task};
use concurrent_queue::{ConcurrentQueue, PopError};
use futures::channel::oneshot;
use std::cell::{Cell, RefCell};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::time::Instant;

/// A task's identity, carried as the runnable's metadata and read by the pump.
pub type TaskId = u64;

/// The bit `TaskId`s of barriers carry: a barrier waits for other work instead of doing it (a
/// `flush`, `close`), so its queued runnable never makes the engine look busy.
const BARRIER_MARK: TaskId = 1 << 63;

/// Whether `id` names a barrier.
pub fn is_barrier(id: TaskId) -> bool {
    id & BARRIER_MARK != 0
}

/// Which ready queue a runnable waits in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// A Stop's interrupt, an interaction's resolution, a task stop: polled first.
    Control,
    /// Sends, steering and everything else.
    Work,
}

/// Posts one notification to the JS thread; implemented by the binding over the threadsafe
/// function. Called only by the party that moved the claim into `Scheduled`.
pub trait Notifier: Send + Sync {
    fn notify(&self) -> Notified;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notified {
    Posted,
    /// `napi_closing`: the environment is going away without `close`.
    Closing,
}

/// When to stop starting runnables; the binding implements it with `Instant`, tests with a
/// counter. Never a wall clock in logic (rule 9).
pub trait Budget {
    fn start(&mut self);
    /// True after 64 runnables or 4 ms.
    fn spent(&self, started: usize) -> bool;
    /// Whether the turn's intake share (2 ms, half the time budget) is gone. The binding
    /// measures it; a counter budget leaves it false, so intake is bounded by its 32 items.
    fn intake_spent(&self) -> bool {
        false
    }
}

/// One external item (a session event, an I/O completion, a timer firing, an after-commit
/// release): waking its task schedules the runnable through the task's own schedule function.
pub enum Item {
    Wake(std::task::Waker),
}

/// What an external producer found. After admission has closed it pushes nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Push {
    Accepted,
    Refused,
}

/// The state every producer and the pump share, `Send + Sync` so tokio and the JS thread use it.
pub struct Shared {
    claim: AtomicU8,
    /// Admission: no external producer may push after `close_admission`.
    closed: AtomicBool,
    /// Terminal: no runnable is queued or run after `shut`.
    shut: AtomicBool,
    inbox: ConcurrentQueue<Item>,
    control: ConcurrentQueue<Runnable<TaskId>>,
    work: ConcurrentQueue<Runnable<TaskId>>,
    /// How many ordinary (non-barrier) runnables a producer has counted for the two lanes.
    /// Every ordinary runnable increments it before its push and every pop decrements it, so
    /// `idle` never infers work from queue lengths: a producer paused between its count and its
    /// push still keeps the engine busy.
    ordinary_queued: AtomicUsize,
    /// The shutdown test's window: a producer paused between its admission check and its push.
    #[cfg(test)]
    pub(crate) pause_producer: AtomicBool,
    /// Producers between their admission check and their push's move. A push that races
    /// `close_admission` may still land in the inbox, so close waits these out and the end of a
    /// turn never signals "drained" while one is in flight.
    inflight: AtomicUsize,
    notifier: Box<dyn Notifier>,
    next_task: AtomicU64,
}

impl Shared {
    fn queue(&self, lane: Lane) -> &ConcurrentQueue<Runnable<TaskId>> {
        match lane {
            Lane::Control => &self.control,
            Lane::Work => &self.work,
        }
    }

    /// After an item is pushed: the one-claim producer move, retried against the state it
    /// observes, so an item pushed while the pump goes idle still posts.
    fn moved(&self) {
        let mut seen = self.claim.load(SeqCst);
        loop {
            let Some(next) = claim::producer_next(seen) else {
                return;
            };
            match self.claim.compare_exchange(seen, next, SeqCst, SeqCst) {
                Ok(_) => {
                    if next == claim::SCHEDULED {
                        self.post();
                    }
                    return;
                }
                Err(now) => seen = now,
            }
        }
    }

    /// Counts a producer for its whole check-push-move span.
    fn enter(&self) {
        self.inflight.fetch_add(1, SeqCst);
    }

    /// A producer's span ended. The last one to leave an admission-closed executor schedules the
    /// turn that drains what it just pushed; a guard runs this even while unwinding.
    fn leave(&self) {
        if self.inflight.fetch_sub(1, SeqCst) == 1
            && self.closed.load(SeqCst)
            && !self.shut.load(SeqCst)
        {
            self.moved();
        }
    }

    /// Releases one counted ordinary runnable: a pop, or a pushed runnable shutdown refused.
    /// It saturates at zero so a producer that counted before shutdown cannot wrap the count;
    /// the debug assert keeps a real miscount loud in tests.
    fn release_ordinary(&self) {
        let mut seen = self.ordinary_queued.load(SeqCst);
        loop {
            match self.ordinary_queued.compare_exchange_weak(
                seen,
                seen.saturating_sub(1),
                SeqCst,
                SeqCst,
            ) {
                Ok(_) => {
                    debug_assert!(
                        seen > 0,
                        "an ordinary runnable was released without its count"
                    );
                    return;
                }
                Err(now) => seen = now,
            }
        }
    }

    fn post(&self) {
        match self.notifier.notify() {
            Notified::Posted => {}
            Notified::Closing => {
                // The environment is being torn down without close: nothing posts again.
                eprintln!("engine pump not posted: environment closing");
            }
        }
    }
}

/// !Send: lives on the JS thread with the engine state.
pub struct Executor {
    shared: Arc<Shared>,
    running: Cell<bool>,
    current: Cell<Option<TaskId>>,
    /// Consecutive control polls since the last work poll, saturating at 8. Executor state, not
    /// per turn: it survives the end of a turn, so the fairness rule holds when every turn ends
    /// after one poll, and it never grows past 8.
    control_streak: Cell<u8>,
    /// Set by `close_admission`; the pump signals `drained` at the end of the first turn that
    /// finds the inbox and both run queues empty.
    draining: Cell<Option<oneshot::Sender<()>>>,
    /// Set by `end_turn`: no further runnable starts this turn, and the claim moves to
    /// `Scheduled` (E5.2 correction 9).
    end_turn: Cell<bool>,
    stats: Cell<ExecutorStats>,
    turn_polls: RefCell<Vec<u32>>,
}

impl Executor {
    pub fn new(notifier: Box<dyn Notifier>) -> Executor {
        Executor {
            shared: Arc::new(Shared {
                claim: AtomicU8::new(claim::IDLE),
                closed: AtomicBool::new(false),
                shut: AtomicBool::new(false),
                inbox: ConcurrentQueue::unbounded(),
                control: ConcurrentQueue::unbounded(),
                work: ConcurrentQueue::unbounded(),
                ordinary_queued: AtomicUsize::new(0),
                #[cfg(test)]
                pause_producer: AtomicBool::new(false),
                inflight: AtomicUsize::new(0),
                notifier,
                next_task: AtomicU64::new(1),
            }),
            running: Cell::new(false),
            current: Cell::new(None),
            control_streak: Cell::new(0),
            draining: Cell::new(None),
            end_turn: Cell::new(false),
            stats: Cell::new(ExecutorStats::default()),
            turn_polls: RefCell::new(Vec::new()),
        }
    }

    /// Spawns on `lane`: the schedule function pushes the runnable onto that lane's queue, then
    /// moves the claim. A panicking task completes its `Task` with the panic instead of
    /// unwinding through the pump.
    pub fn spawn<T: 'static>(
        &self,
        lane: Lane,
        future: impl Future<Output = T> + 'static,
    ) -> Task<T, TaskId> {
        self.spawn_next(lane, future).1
    }

    /// Spawns on `lane` a barrier: a task that waits for other work rather than doing it. Its
    /// queued runnable does not make the engine busy (see `idle`).
    pub fn spawn_barrier<T: 'static>(
        &self,
        lane: Lane,
        future: impl Future<Output = T> + 'static,
    ) -> Task<T, TaskId> {
        self.spawn_marked(lane, future, true).1
    }

    /// `spawn`, also returning the task's id so the caller can recognise its own poll.
    pub fn spawn_next<T: 'static>(
        &self,
        lane: Lane,
        future: impl Future<Output = T> + 'static,
    ) -> (TaskId, Task<T, TaskId>) {
        self.spawn_marked(lane, future, false)
    }

    fn spawn_marked<T: 'static>(
        &self,
        lane: Lane,
        future: impl Future<Output = T> + 'static,
        barrier: bool,
    ) -> (TaskId, Task<T, TaskId>) {
        let raw = self.shared.next_task.fetch_add(1, SeqCst);
        let id = if barrier { raw | BARRIER_MARK } else { raw };
        let shared = Arc::clone(&self.shared);
        let schedule = move |runnable: Runnable<TaskId>| {
            if shared.shut.load(SeqCst) {
                // No runnable is accepted after `shut`: dropping it cancels this wake-up.
                return;
            }
            if !is_barrier(id) {
                shared.ordinary_queued.fetch_add(1, SeqCst);
            }
            if shared.queue(lane).push(runnable).is_err() {
                if !is_barrier(id) {
                    shared.release_ordinary();
                }
                return;
            }
            shared.moved();
        };
        let (runnable, task) = Builder::new()
            .metadata(id)
            .propagate_panic(true)
            .spawn_local(|_| future, schedule);
        runnable.schedule();
        (id, task)
    }

    /// Whether nothing ordinary is left: `flush` and the shutdown join's empty end. Empty when
    /// the inbox is empty, no ordinary runnable is counted in either lane (queued or about to
    /// be), and nothing ordinary is running. `exclude` is the caller's own task, which may be
    /// ordinary work (`flush` reached from inside a task, which must not wait on itself).
    pub fn idle(&self, exclude: Option<TaskId>) -> bool {
        self.shared.inbox.is_empty()
            && self.shared.ordinary_queued.load(SeqCst) == 0
            && self
                .current
                .get()
                .is_none_or(|id| Some(id) == exclude || is_barrier(id))
    }

    /// Pops one runnable, keeping the ordinary count in step.
    fn take(&self, lane: Lane) -> Option<Runnable<TaskId>> {
        let runnable = self.shared.queue(lane).pop().ok()?;
        if !is_barrier(*runnable.metadata()) {
            self.shared.release_ordinary();
        }
        Some(runnable)
    }

    /// A `Send` handle for producers on any thread.
    pub fn waker(&self) -> ExecutorWake {
        ExecutorWake {
            shared: Arc::clone(&self.shared),
        }
    }

    /// The task being polled now, if any (for barriers that must not wait on their caller).
    pub fn current(&self) -> Option<TaskId> {
        self.current.get()
    }

    /// Like `current`, for code that only has the shared handle.
    pub fn shared(&self) -> Arc<Shared> {
        Arc::clone(&self.shared)
    }

    pub fn stats(&self) -> ExecutorStats {
        self.stats.get()
    }

    /// Polls per turn so far, oldest first.
    pub fn turns(&self) -> Vec<u32> {
        self.turn_polls.borrow().clone()
    }

    /// Shutdown, first step: closes the inbox (no external producer can enqueue from here on)
    /// and returns a receiver the pump completes when everything admitted has run.
    pub fn close_admission(&self) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        self.shared.closed.store(true, SeqCst);
        self.shared.inbox.close();
        self.draining.set(Some(sender));
        // A push that passed the admission check before it closed may still be landing. If one
        // is, its guard's last leave moves the claim and the pump drains everything then; this
        // call never spins on the JS thread, and the close deadline bounds the wait.
        if self.shared.inflight.load(SeqCst) == 0 {
            self.shared.moved();
        }
        receiver
    }

    /// Terminal: no runnable is accepted or run again; queued runnables are dropped (their
    /// tasks cancel).
    pub fn shut(&self) {
        self.shared.closed.store(true, SeqCst);
        self.shared.shut.store(true, SeqCst);
        self.shared.inbox.close();
        self.shared.control.close();
        self.shared.work.close();
        // Dropped runnables leave through the counted pop path, so shutdown never zeroes a
        // count a producer is still holding for its push.
        while self.shared.inbox.pop().is_ok() {}
        while self.take(Lane::Control).is_some() {}
        while self.take(Lane::Work).is_some() {}
        self.draining.take();
    }

    /// Asks the turn to end after the task being polled (E5.2 decision 5).
    pub fn end_turn(&self) {
        self.end_turn.set(true);
    }

    /// The claim's current value, for the probe and the tests.
    pub fn claim(&self) -> u8 {
        self.shared.claim.load(SeqCst)
    }

    /// The close's drain is still armed (the probe's failure message).
    #[cfg(test)]
    pub(crate) fn draining_pending(&self) -> bool {
        self.draining.take().is_some()
    }

    #[cfg(test)]
    pub(crate) fn control_streak(&self) -> u8 {
        self.control_streak.get()
    }

    #[cfg(test)]
    pub(crate) fn inbox_len(&self) -> usize {
        self.shared.inbox.len()
    }
}

enum End {
    Rearm,
    Drained,
    Again,
}

#[cfg(test)]
pub(crate) mod tests;
