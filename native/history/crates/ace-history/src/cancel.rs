// SPDX-License-Identifier: Apache-2.0

//! Cancellation: the daemon's `cancel` sets a flag the running operation polls between bounded
//! steps, as the worker's AbortSignal was checked.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Cancel {
        Cancel::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `signal.throwIfAborted()`.
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::Aborted)
        } else {
            Ok(())
        }
    }
}
