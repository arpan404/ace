// SPDX-License-Identifier: Apache-2.0
//! The hand-off between the actor, the spawner and the future's first poll.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

const QUEUED: u8 = 0;
const SUBMITTED: u8 = 1;
const RUNNING: u8 = 2;
const CANCELLED: u8 = 3;

#[derive(Clone, Default)]
pub(super) struct TaskControl(Arc<AtomicU8>);

impl TaskControl {
    pub(super) fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire) == CANCELLED
    }

    pub(super) fn submitted(&self) {
        let _ = self
            .0
            .compare_exchange(QUEUED, SUBMITTED, Ordering::AcqRel, Ordering::Acquire);
    }

    pub(super) fn start(&self) -> bool {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |state| {
                (state != CANCELLED).then_some(RUNNING)
            })
            .is_ok()
    }

    pub(super) fn cancel_unsubmitted(&self) -> bool {
        self.0
            .compare_exchange(QUEUED, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}
