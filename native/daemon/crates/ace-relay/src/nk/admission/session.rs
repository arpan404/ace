// SPDX-License-Identifier: Apache-2.0
//! One unconfirmed session's hold on the daemon (`NkSession`, `admission.ts:67`): its own read,
//! event and output budgets, and the release that gives the daemon's bytes back.

use std::sync::{Arc, Mutex};

use super::{Cancel, NkLimits, Remaining, State};

pub(super) struct HeldState {
    confirmed: bool,
    closed: bool,
    /// Set once the session's byte hold was given back, so `Drop` cannot give it twice.
    released: bool,
    bytes: usize,
    events: usize,
    output: usize,
    cancel: Option<Cancel>,
}

pub(super) struct SessionInner {
    id: u64,
    device: String,
    limits: NkLimits,
    state: Arc<Mutex<State>>,
    held: Mutex<HeldState>,
}

impl SessionInner {
    fn release(&self) {
        let (cancel, bytes) = {
            let mut held = self.held.lock().unwrap_or_else(|error| error.into_inner());
            if held.released {
                return;
            }
            held.released = true;
            (held.cancel.take(), std::mem::take(&mut held.bytes))
        };
        if let Some(cancel) = cancel {
            cancel();
        }
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.give(self.id, bytes);
    }
}

impl Drop for SessionInner {
    /// A shell that drops its last handle without closing still gives the slot and bytes back,
    /// as the TypeScript's `#open` set (which holds the session) always does (`admission.ts:164`).
    fn drop(&mut self) {
        self.release();
    }
}

/// One unconfirmed session's hold on the daemon (`NkSession`, `admission.ts:67`).
#[derive(Clone)]
pub struct NkSession {
    pub(super) inner: Arc<SessionInner>,
}

impl NkSession {
    /// The session `admit` opens, before its deadline is scheduled.
    pub(super) fn open(id: u64, device: &str, limits: NkLimits, state: Arc<Mutex<State>>) -> Self {
        Self {
            inner: Arc::new(SessionInner {
                id,
                device: device.to_owned(),
                limits,
                state,
                held: Mutex::new(HeldState {
                    confirmed: false,
                    closed: false,
                    released: false,
                    bytes: 0,
                    events: 0,
                    output: 0,
                    cancel: None,
                }),
            }),
        }
    }

    /// Keeps the deadline's cancel so confirming or closing stops it. If the session already
    /// closed, confirmed or released (for instance a timer fired synchronously), cancel at once
    /// instead of holding onto the handle.
    pub(super) fn store_cancel(&self, cancel: Cancel) {
        let cancel_now = {
            let mut held = self.locked();
            if held.released || held.closed || held.confirmed {
                true
            } else {
                held.cancel = Some(cancel);
                return;
            }
        };
        if cancel_now {
            cancel();
        }
    }
}

impl NkSession {
    pub fn device(&self) -> &str {
        &self.inner.device
    }

    pub fn confirmed(&self) -> bool {
        self.locked().confirmed
    }

    pub fn closed(&self) -> bool {
        self.locked().closed
    }

    pub(super) fn locked(&self) -> std::sync::MutexGuard<'_, HeldState> {
        self.inner
            .held
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// What is left of the session's read, event and output budgets; unbounded once confirmed.
    pub fn remaining(&self) -> Remaining {
        let held = self.locked();
        if held.confirmed {
            return Remaining {
                bytes: usize::MAX,
                events: usize::MAX,
                output: usize::MAX,
            };
        }
        if held.closed {
            return Remaining {
                bytes: 0,
                events: 0,
                output: 0,
            };
        }
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Remaining {
            bytes: (self.inner.limits.session_bytes - held.bytes)
                .min(state.free(&self.inner.limits)),
            events: self.inner.limits.session_events - held.events,
            output: self.inner.limits.session_output - held.output,
        }
    }

    /// Reserves projection and snapshot bytes; false when that would go over, nothing reserved.
    pub fn reserve_bytes(&self, bytes: usize) -> bool {
        let mut held = self.locked();
        if held.confirmed {
            return true;
        }
        if held.closed || held.bytes.saturating_add(bytes) > self.inner.limits.session_bytes {
            return false;
        }
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !state.take(&self.inner.limits, bytes) {
            return false;
        }
        held.bytes += bytes;
        true
    }

    /// Reserves replayed events; false when that would go over, nothing reserved.
    pub fn reserve_events(&self, count: usize) -> bool {
        let mut held = self.locked();
        if held.confirmed {
            return true;
        }
        if held.closed || held.events.saturating_add(count) > self.inner.limits.session_events {
            return false;
        }
        held.events += count;
        true
    }

    /// Counts output queued or sent; false once this would go past the session's output budget.
    pub fn output(&self, bytes: usize) -> bool {
        let mut held = self.locked();
        if held.confirmed {
            return true;
        }
        if held.closed || held.output.saturating_add(bytes) > self.inner.limits.session_output {
            return false;
        }
        held.output += bytes;
        true
    }

    /// The client confirmed: its limits lift and its reservations are given back. The check and
    /// the transition are one step under the state's lock, so a deadline that ran first always
    /// wins and a confirmation that ran first can never be closed by it. False means the deadline
    /// already closed the session, and no device effect may run.
    pub fn confirm(&self) -> bool {
        {
            let mut held = self.locked();
            if held.closed {
                return false;
            }
            if held.confirmed {
                return true;
            }
            held.confirmed = true;
        }
        self.inner.release();
        true
    }

    /// The deadline ran: end the session unless the client confirmed or it already ended, in the
    /// same step. True when this call ended it, so only then do the channel and its effects close.
    pub(super) fn expire(&self) -> bool {
        {
            let mut held = self.locked();
            if held.closed || held.confirmed {
                return false;
            }
            held.closed = true;
        }
        self.inner.release();
        true
    }

    /// Ends the session and gives back everything it held. Idempotent.
    pub fn close(&self) {
        let confirmed = {
            let mut held = self.locked();
            if held.closed {
                return;
            }
            held.closed = true;
            held.confirmed
        };
        if !confirmed {
            self.inner.release();
        }
    }
}

/// A first message's claim on its ephemeral key (`admission.ts:126`).
pub struct Suppression {
    state: Arc<Mutex<State>>,
    key: String,
    released: bool,
}

impl std::fmt::Debug for Suppression {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Suppression")
            .field("released", &self.released)
            .finish_non_exhaustive()
    }
}

impl Suppression {
    /// The claim `admit` takes before the credential is checked.
    pub(super) fn claim(state: Arc<Mutex<State>>, key: String) -> Self {
        Self {
            state,
            key,
            released: false,
        }
    }

    /// Gives the key back: the attempt it belonged to was refused later.
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.seen.retain(|(key, _)| key != &self.key);
    }
}
