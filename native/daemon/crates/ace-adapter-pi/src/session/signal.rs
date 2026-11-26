// SPDX-License-Identifier: Apache-2.0
//! The session's one abort primitive: `ctx.signal`'s Rust form. Cloning shares it; hooks run once.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

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
        self.inner.notify.notify_waiters();
    }

    pub fn aborted(&self) -> bool {
        self.inner.aborted.load(Ordering::SeqCst)
    }

    /// Runs `hook` on abort, or now when the signal is already aborted.
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
            let notified = self.inner.notify.notified();
            if self.aborted() {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hook_runs_once_on_the_first_abort() {
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
    }

    #[test]
    fn a_hook_added_after_the_abort_runs_at_once() {
        let signal = Abort::new();
        signal.abort();
        let runs = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&runs);
        signal.on_abort(Box::new(move || {
            flag.store(true, Ordering::SeqCst);
        }));
        assert!(runs.load(Ordering::SeqCst));
    }
}
