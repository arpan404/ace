// SPDX-License-Identifier: Apache-2.0
//! Bounded delivery of callbacks that may reenter the catalog.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

type Callback = Box<dyn FnOnce() + Send>;
const NOTIFY_CAPACITY: usize = 1024;

pub(crate) struct NotifyLane {
    sender: mpsc::SyncSender<Callback>,
    stopped: Arc<AtomicBool>,
}

impl NotifyLane {
    pub(crate) fn new(name: &str, capacity: usize) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Callback>(capacity);
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                for callback in receiver {
                    if worker_stopped.load(Ordering::Acquire) {
                        break;
                    }
                    let _ = catch_unwind(AssertUnwindSafe(callback));
                }
            })?;
        Ok(Self { sender, stopped })
    }

    pub(crate) fn notifications() -> std::io::Result<Self> {
        Self::new("ace-model-catalog-listeners", NOTIFY_CAPACITY)
    }

    /// Notifications are hints to read the current state. Overflow drops the hint.
    pub(crate) fn submit(&self, callback: impl FnOnce() + Send + 'static) {
        let _ = self.sender.try_send(Box::new(callback));
    }
}

impl Drop for NotifyLane {
    fn drop(&mut self) {
        // A running callback may itself be waiting for close.
        self.stopped.store(true, Ordering::Release);
    }
}
