// SPDX-License-Identifier: Apache-2.0
//! One operation per root at a time, across every service instance
//! (`lock.ts`'s `serial`, keyed by canonical root). Ported from
//! `packages/git/src/lock.ts` (G2b). G4 takes its turn through this module.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::Notify;

use crate::core::error::{GitError, GitErrorCode};

/// A caller's abort signal: the core's shape of `AbortSignal`.
#[derive(Default)]
pub struct Cancellation {
    aborted: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Acquire)
    }

    /// Resolves once aborted, including when it already was.
    pub async fn aborted(&self) {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_aborted() {
            return;
        }
        notified.await;
    }
}

fn cancelled() -> GitError {
    GitError::new(
        GitErrorCode::GitCancelled,
        "Git read cancelled before it started",
    )
}

/// One turn in a root's queue. A turn resolves exactly once: when its operation
/// ends, or, for a caller that stopped waiting, when the operation ahead ends.
struct Turn {
    done: AtomicBool,
    notify: Notify,
}

impl Turn {
    fn new() -> Self {
        Self {
            done: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn finish(&self) {
        self.done.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    async fn finished(&self) {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.done.load(Ordering::Acquire) {
            return;
        }
        notified.await;
    }
}

/// The process-wide queue of turns, keyed by canonical root (`serial`'s `pending`).
#[derive(Default)]
pub struct Serial {
    pending: Mutex<HashMap<String, Arc<Turn>>>,
}

impl Serial {
    pub fn new() -> Self {
        Self::default()
    }

    fn take_turn(&self, key: &str) -> (Option<Arc<Turn>>, Arc<Turn>) {
        let turn = Arc::new(Turn::new());
        let previous = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.insert(key.to_owned(), Arc::clone(&turn)));
        (previous, turn)
    }

    fn finish(&self, key: &str, turn: &Arc<Turn>) {
        turn.finish();
        if let Ok(mut pending) = self.pending.lock()
            && pending
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, turn))
        {
            pending.remove(key);
        }
    }

    /// Waits for the operation ahead, or stops waiting when `cancel` aborts.
    /// A caller that stops waiting keeps its place until the operation ahead
    /// ends, so the queue behind it is unchanged; it never runs.
    pub async fn acquire(
        self: &Arc<Self>,
        key: &str,
        cancel: Option<&Arc<Cancellation>>,
    ) -> Result<SerialTurn, GitError> {
        let (previous, turn) = self.take_turn(key);
        match previous {
            Some(ref ahead) => match cancel {
                Some(signal) => {
                    let stopped = {
                        let waiting = ahead.finished();
                        tokio::pin!(waiting);
                        tokio::select! {
                            biased;
                            _ = signal.aborted() => true,
                            _ = &mut waiting => false,
                        }
                    };
                    if stopped {
                        self.release_later(key, Arc::clone(ahead), Arc::clone(&turn));
                        return Err(cancelled());
                    }
                }
                None => ahead.finished().await,
            },
            None if cancel.is_some_and(|signal| signal.is_aborted()) => {
                let completed = Arc::new(Turn::new());
                completed.finish();
                self.release_later(key, completed, Arc::clone(&turn));
                return Err(cancelled());
            }
            None => {}
        }
        Ok(SerialTurn {
            serial: Arc::clone(self),
            key: key.to_owned(),
            turn,
        })
    }

    fn release_later(self: &Arc<Self>, key: &str, ahead: Arc<Turn>, turn: Arc<Turn>) {
        let serial = Arc::clone(self);
        let key = key.to_owned();
        tokio::spawn(async move {
            ahead.finished().await;
            serial.finish(&key, &turn);
        });
    }
}

/// The root's turn, held for one operation. Dropping it lets the next one run.
pub struct SerialTurn {
    serial: Arc<Serial>,
    key: String,
    turn: Arc<Turn>,
}

impl SerialTurn {
    /// Lets the next operation run, as TypeScript's `finally` does.
    pub fn release(&self) {
        self.serial.finish(&self.key, &self.turn);
    }
}

impl Drop for SerialTurn {
    fn drop(&mut self) {
        self.release();
    }
}

