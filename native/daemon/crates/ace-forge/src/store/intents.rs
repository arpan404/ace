// SPDX-License-Identifier: Apache-2.0
//! Per-key async serialization (`intents.ts`): an active writer keeps ownership of its key
//! until its operation settles (including reconciliation and receipt cleanup), while
//! independent keys proceed concurrently.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

struct KeyEntry {
    lock: Arc<AsyncMutex<()>>,
    waiters: usize,
}

/// Serializes async operations that share a key while allowing independent keys to overlap.
#[derive(Clone, Default)]
pub struct ForgeIntents {
    entries: Arc<Mutex<HashMap<String, KeyEntry>>>,
}

struct KeyGuard {
    // Field order matters: `_permit` drops first so the next waiter can wake, then `entries`
    // decrements `waiters` and removes the map entry when idle.
    _permit: OwnedMutexGuard<()>,
    entries: Arc<Mutex<HashMap<String, KeyEntry>>>,
    key: String,
}

impl Drop for KeyGuard {
    fn drop(&mut self) {
        let mut map = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = map.get_mut(&self.key) {
            entry.waiters = entry.waiters.saturating_sub(1);
            if entry.waiters == 0 {
                map.remove(&self.key);
            }
        }
    }
}

struct WaiterCleanup {
    entries: Arc<Mutex<HashMap<String, KeyEntry>>>,
    key: String,
    armed: bool,
}

impl Drop for WaiterCleanup {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut map = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = map.get_mut(&self.key) {
            entry.waiters = entry.waiters.saturating_sub(1);
            if entry.waiters == 0 {
                map.remove(&self.key);
            }
        }
    }
}

impl ForgeIntents {
    pub fn new() -> Self {
        Self::default()
    }

    /// Runs `operation` after any earlier operation on the same `key` has settled.
    pub async fn run<T, Fut>(&self, key: impl Into<String>, operation: impl FnOnce() -> Fut) -> T
    where
        Fut: Future<Output = T>,
    {
        let key = key.into();
        let lock = {
            let mut map = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = map.entry(key.clone()).or_insert_with(|| KeyEntry {
                lock: Arc::new(AsyncMutex::new(())),
                waiters: 0,
            });
            entry.waiters += 1;
            Arc::clone(&entry.lock)
        };
        let mut cleanup = WaiterCleanup {
            entries: Arc::clone(&self.entries),
            key: key.clone(),
            armed: true,
        };
        let permit = lock.lock_owned().await;
        cleanup.armed = false;
        let _guard = KeyGuard {
            _permit: permit,
            entries: Arc::clone(&self.entries),
            key,
        };
        operation().await
    }

    /// Number of currently tracked keys (for tests verifying idle cleanup).
    #[cfg(test)]
    fn active_keys(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::sync::{Notify, oneshot};

    use super::ForgeIntents;

    #[tokio::test]
    async fn same_key_operations_serialize_in_order_and_clean_up_when_settled() {
        let intents = ForgeIntents::new();
        let log = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let (tx1, rx1) = oneshot::channel::<()>();
        let started1 = Arc::new(Notify::new());

        let i1 = intents.clone();
        let l1 = Arc::clone(&log);
        let s1 = Arc::clone(&started1);
        let first = tokio::spawn(async move {
            i1.run("pr:1", || async move {
                l1.lock().unwrap().push("start-1");
                s1.notify_one();
                let _ = rx1.await;
                l1.lock().unwrap().push("end-1");
                1
            })
            .await
        });

        started1.notified().await;

        let i2 = intents.clone();
        let l2 = Arc::clone(&log);
        let second = tokio::spawn(async move {
            i2.run("pr:1", || async move {
                l2.lock().unwrap().push("start-2");
                l2.lock().unwrap().push("end-2");
                2
            })
            .await
        });

        tokio::task::yield_now().await;
        assert_eq!(*log.lock().unwrap(), vec!["start-1"]);
        let _ = tx1.send(());

        assert_eq!(first.await.unwrap(), 1);
        assert_eq!(second.await.unwrap(), 2);
        assert_eq!(
            *log.lock().unwrap(),
            vec!["start-1", "end-1", "start-2", "end-2"]
        );
        assert_eq!(intents.active_keys(), 0);
    }

    #[tokio::test]
    async fn independent_keys_run_concurrently() {
        let intents = ForgeIntents::new();
        let (tx_a, rx_a) = oneshot::channel::<()>();
        let entered_a = Arc::new(Notify::new());

        let ia = intents.clone();
        let ea = Arc::clone(&entered_a);
        let task_a = tokio::spawn(async move {
            ia.run("key-a", || async move {
                ea.notify_one();
                let _ = rx_a.await;
                "a"
            })
            .await
        });

        entered_a.notified().await;
        let b = intents.run("key-b", || async { "b" }).await;
        assert_eq!(b, "b");
        let _ = tx_a.send(());
        assert_eq!(task_a.await.unwrap(), "a");
        assert_eq!(intents.active_keys(), 0);
    }
}
