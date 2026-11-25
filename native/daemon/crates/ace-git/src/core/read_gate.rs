// SPDX-License-Identifier: Apache-2.0
//! `ReadGate(2)`: at most two history reads run at once across the service,
//! and a waiter whose caller aborts leaves the queue. Ported from
//! `packages/git/src/read-gate.ts` (G2b). G3's history reads run through it.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use crate::core::error::{GitError, GitErrorCode};
use crate::core::serial::Cancellation;

struct Waiter {
    granted: AtomicBool,
    notify: Notify,
}

impl Waiter {
    fn grant(&self) {
        self.granted.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    async fn granted(&self) {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.granted.load(Ordering::Acquire) {
            return;
        }
        notified.await;
    }
}

#[derive(Default)]
struct GateInner {
    running: usize,
    waiting: VecDeque<Arc<Waiter>>,
}

/// A bounded gate for reads of immutable history (`ReadGate`).
pub struct ReadGate {
    limit: usize,
    inner: Mutex<GateInner>,
}

impl ReadGate {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            inner: Mutex::new(GateInner::default()),
        }
    }

    /// The default the service builds: at most two history reads at once.
    pub fn history() -> Self {
        Self::new(2)
    }

    /// Takes a slot, waiting for one, or stops waiting when `cancel` aborts.
    pub async fn enter(
        self: &Arc<Self>,
        cancel: Option<&Arc<Cancellation>>,
    ) -> Result<ReadLease, GitError> {
        if cancel.is_some_and(|signal| signal.is_aborted()) {
            return Err(cancelled());
        }
        let waiter = Arc::new(Waiter {
            granted: AtomicBool::new(false),
            notify: Notify::new(),
        });
        {
            let mut inner = self.inner.lock().map_err(|_| cancelled())?;
            if inner.running < self.limit {
                inner.running += 1;
                return Ok(ReadLease {
                    gate: Arc::clone(self),
                    held: true,
                });
            }
            inner.waiting.push_back(Arc::clone(&waiter));
        }
        let Some(signal) = cancel else {
            waiter.granted().await;
            return Ok(ReadLease {
                gate: Arc::clone(self),
                held: true,
            });
        };
        let waiting = waiter.granted();
        tokio::pin!(waiting);
        let stopped = tokio::select! {
            biased;
            _ = &mut waiting => false,
            _ = signal.aborted() => true,
        };
        if !stopped {
            return Ok(ReadLease {
                gate: Arc::clone(self),
                held: true,
            });
        }
        // A grant removes the abort handler in TypeScript; only a waiter still
        // queued when it gave up leaves, and it never holds a slot.
        let mut inner = self.inner.lock().map_err(|_| cancelled())?;
        let at = inner
            .waiting
            .iter()
            .position(|entry| Arc::ptr_eq(entry, &waiter));
        if let Some(at) = at {
            inner.waiting.remove(at);
            return Err(cancelled());
        }
        drop(inner);
        if waiter.granted.load(Ordering::Acquire) {
            return Ok(ReadLease {
                gate: Arc::clone(self),
                held: true,
            });
        }
        Err(cancelled())
    }

    /// Runs `work` inside a slot (`ReadGate.run`).
    pub async fn run<T, F, Fut>(
        self: &Arc<Self>,
        cancel: Option<&Arc<Cancellation>>,
        work: F,
    ) -> Result<T, GitError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, GitError>>,
    {
        let lease = self.enter(cancel).await?;
        let outcome = work().await;
        drop(lease);
        outcome
    }

    fn leave(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.running = inner.running.saturating_sub(1);
            if let Some(next) = inner.waiting.pop_front() {
                // The slot moves to the waiter rather than being released.
                inner.running += 1;
                drop(inner);
                next.grant();
            }
        }
    }
}

/// One held slot; dropping it lets the next read run.
pub struct ReadLease {
    gate: Arc<ReadGate>,
    held: bool,
}

impl Drop for ReadLease {
    fn drop(&mut self) {
        if self.held {
            self.held = false;
            self.gate.leave();
        }
    }
}

fn cancelled() -> GitError {
    GitError::new(
        GitErrorCode::GitCancelled,
        "Git operation cancelled before dispatch",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A read that stays open until its test releases it.
    struct Held {
        release: Option<tokio::sync::oneshot::Sender<()>>,
        wait: Option<tokio::sync::oneshot::Receiver<()>>,
    }

    impl Held {
        fn new() -> Self {
            let (release, wait) = tokio::sync::oneshot::channel();
            Self {
                release: Some(release),
                wait: Some(wait),
            }
        }

        fn take_wait(&mut self) -> tokio::sync::oneshot::Receiver<()> {
            self.wait.take().expect("wait")
        }

        fn release(mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
        }
    }

    impl Drop for Held {
        fn drop(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
        }
    }

    #[tokio::test]
    async fn no_more_than_the_limit_of_reads_run_at_once_and_the_next_starts_when_one_ends() {
        let gate = Arc::new(ReadGate::new(2));
        let log = Arc::new(Mutex::new(Vec::<usize>::new()));
        let mut reads = vec![Held::new(), Held::new(), Held::new()];
        let mut runs = Vec::new();
        for (index, held) in reads.iter_mut().enumerate() {
            let (gate, log) = (Arc::clone(&gate), Arc::clone(&log));
            let wait = held.take_wait();
            runs.push(tokio::spawn(async move {
                let _slot = gate.enter(None).await.expect("slot");
                log.lock().expect("log").push(index);
                let _ = wait.await;
            }));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(*log.lock().expect("log"), vec![0, 1]);
        reads.remove(0).release();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(*log.lock().expect("log"), vec![0, 1, 2]);
        for held in reads {
            held.release();
        }
        for run in runs {
            run.await.expect("read");
        }
    }

    #[tokio::test]
    async fn a_waiting_read_whose_caller_gave_up_leaves_the_queue_without_running() {
        let gate = Arc::new(ReadGate::new(1));
        let (release_first, wait_first) = tokio::sync::oneshot::channel::<()>();
        let busy = {
            let gate = Arc::clone(&gate);
            tokio::spawn(async move {
                let _slot = gate.enter(None).await.expect("slot");
                let _ = wait_first.await;
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let signal = Cancellation::new();
        let ran = Arc::new(AtomicBool::new(false));
        let waiting = {
            let (gate, ran, signal) = (Arc::clone(&gate), Arc::clone(&ran), Arc::clone(&signal));
            tokio::spawn(async move {
                let slot = gate.enter(Some(&signal)).await;
                if slot.is_ok() {
                    ran.store(true, Ordering::Release);
                }
                slot.map(drop)
            })
        };
        signal.abort();
        let outcome = waiting.await.expect("waiting");
        let error = outcome.expect_err("cancelled");
        assert_eq!(error.code, GitErrorCode::GitCancelled);
        let _ = release_first.send(());
        busy.await.expect("busy");
        assert!(!ran.load(Ordering::Acquire));
        // The slot it would have taken is free for the next read.
        let next = tokio::time::timeout(Duration::from_millis(200), gate.enter(None))
            .await
            .expect("free")
            .expect("slot");
        drop(next);
    }
}