/// The queue every service instance shares (the module-level `pending` map).
pub fn global_serial() -> &'static Arc<Serial> {
    static SERIAL: OnceLock<Arc<Serial>> = OnceLock::new();
    SERIAL.get_or_init(|| Arc::new(Serial::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Records the order operations start and end in, and the peak concurrency.
    #[derive(Default)]
    struct Log {
        events: Mutex<Vec<String>>,
    }

    impl Log {
        fn push(&self, event: String) {
            self.events.lock().expect("log").push(event);
        }

        fn events(&self) -> Vec<String> {
            self.events.lock().expect("log").clone()
        }
    }

    #[tokio::test]
    async fn one_operation_per_root_runs_at_a_time_across_instances() {
        // Two services, one process-wide queue (the module-level `pending` map).
        let first = Arc::clone(global_serial());
        let second = Arc::clone(global_serial());
        let key = "/ace-g2b-tests/serial/one-operation";
        let log = Arc::new(Log::default());
        let (release_a, wait_a) = tokio::sync::oneshot::channel::<()>();
        let a = {
            let (serial, log) = (Arc::clone(&first), Arc::clone(&log));
            tokio::spawn(async move {
                let turn = serial.acquire(key, None).await.expect("turn");
                log.push("a start".to_owned());
                let _ = wait_a.await;
                log.push("a end".to_owned());
                drop(turn);
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let b = {
            let (serial, log) = (Arc::clone(&second), Arc::clone(&log));
            tokio::spawn(async move {
                let turn = serial.acquire(key, None).await.expect("turn");
                log.push("b start".to_owned());
                drop(turn);
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(log.events(), vec!["a start".to_owned()]);
        let _ = release_a.send(());
        a.await.expect("a");
        b.await.expect("b");
        assert_eq!(
            log.events(),
            vec!["a start".to_owned(), "a end".to_owned(), "b start".to_owned()]
        );
    }

    #[tokio::test]
    async fn different_roots_do_not_wait_for_each_other() {
        let serial = Arc::new(Serial::new());
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let held = {
            let serial = Arc::clone(&serial);
            tokio::spawn(async move {
                let _turn = serial.acquire("/repos/ace", None).await.expect("turn");
                let _ = wait.await;
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let other = tokio::time::timeout(
            Duration::from_millis(200),
            serial.acquire("/repos/other", None),
        )
        .await
        .expect("another root is not held")
        .expect("turn");
        drop(other);
        let _ = release.send(());
        held.await.expect("held");
    }

    #[tokio::test]
    async fn a_waiting_operation_that_stops_waiting_never_runs_and_keeps_the_queue_order() {
        let serial = Arc::new(Serial::new());
        let log = Arc::new(Log::default());
        let (release_a, wait_a) = tokio::sync::oneshot::channel::<()>();
        let a = {
            let (serial, log) = (Arc::clone(&serial), Arc::clone(&log));
            tokio::spawn(async move {
                let turn = serial.acquire("/repos/ace", None).await.expect("turn");
                log.push("a start".to_owned());
                let _ = wait_a.await;
                log.push("a end".to_owned());
                drop(turn);
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let signal = Cancellation::new();
        let b = {
            let (serial, log, signal) = (Arc::clone(&serial), Arc::clone(&log), Arc::clone(&signal));
            tokio::spawn(async move {
                match serial.acquire("/repos/ace", Some(&signal)).await {
                    Ok(turn) => {
                        log.push("b start".to_owned());
                        drop(turn);
                        Ok(())
                    }
                    Err(error) => {
                        log.push("b cancelled".to_owned());
                        Err(error)
                    }
                }
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        signal.abort();
        let outcome = b.await.expect("b");
        assert_eq!(
            outcome.expect_err("cancelled").code,
            GitErrorCode::GitCancelled
        );
        // The next turn still waits for the operation ahead, not for the cancelled waiter.
        let c = {
            let (serial, log) = (Arc::clone(&serial), Arc::clone(&log));
            tokio::spawn(async move {
                let turn = serial.acquire("/repos/ace", None).await.expect("turn");
                log.push("c start".to_owned());
                drop(turn);
            })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            log.events(),
            vec!["a start".to_owned(), "b cancelled".to_owned()]
        );
        let _ = release_a.send(());
        a.await.expect("a");
        c.await.expect("c");
        assert_eq!(
            log.events(),
            vec![
                "a start".to_owned(),
                "b cancelled".to_owned(),
                "a end".to_owned(),
                "c start".to_owned()
            ]
        );
    }

    #[tokio::test]
    async fn an_already_aborted_caller_never_takes_the_turn() {
        let serial = Arc::new(Serial::new());
        let signal = Cancellation::new();
        signal.abort();
        let error = serial
            .acquire("/repos/ace", Some(&signal))
            .await
            .err()
            .expect("cancelled");
        assert_eq!(error.code, GitErrorCode::GitCancelled);
        // The slot it would have taken is free for the next caller.
        let turn = tokio::time::timeout(
            Duration::from_millis(200),
            serial.acquire("/repos/ace", None),
        )
        .await
        .expect("free")
        .expect("turn");
        drop(turn);
    }
}
