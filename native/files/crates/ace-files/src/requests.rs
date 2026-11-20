// SPDX-License-Identifier: Apache-2.0

//! Per-request bookkeeping: the cancel flag every request carries and the body frame a write
//! waits for.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;
use tokio::sync::oneshot;

use crate::error::Error;
use crate::guard;

/// One request's cancel flag.
///
/// `cancel { id }` sets it from the dispatcher, and the op reads it: search and index builds check
/// it as they walk, and everything else checks it once before it answers. A cancelled request
/// answers `ABORTED`.
#[derive(Clone)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Cancel {
    fn new() -> Cancel {
        Cancel {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Whether the daemon gave up on this request.
    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }

    /// The flag itself, for code that can only take an `&AtomicBool` or has to share it with a
    /// subscription.
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }

    /// Resolve when the daemon cancels this request, or at once when it already did.
    ///
    /// `Notify::notify_waiters` only wakes waits that are already registered, so the flag is
    /// checked on both sides of registering.
    pub async fn wait(&self) {
        if self.cancelled() {
            return;
        }
        let notified = self.notify.notified();
        if self.cancelled() {
            return;
        }
        notified.await;
    }

    fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
        self.notify.notify_waiters();
    }
}

/// The requests that have started and not answered yet, by id.
#[derive(Default)]
pub struct InFlight {
    inner: Mutex<HashMap<u64, Cancel>>,
}

impl InFlight {
    /// Start a request: later `cancel` calls reach it.
    pub fn begin(&self, id: u64) -> Cancel {
        let cancel = Cancel::new();
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(id, cancel.clone());
        }
        cancel
    }

    /// Give up on a request. An id that has already answered, or never existed, is ignored: the
    /// response may still be on its way to the daemon.
    pub fn cancel(&self, id: u64) {
        let cancel = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.get(&id).cloned());
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
    }

    /// The request has answered, so its cancel flag is no longer reachable.
    pub fn finish(&self, id: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.remove(&id);
        }
    }
}

/// The body frames that have been asked for and not arrived yet, by request id.
///
/// A write registers its waiter as soon as the request is read, never later: the daemon sends the
/// body frame right behind the request, and both travel through the same pipe.
#[derive(Default)]
pub struct Bodies {
    inner: Mutex<HashMap<u64, oneshot::Sender<Vec<u8>>>>,
}

impl Bodies {
    /// Register the body frame `id` will carry and hand back the receiver that waits for it.
    pub fn wait(&self, id: u64) -> oneshot::Receiver<Vec<u8>> {
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(id, sender);
        }
        receiver
    }

    /// Hand bytes to the request waiting for them; false when nothing was waiting.
    pub fn deliver(&self, id: u64, bytes: Vec<u8>) -> bool {
        let sender = self
            .inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.remove(&id));
        match sender {
            Some(sender) => sender.send(bytes).is_ok(),
            None => false,
        }
    }

    /// Stop waiting: a body frame that arrives afterwards is reported, not kept.
    pub fn forget(&self, id: u64) -> Result<(), Error> {
        let mut inner = guard::lock(&self.inner)?;
        inner.remove(&id);
        Ok(())
    }
}
