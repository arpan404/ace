// SPDX-License-Identifier: Apache-2.0
//! The shared host's read gate (E3.0c's `outputFlow`, as `host.ts:226`–`:234`
//! builds it): shared output pauses while any channel is out of room, and the
//! last resume resumes both pumps. It is its own lock, so the diverted
//! child's consumer answers a chunk without taking the host's state lock.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use ace_supervisor::divert::OutputControl;
use ace_supervisor::spawn::{Delivered, OutputStream};

/// The host's read gate: `outputFlow`'s `paused()`/`wait()` over the diverted
/// child's pumps (`host.ts:226`–`:234`). Shared output pauses while any
/// channel is out of room; a chunk is answered under the same lock that reads
/// the state, so a resume can't land between the check and the pause.
#[derive(Clone)]
pub struct HostGate {
    inner: Arc<Mutex<GateInner>>,
}

#[derive(Default)]
struct GateInner {
    paused: HashSet<u64>,
    control: Option<OutputControl>,
}

impl Default for HostGate {
    fn default() -> HostGate {
        HostGate {
            inner: Arc::new(Mutex::new(GateInner::default())),
        }
    }
}

impl HostGate {
    pub fn new() -> HostGate {
        HostGate::default()
    }

    /// The child's controls, once the spawn has made them.
    pub fn attach(&self, control: OutputControl) {
        self.lock().control = Some(control);
    }

    /// A tenant's `outputFlow` pause. The last channel's resume resumes both
    /// pumps; a pause needs no call because the next chunk is answered
    /// `taken(false)`.
    pub fn set_paused(&self, tenant: u64, paused: bool) {
        let mut inner = self.lock();
        if paused {
            inner.paused.insert(tenant);
            return;
        }
        inner.paused.remove(&tenant);
        if inner.paused.is_empty()
            && let Some(control) = &inner.control
        {
            control.resume(OutputStream::Stdout);
            control.resume(OutputStream::Stderr);
        }
    }

    /// Forget a tenant that is gone; a stale pause never blocks the others.
    pub fn release(&self, tenant: u64) {
        self.set_paused(tenant, false);
    }

    pub fn paused(&self) -> bool {
        !self.lock().paused.is_empty()
    }

    /// Answer one delivered chunk: `taken(true)` while every channel has room.
    pub fn answer(&self, delivered: Delivered) {
        let paused = !self.lock().paused.is_empty();
        delivered.taken(!paused);
    }

    fn lock(&self) -> MutexGuard<'_, GateInner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}
