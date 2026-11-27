// SPDX-License-Identifier: Apache-2.0
//! Intent workers (E5.1): one task per thread that coalesces wakeups and runs another pass when
//! work was accepted while the previous pass ran (`engine/workers.ts`).

use crate::EngineError;
use crate::executor::{Executor, Lane, TaskId};
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// What one pass runs for a thread. The owning item supplies it (E5.4 sends, E5.5 steering,
/// E5.10 controls); until then it returns `NotPorted`, reported once per wake. It is an `Rc`
/// rather than a bare function pointer so the owning item's run can reach that item's state
/// without borrowing it across an await.
pub type WorkerRun = Rc<dyn Fn(String) -> LocalBoxFuture<'static, Result<(), EngineError>>>;

#[derive(Default)]
struct Shared {
    running: HashSet<String>,
    rerun: HashSet<String>,
    /// The task running each thread's pass, so a barrier called from inside that task can skip
    /// it.
    task_of: HashMap<String, TaskId>,
    /// The thread whose pass is running now, so `drain` from inside it resolves at once.
    current: Option<String>,
    stopped: bool,
    /// One receiver per caller waiting for a thread's pass to end.
    waiters: HashMap<String, Vec<oneshot::Sender<()>>>,
}

/// One worker set: sends and steering run on the work lane, controls on the control lane.
#[derive(Clone)]
pub struct Workers {
    lane: Lane,
    shared: Rc<RefCell<Shared>>,
    report: Rc<dyn Fn(String)>,
}

impl Workers {
    pub fn new(lane: Lane, report: Rc<dyn Fn(String)>) -> Workers {
        Workers {
            lane,
            shared: Rc::new(RefCell::new(Shared::default())),
            report,
        }
    }

    pub fn lane(&self) -> Lane {
        self.lane
    }

    /// Marks a pass for `id`; `true` when the caller must spawn one (outside this call, so no
    /// borrow is held while the task is scheduled).
    pub fn mark(&self, id: &str) -> bool {
        let mut shared = self.shared.borrow_mut();
        if shared.stopped {
            return false;
        }
        if shared.running.contains(id) {
            shared.rerun.insert(id.to_string());
            return false;
        }
        shared.running.insert(id.to_string());
        true
    }

    /// Coalesces wakeups while preserving another pass after work accepted during the pass.
    pub fn wake(&self, id: &str, executor: &Executor, run: WorkerRun) {
        if !self.mark(id) {
            return;
        }
        self.spawn(id.to_string(), executor, run);
    }

    /// Starts the task for an id `mark` accepted.
    pub fn spawn(&self, id: String, executor: &Executor, run: WorkerRun) {
        let shared = Rc::clone(&self.shared);
        let tracked = Rc::clone(&self.shared);
        let report = Rc::clone(&self.report);
        let key = id.clone();
        let (task_id, task) = executor.spawn_next(self.lane, async move {
            loop {
                {
                    // The rerun that scheduled this pass is consumed by it; one added during
                    // the pass schedules the next.
                    let mut state = shared.borrow_mut();
                    state.rerun.remove(&id);
                    state.current = Some(id.clone());
                }
                let result = run(id.clone()).await;
                shared.borrow_mut().current = None;
                if let Err(error) = result {
                    (report)(format!("worker {id}: {error}"));
                }
                let state = shared.borrow();
                if state.stopped || !state.rerun.contains(&id) {
                    break;
                }
            }
            let mut state = shared.borrow_mut();
            state.running.remove(&id);
            if let Some(waiters) = state.waiters.remove(&id) {
                for waiter in waiters {
                    let _ = waiter.send(());
                }
            }
        });
        tracked.borrow_mut().task_of.insert(key, task_id);
        task.detach();
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.shared.borrow().running.contains(id)
    }

    pub fn active(&self) -> bool {
        !self.shared.borrow().running.is_empty()
    }

    /// A receiver that resolves when `id`'s pass ends; `None` when nothing runs for it, and for
    /// the pass that is running now (`drain` from inside it must not wait on itself).
    pub fn drain(&self, id: &str) -> Option<oneshot::Receiver<()>> {
        let mut shared = self.shared.borrow_mut();
        if shared.current.as_deref() == Some(id) || !shared.running.contains(id) {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        shared
            .waiters
            .entry(id.to_string())
            .or_default()
            .push(sender);
        Some(receiver)
    }

    /// One receiver per active thread, for `flush`; the caller's own pass (`exclude`) is
    /// skipped, so a task that flushes never waits on itself.
    pub fn waiters(&self, exclude: Option<TaskId>) -> Vec<oneshot::Receiver<()>> {
        let mut shared = self.shared.borrow_mut();
        let ids: Vec<String> = shared
            .running
            .iter()
            .filter(|id| shared.task_of.get(*id).copied() != exclude)
            .cloned()
            .collect();
        let mut waiters = Vec::new();
        for id in ids {
            let (sender, receiver) = oneshot::channel();
            shared.waiters.entry(id).or_default().push(sender);
            waiters.push(receiver);
        }
        waiters
    }

    pub async fn flush(&self, exclude: Option<TaskId>) {
        loop {
            let waiters = self.waiters(exclude);
            if waiters.is_empty() {
                return;
            }
            futures::future::join_all(waiters).await;
        }
    }

    pub fn stop(&self) {
        self.shared.borrow_mut().stopped = true;
    }

    /// The set stops taking new passes; running ones finish on their own.
    pub fn current(&self) -> Option<String> {
        self.shared.borrow().current.clone()
    }
}

/// The engine's three worker sets: controls on the control lane, sends and steering on work.
pub struct WorkerSet {
    pub sends: Workers,
    pub controls: Workers,
    pub steering: Workers,
}

impl Default for WorkerSet {
    fn default() -> WorkerSet {
        WorkerSet::new(Rc::new(|_| {}))
    }
}

impl WorkerSet {
    pub fn new(report: Rc<dyn Fn(String)>) -> WorkerSet {
        WorkerSet {
            sends: Workers::new(Lane::Work, Rc::clone(&report)),
            controls: Workers::new(Lane::Control, Rc::clone(&report)),
            steering: Workers::new(Lane::Work, report),
        }
    }

