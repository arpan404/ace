// SPDX-License-Identifier: Apache-2.0
//! The engine's local executor (ADR 0223 §4, E5.1).
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

pub use after_commit::{AfterCommit, Deferred, DeferredHost};

use async_task::{Builder, Runnable, Task};
use concurrent_queue::{ConcurrentQueue, PopError};
use futures::channel::oneshot;
use std::cell::{Cell, RefCell};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering::SeqCst};
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
    /// How many of the runnables queued in both lanes are barriers. Every push of a barrier
    /// increments it and every pop decrements it, so `idle` can tell a waiting flush from work.
    barriers_queued: AtomicU64,
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

/// A `Send` handle for producers on any thread (a session event, an I/O completion).
#[derive(Clone)]
pub struct ExecutorWake {
    shared: Arc<Shared>,
}

impl ExecutorWake {
    /// Pushes `item` onto the inbox, then does the producer move. After admission has closed
    /// it returns `Refused` and pushes nothing.
    pub fn push(&self, item: Item) -> Push {
        if self.shared.closed.load(SeqCst) {
            return Push::Refused;
        }
        if self.shared.inbox.push(item).is_err() {
            return Push::Refused;
        }
        self.shared.moved();
        Push::Accepted
    }
}

/// What a pump entry did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pump {
    /// The continuation must be scheduled with `setImmediate`.
    Rearm,
    /// The turn ran and nothing is left.
    Done,
    /// A stale notification, or a nested entry.
    Stale,
    /// The shared stack has a transaction open; re-arm.
    Busy,
}

