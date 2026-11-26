// SPDX-License-Identifier: Apache-2.0
//! Abort signals and timers: the two things the MCP server cannot control, passed in as ports.
//!
//! `Abort` is the Rust form of an `AbortSignal` the server needs (a lease's lifetime, a request's
//! cancellation, a call's deadline): state plus hooks that run once. `Scheduler` is the Rust form
//! of the registry's `Scheduler` (`registry.ts:161`), so timeouts and progress beats use the
//! daemon's timers and a test can fire them by hand.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

/// One abortable lifetime. Cloning shares the state; the first abort wins.
#[derive(Clone, Default)]
pub struct Abort {
    inner: Arc<AbortInner>,
}

#[derive(Default)]
struct AbortInner {
    aborted: AtomicBool,
    notify: Notify,
    hooks: Mutex<Vec<Box<dyn Fn() + Send + Sync>>>,
}

impl Abort {
    pub fn new() -> Abort {
        Abort::default()
    }

    /// Aborts once: every hook runs, and every waiter wakes.
    pub fn abort(&self) {
        if self.inner.aborted.swap(true, Ordering::SeqCst) {
            return;
        }
        let hooks: Vec<_> = {
            let mut hooks = self
                .inner
                .hooks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *hooks)
        };
        for hook in hooks {
            hook();
        }
        // A stored permit covers a waiter that checks, then waits, between the two.
        self.inner.notify.notify_waiters();
    }

    pub fn aborted(&self) -> bool {
        self.inner.aborted.load(Ordering::SeqCst)
    }

    /// Runs `hook` on abort; runs it now when the signal is already aborted.
    pub fn on_abort(&self, hook: Box<dyn Fn() + Send + Sync>) {
        if self.aborted() {
            hook();
            return;
        }
        let mut hooks = self
            .inner
            .hooks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.inner.aborted.load(Ordering::SeqCst) {
            drop(hooks);
            hook();
            return;
        }
        hooks.push(hook);
    }

    /// Resolves once the signal aborts.
    pub async fn wait(&self) {
        loop {
            if self.aborted() {
                return;
            }
            self.inner.notify.notified().await;
        }
    }

    /// A signal aborted when any of `signals` is (`AbortSignal.any`).
    pub fn any(signals: Vec<Abort>) -> Abort {
        let fused = Abort::new();
        for signal in signals {
            let target = fused.clone();
            signal.on_abort(Box::new(move || target.abort()));
        }
        fused
    }
}

/// The timer the server arms (`Scheduler.after`): `fire` runs after `ms` unless the returned
/// guard is called first.
pub trait Scheduler: Send + Sync + 'static {
    fn after(&self, ms: u64, fire: Box<dyn FnOnce() + Send + Sync>) -> Box<dyn Fn() + Send + Sync>;
}

/// `nodeScheduler`: a tokio timer on the daemon's runtime.
pub struct TokioScheduler;

impl Scheduler for TokioScheduler {
    fn after(&self, ms: u64, fire: Box<dyn FnOnce() + Send + Sync>) -> Box<dyn Fn() + Send + Sync> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancelled);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            if !flag.load(Ordering::SeqCst) {
                fire();
            }
        });
        Box::new(move || {
            cancelled.store(true, Ordering::SeqCst);
        })
    }
}

/// One armed timer: its delay and the callback.
#[cfg(test)]
type Armed = (u64, Box<dyn FnOnce() + Send + Sync>);

/// A timer handed to a test: it records every arm and fires on request.
#[cfg(test)]
#[derive(Default)]
pub struct ManualScheduler {
    timers: Mutex<Vec<Armed>>,
}

#[cfg(test)]
impl ManualScheduler {
    pub fn armed(&self) -> Vec<u64> {
        self.timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(ms, _)| *ms)
            .collect()
    }

    /// Fires every timer armed so far, in order.
    pub fn fire_all(&self) {
        let timers: Vec<_> = {
            let mut timers = self
                .timers
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *timers)
        };
        for (_, fire) in timers {
            fire();
        }
    }
}

#[cfg(test)]
impl Scheduler for ManualScheduler {
    fn after(&self, ms: u64, fire: Box<dyn FnOnce() + Send + Sync>) -> Box<dyn Fn() + Send + Sync> {
        self.timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push((ms, fire));
        Box::new(|| {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hook_runs_once_and_only_on_abort() {
        let signal = Abort::new();
        let runs = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&runs);
        signal.on_abort(Box::new(move || {
            flag.store(true, Ordering::SeqCst);
        }));
        assert!(!runs.load(Ordering::SeqCst));
        signal.abort();
        signal.abort();
        assert!(runs.load(Ordering::SeqCst));
        assert!(signal.aborted());
    }

    #[test]
    fn a_hook_added_after_the_abort_runs_immediately() {
        let signal = Abort::new();
        signal.abort();
        let runs = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&runs);
        signal.on_abort(Box::new(move || {
            flag.store(true, Ordering::SeqCst);
        }));
        assert!(runs.load(Ordering::SeqCst));
    }

    #[test]
    fn a_fused_signal_aborts_when_any_of_its_parts_does() {
        let first = Abort::new();
        let second = Abort::new();
        let fused = Abort::any(vec![first.clone(), second.clone()]);
        assert!(!fused.aborted());
        second.abort();
        assert!(fused.aborted());
        assert!(!first.aborted());
    }

    #[test]
    fn a_manual_scheduler_records_and_fires_its_timers() {
        let scheduler = ManualScheduler::default();
        let fired = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&fired);
        let _guard = scheduler.after(
            30_000,
            Box::new(move || {
                flag.store(true, Ordering::SeqCst);
            }),
        );
        assert_eq!(scheduler.armed(), vec![30_000]);
        scheduler.fire_all();
        assert!(fired.load(Ordering::SeqCst));
    }
}