    pub fn waiters(&self, exclude: Option<TaskId>) -> Vec<oneshot::Receiver<()>> {
        let mut waiters = self.sends.waiters(exclude);
        waiters.extend(self.controls.waiters(exclude));
        waiters.extend(self.steering.waiters(exclude));
        waiters
    }

    pub fn stop(&self) {
        self.sends.stop();
        self.controls.stop();
        self.steering.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::{Budget, Notified, Notifier, Pump};
    use futures::FutureExt;
    use std::cell::Cell;

    struct Silent;

    impl Notifier for Silent {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    struct Standard;

    impl Budget for Standard {
        fn start(&mut self) {}
        fn spent(&self, started: usize) -> bool {
            started >= 64
        }
    }

    fn executor() -> Executor {
        Executor::new(Box::new(Silent))
    }

    fn pump(executor: &Executor) {
        let mut budget = Standard;
        while executor.pump(&mut budget, &|| false) == Pump::Rearm {}
    }

    fn counting(runs: Rc<Cell<u32>>) -> WorkerRun {
        Rc::new(move |_| {
            let runs = Rc::clone(&runs);
            async move {
                runs.set(runs.get() + 1);
                Ok(())
            }
            .boxed_local()
        })
    }

    #[test]
    fn a_wake_during_a_pass_runs_one_more_pass() {
        let executor = executor();
        let workers = Workers::new(Lane::Work, Rc::new(|_| {}));
        let runs = Rc::new(Cell::new(0));
        let count = Rc::clone(&runs);
        let inside = workers.clone();
        let first = Rc::new(Cell::new(true));
        let run: WorkerRun = Rc::new(move |id| {
            let count = Rc::clone(&count);
            let workers = inside.clone();
            let first = Rc::clone(&first);
            async move {
                count.set(count.get() + 1);
                // Work accepted during the pass is one more pass, never a second task.
                if first.replace(false) {
                    workers.mark(&id);
                }
                Ok(())
            }
            .boxed_local()
        });
        workers.wake("t1", &executor, run);
        // Two synchronous wakes before the pass starts coalesce into that one pass.
        let runs_before = runs.get();
        assert!(workers.is_active("t1"));
        pump(&executor);
        assert_eq!(runs.get(), runs_before + 2);
        assert!(!workers.is_active("t1"));
    }

    #[test]
    fn stop_prevents_new_passes() {
        let executor = executor();
        let workers = Workers::new(Lane::Control, Rc::new(|_| {}));
        workers.stop();
        let runs = Rc::new(Cell::new(0));
        workers.wake("t1", &executor, counting(Rc::clone(&runs)));
        pump(&executor);
        assert_eq!(runs.get(), 0);
    }

    #[test]
    fn drain_from_inside_the_pass_resolves_at_once_and_from_outside_after_it() {
        let executor = executor();
        let workers = Workers::new(Lane::Work, Rc::new(|_| {}));
        let inside = Rc::new(Cell::new(false));
        let flag = Rc::clone(&inside);
        let workers_inside = workers.clone();
        let run: WorkerRun = Rc::new(move |_| {
            let flag = Rc::clone(&flag);
            let workers = workers_inside.clone();
            async move {
                // Called from the pass itself: no receiver, so it cannot wait on itself.
                flag.set(workers.drain("t1").is_none());
                Ok(())
            }
            .boxed_local()
        });
        workers.wake("t1", &executor, run);
        assert!(workers.drain("t1").is_some(), "a waiter sees the pass");
        pump(&executor);
        assert!(inside.get());
        assert!(workers.drain("t1").is_none());
    }

    #[test]
    fn an_error_is_reported_once_and_the_worker_ends() {
        let executor = executor();
        let workers = Workers::new(Lane::Work, Rc::new(|_| {}));
        let runs = Rc::new(Cell::new(0));
        let count = Rc::clone(&runs);
        let run: WorkerRun = Rc::new(move |_| {
            let count = Rc::clone(&count);
            async move {
                count.set(count.get() + 1);
                Err(EngineError::Starting)
            }
            .boxed_local()
        });
        workers.wake("t1", &executor, run);
        pump(&executor);
        assert_eq!(runs.get(), 1);
        assert!(!workers.is_active("t1"));
    }
}