/// The counters the probe and the bench read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExecutorStats {
    pub turns: u64,
    pub polls: u64,
    pub longest_poll_us: u64,
    pub slow_polls: u64,
    pub last_turn_polls: u32,
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
                barriers_queued: AtomicU64::new(0),
                notifier,
                next_task: AtomicU64::new(1),
            }),
            running: Cell::new(false),
            current: Cell::new(None),
            control_streak: Cell::new(0),
            draining: Cell::new(None),
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
            if is_barrier(id) {
                shared.barriers_queued.fetch_add(1, SeqCst);
            }
            if shared.queue(lane).push(runnable).is_err() {
                if is_barrier(id) {
                    shared.barriers_queued.fetch_sub(1, SeqCst);
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

    /// Whether nothing is left but barriers: `flush` and the shutdown join's empty end. Empty
    /// when the inbox is empty, every queued runnable in both lanes is a barrier, and nothing
    /// non-barrier is running. `exclude` is the caller's own task, which may be ordinary work
    /// (`flush` reached from inside a task, which must not wait on itself).
    pub fn idle(&self, exclude: Option<TaskId>) -> bool {
        let queued = self.shared.control.len() + self.shared.work.len();
        let barriers = self.shared.barriers_queued.load(SeqCst) as usize;
        self.shared.inbox.is_empty()
            && queued == barriers
            && self
                .current
                .get()
                .is_none_or(|id| Some(id) == exclude || is_barrier(id))
    }

    /// Pops one runnable, keeping the queued-barrier count in step.
    fn take(&self, lane: Lane) -> Option<Runnable<TaskId>> {
        let runnable = self.shared.queue(lane).pop().ok()?;
        if is_barrier(*runnable.metadata()) {
            self.shared.barriers_queued.fetch_sub(1, SeqCst);
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

    /// One turn. Returns `Rearm` when the continuation must be scheduled with `setImmediate`.
    pub fn pump(&self, budget: &mut dyn Budget, transaction_open: &dyn Fn() -> bool) -> Pump {
        if self.running.get() {
            // Reached from inside a port the turn called: the running turn sees the work.
            return Pump::Stale;
        }
        if claim::entry_next(self.shared.claim.load(SeqCst)) != Some(claim::RUNNING) {
            return Pump::Stale;
        }
        if self
            .shared
            .claim
            .compare_exchange(claim::SCHEDULED, claim::RUNNING, SeqCst, SeqCst)
            .is_err()
        {
            return Pump::Stale;
        }
        if transaction_open() {
            // The event loop already guarantees this cannot happen (Store.atomic is
            // synchronous); the check confirms it.
            self.shared.claim.store(claim::SCHEDULED, SeqCst);
            return Pump::Busy;
        }
        self.running.set(true);
        budget.start();
        let (outcome, polls) = self.turn(budget);
        self.running.set(false);
        self.current.set(None);
        self.record_turn(polls);
        outcome
    }

    fn turn(&self, budget: &mut dyn Budget) -> (Pump, u32) {
        let mut polls: u64 = 0;
        // The inbox's share is one turn's, shared by its retries: 32 items in all.
        let mut moved: usize = 0;
        loop {
            let capped = self.intake(budget, &mut moved);
            let mut first = true;
            loop {
                // The first poll of a phase always happens, even when intake used the whole
                // budget: a run queue that is non-empty is never skipped.
                if !first && (polls >= 64 || budget.spent(polls as usize)) {
                    break;
                }
                let Some(runnable) = self.next_runnable() else {
                    break;
                };
                self.poll(runnable);
                polls += 1;
                first = false;
            }
            if capped {
                // The rest of the inbox waits for the re-armed turn, which the shell schedules.
                self.shared.claim.store(claim::SCHEDULED, SeqCst);
                return (Pump::Rearm, polls as u32);
            }
            match self.end(polls as usize, budget) {
                End::Rearm => return (Pump::Rearm, polls as u32),
                End::Drained => return (Pump::Done, polls as u32),
                End::Again => continue,
            }
        }
    }

    /// The intake phase: at most 32 inbox items a turn, shared by its retries, stopping early
    /// when its 2 ms share is gone. Returns whether the cap left items for the next turn.
    fn intake(&self, budget: &mut dyn Budget, moved: &mut usize) -> bool {
        while *moved < 32 {
            if budget.intake_spent() {
                return false;
            }
            let item = match self.shared.inbox.pop() {
                Ok(item) => item,
                Err(PopError::Empty) => return false,
                Err(PopError::Closed) => return false,
            };
            *moved += 1;
            match item {
                Item::Wake(waker) => waker.wake(),
            }
        }
        !self.shared.inbox.is_empty()
    }

    /// The fairness rule: controls first, except that after eight in a row the next poll is work.
    fn next_runnable(&self) -> Option<Runnable<TaskId>> {
        let streak = self.control_streak.get();
        if streak >= 8
            && let Some(runnable) = self.take(Lane::Work)
        {
            self.control_streak.set(0);
            return Some(runnable);
        }
        if let Some(runnable) = self.take(Lane::Control) {
            self.control_streak.set((streak + 1).min(8));
            return Some(runnable);
        }
        match self.take(Lane::Work) {
            Some(runnable) => {
                self.control_streak.set(0);
                Some(runnable)
            }
            None => None,
        }
    }

    fn poll(&self, runnable: Runnable<TaskId>) {
        let id = *runnable.metadata();
        self.current.set(Some(id));
        let began = Instant::now();
        // `propagate_panic` keeps a task's panic out of the pump; this catches anything that
        // still unwinds and reports it once.
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runnable.run()));
        let took = began.elapsed();
        self.current.set(None);
        let mut stats = self.stats.get();
        stats.polls += 1;
        stats.longest_poll_us = stats.longest_poll_us.max(took.as_micros() as u64);
        if took.as_millis() > 16 {
            stats.slow_polls += 1;
        }
        self.stats.set(stats);
        if caught.is_err() {
            eprintln!("engine task {id} panicked and was dropped");
        }
    }

    fn record_turn(&self, polls: u32) {
        let mut stats = self.stats.get();
        stats.turns += 1;
        stats.last_turn_polls = polls;
        self.stats.set(stats);
        self.turn_polls.borrow_mut().push(polls);
    }

    /// The turn's end, a loop over the observed state.
    fn end(&self, polls: usize, budget: &mut dyn Budget) -> End {
        let work_left = !self.shared.inbox.is_empty()
            || !self.shared.control.is_empty()
            || !self.shared.work.is_empty();
        if work_left && !budget.spent(polls) {
            return End::Again;
        }
        if budget.spent(polls) {
            // Whoever dirtied the claim posted nothing; the continuation covers its item.
            self.shared.claim.store(claim::SCHEDULED, SeqCst);
            return End::Rearm;
        }
        match self
            .shared
            .claim
            .compare_exchange(claim::RUNNING, claim::IDLE, SeqCst, SeqCst)
        {
            Ok(_) => {
                if self.signal_drained() {
                    // The close task is now runnable; nothing more to do this turn.
                    return End::Drained;
                }
                End::Drained
            }
            Err(now) if now == claim::RUNNING_DIRTY => {
                // A producer dirtied the claim: drain once more.
                self.shared.claim.store(claim::RUNNING, SeqCst);
                End::Again
            }
            Err(_) => End::Drained,
        }
    }

    /// Signals the close task's drain receiver when everything admitted has run.
    fn signal_drained(&self) -> bool {
        match self.draining.take() {
            Some(sender) => {
                let _ = sender.send(());
                true
            }
            None => false,
        }
    }

    /// Shutdown, first step: closes the inbox (no external producer can enqueue from here on)
    /// and returns a receiver the pump completes when everything admitted has run.
    pub fn close_admission(&self) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        self.shared.closed.store(true, SeqCst);
        self.shared.inbox.close();
        self.draining.set(Some(sender));
        self.shared.moved();
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
        while self.shared.inbox.pop().is_ok() {}
        while self.shared.control.pop().is_ok() {}
        while self.shared.work.pop().is_ok() {}
        // Dropped barriers are no longer queued; the count must not outlive them.
        self.shared.barriers_queued.store(0, SeqCst);
        self.draining.take();
    }

    /// The claim's current value, for the probe and the tests.
    pub fn claim(&self) -> u8 {
        self.shared.claim.load(SeqCst)
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
