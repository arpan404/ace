// SPDX-License-Identifier: Apache-2.0
//! Listener callbacks, run off the actor thread.
//!
//! A listener is user code: it may block, panic, or call back into the catalog. Running
//! it on the actor would let any of those stall or deadlock catalog state. One worker
//! thread drains the queue, so a listener that reads `list()` waits on the actor while
//! the actor stays free. Notifications are hints to re-read, so the queue is bounded and
//! overflow drops the hint rather than growing without limit.

use std::sync::Arc;
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};

use crate::catalog::ModelFilter;

type Listener = Arc<dyn Fn(ModelFilter) + Send + Sync>;

/// The most listener notifications waiting to run.
const NOTIFY_CAPACITY: usize = 1024;

pub(crate) struct NotifyLane {
    sender: Option<SyncSender<(Listener, ModelFilter)>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl NotifyLane {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = std::sync::mpsc::sync_channel(NOTIFY_CAPACITY);
        let worker = std::thread::Builder::new()
            .name("ace-model-catalog-listeners".to_owned())
            .spawn(move || run(receiver))
            .ok();
        Self {
            sender: Some(sender),
            worker,
        }
    }

    /// Queues one notification; a full queue drops it, never blocks the actor.
    pub(crate) fn notify(&self, listener: Listener, filter: ModelFilter) {
        let Some(sender) = &self.sender else {
            return;
        };
        match sender.try_send((listener, filter)) {
            Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
        }
    }

    /// Lets the worker finish what it accepted and joins it.
    pub(crate) fn shutdown(&mut self) {
        drop(self.sender.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn run(receiver: Receiver<(Listener, ModelFilter)>) {
    for (listener, filter) in receiver {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(filter)));
    }
}
