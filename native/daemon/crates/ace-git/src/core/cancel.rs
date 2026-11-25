// SPDX-License-Identifier: Apache-2.0
//! One in-flight call's cancellation: a caller abort or a service close wakes
//! the call's waiters without losing the wakeup (G2a).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// Cancellation handle for one in-flight call (caller abort or service close).
#[derive(Default)]
pub struct CallCancel {
    aborted: AtomicBool,
    closed: AtomicBool,
    notify: Notify,
}

impl CallCancel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub async fn notified(&self) {
        self.notify.notified().await;
    }

    /// Resolves once the call is aborted or the service closed, registering
    /// before it reads either flag so the wakeup is never lost.
    pub async fn cancelled(&self) {
        crate::core::wake::wait_until(|| self.is_aborted() || self.is_closed(), &self.notify).await;
    }

    /// Resolves once the service closed. An abort alone does not.
    pub async fn closed(&self) {
        crate::core::wake::wait_until(|| self.is_closed(), &self.notify).await;
    }
}
