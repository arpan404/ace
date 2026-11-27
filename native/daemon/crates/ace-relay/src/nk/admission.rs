// SPDX-License-Identifier: Apache-2.0
//! What an NK first message may cost the daemon before its client has confirmed (ADR 0155, step 2,
//! `apps/daemon/src/relay-nk/admission.ts`). In order, for every NK first message:
//!
//! 1. `arrive()`: the daemon-wide rate, before any decryption.
//! 2. `claim(device)`: the claimed device's rate, after decryption and before the credential.
//! 3. `suppress(ephemeral)`: an identical first message within 5 minutes is refused.
//! 4. `admit(device, expire)`: once the credential holds, the unconfirmed-session and attempt
//!    limits. The admitted session then holds bytes, replayed events and output under its own and
//!    the daemon-wide budgets until it confirms or closes; its deadline closes it.
//!
//! The clock and its timer are injected.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

mod session;

pub use session::{NkSession, Suppression};

/// A token bucket's rate (`admission.ts:37`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rate {
    pub per_second: f64,
    pub burst: f64,
}

/// Every limit (`NK_LIMITS`, `admission.ts:14`-`:29`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NkLimits {
    pub daemon_rate: Rate,
    pub device_rate: Rate,
    /// Claimed devices tracked for their rate; past it, a new id waits for one to go idle.
    pub tracked_devices: usize,
    pub suppress_ms: i64,
    pub suppress_entries: usize,
    pub sessions_per_device: usize,
    pub sessions: usize,
    pub attempts_per_device_per_minute: usize,
    pub session_bytes: usize,
    pub total_bytes: usize,
    pub session_events: usize,
    pub session_output: usize,
    pub confirm_ms: i64,
}

pub const NK_LIMITS: NkLimits = NkLimits {
    daemon_rate: Rate {
        per_second: 20.0,
        burst: 40.0,
    },
    device_rate: Rate {
        per_second: 2.0,
        burst: 4.0,
    },
    tracked_devices: 4096,
    suppress_ms: 5 * 60_000,
    suppress_entries: 4096,
    sessions_per_device: 2,
    sessions: 32,
    attempts_per_device_per_minute: 6,
    session_bytes: 8 * 1024 * 1024,
    total_bytes: 64 * 1024 * 1024,
    session_events: 2_000,
    session_output: 256 * 1024,
    confirm_ms: 5_000,
};

/// Cancels a scheduled run that hasn't happened yet.
pub type Cancel = Box<dyn FnOnce() + Send>;

/// The daemon's clock and timer, injected (`NkClock`, `admission.ts:32`).
pub trait NkClock: Send + Sync {
    fn now(&self) -> i64;
    /// Run `run` after `milliseconds`; the returned closure cancels it.
    fn schedule(&self, milliseconds: i64, run: Box<dyn FnOnce() + Send>) -> Cancel;
}

/// What a session may still reserve, or send (`NkSession::remaining`). `usize::MAX` stands for
/// the TypeScript's `Infinity` once confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Remaining {
    pub bytes: usize,
    pub events: usize,
    pub output: usize,
}

/// What unconfirmed sessions hold now, for tests and the daemon's checks (`admission.ts:174`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Held {
    pub sessions: usize,
    pub bytes: usize,
    pub suppressed: usize,
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: i64,
    rate: Rate,
}

impl Bucket {
    fn new(rate: Rate, now: i64) -> Self {
        Self {
            tokens: rate.burst,
            at: now,
            rate,
        }
    }

    fn refill(&mut self, now: i64) {
        let elapsed = (now - self.at).max(0) as f64;
        self.tokens = self
            .rate
            .burst
            .min(self.tokens + elapsed * self.rate.per_second / 1_000.0);
        self.at = now;
    }

    fn take(&mut self, now: i64) -> bool {
        self.refill(now);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }

    fn idle(&mut self, now: i64) -> bool {
        self.refill(now);
        self.tokens >= self.rate.burst
    }
}

struct State {
    daemon: Bucket,
    devices: Vec<(String, Bucket)>,
    /// An ephemeral key (hex) to when it may be seen again; insertion order, as all live as long.
    seen: Vec<(String, i64)>,
    attempts: HashMap<String, Vec<i64>>,
    open: Vec<(u64, String)>,
    bytes: usize,
    next: u64,
}

impl State {
    fn free(&self, limits: &NkLimits) -> usize {
        limits.total_bytes.saturating_sub(self.bytes)
    }

    fn take(&mut self, limits: &NkLimits, bytes: usize) -> bool {
        if self.bytes.saturating_add(bytes) > limits.total_bytes {
            return false;
        }
        self.bytes += bytes;
        true
    }

    /// A session releases what it held and stops counting among the open ones.
    fn give(&mut self, id: u64, bytes: usize) {
        self.bytes = self.bytes.saturating_sub(bytes);
        self.open.retain(|(each, _)| *each != id);
    }
}

/// What claiming an ephemeral key did (`admission.ts:126`).
#[derive(Debug)]
pub enum Suppressive {
    Claimed(Suppression),
    /// The same ephemeral key was seen within five minutes.
    Seen,
    /// The set is full: refused rather than forgetting an entry early.
    Full,
}

/// The daemon's NK admission (`NkAdmission`).
pub struct NkAdmission {
    clock: Arc<dyn NkClock>,
    limits: NkLimits,
    state: Arc<Mutex<State>>,
}

impl NkAdmission {
    pub fn new(clock: Arc<dyn NkClock>, limits: NkLimits) -> Self {
        let now = clock.now();
        Self {
            state: Arc::new(Mutex::new(State {
                daemon: Bucket::new(limits.daemon_rate, now),
                devices: Vec::new(),
                seen: Vec::new(),
                attempts: HashMap::new(),
                open: Vec::new(),
                bytes: 0,
                next: 0,
            })),
            clock,
            limits,
        }
    }

    pub fn with_default_limits(clock: Arc<dyn NkClock>) -> Self {
        Self::new(clock, NK_LIMITS)
    }

    pub fn limits(&self) -> NkLimits {
        self.limits
    }

    /// Step 1: may this first message be decrypted at all?
    pub fn arrive(&self) -> bool {
        let now = self.clock.now();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.daemon.take(now)
    }

    /// Step 2: the claimed device's own rate.
    pub fn claim(&self, device: &str) -> bool {
        let now = self.clock.now();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let limits = self.limits;
        let index = state.devices.iter().position(|(each, _)| each == device);
        let Some(index) = index else {
            if state.devices.len() >= limits.tracked_devices {
                let mut idle = Vec::new();
                for (index, (_, bucket)) in state.devices.iter_mut().enumerate() {
                    if bucket.idle(now) {
                        idle.push(index);
                    }
                }
                for index in idle.into_iter().rev() {
                    state.devices.remove(index);
                }
            }
            if state.devices.len() >= limits.tracked_devices {
                return false;
            }
            state
                .devices
                .push((device.to_owned(), Bucket::new(limits.device_rate, now)));
            let last = state.devices.len() - 1;
            return state.devices[last].1.take(now);
        };
        state.devices[index].1.take(now)
    }

    /// Step 3: claim a first message's ephemeral key, synchronously, so two copies racing can't
    /// both pass.
    pub fn suppress(&self, ephemeral: &[u8]) -> Suppressive {
        let now = self.clock.now();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.seen.retain(|(_, until)| *until > now);
        let key = data_encoding::HEXLOWER.encode(ephemeral);
        if state.seen.iter().any(|(each, _)| each == &key) {
            return Suppressive::Seen;
        }
        if state.seen.len() >= self.limits.suppress_entries {
            return Suppressive::Full;
        }
        state
            .seen
            .push((key.clone(), now + self.limits.suppress_ms));
        Suppressive::Claimed(Suppression::claim(Arc::clone(&self.state), key))
    }

    /// Step 4, once the credential holds: a session for `device`, or `None` when the device or the
    /// daemon has no room. `expire` runs if the client doesn't confirm in time; the session is
    /// closed by then.
    pub fn admit(&self, device: &str, expire: impl FnOnce() + Send + 'static) -> Option<NkSession> {
        let now = self.clock.now();
        let limits = self.limits;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let mut recent = state.attempts.remove(device).unwrap_or_default();
        recent.retain(|at| *at > now - 60_000);
        let unconfirmed = state.open.len();
        let mine = state.open.iter().filter(|(_, each)| each == device).count();
        if recent.len() >= limits.attempts_per_device_per_minute
            || mine >= limits.sessions_per_device
            || unconfirmed >= limits.sessions
        {
            if !recent.is_empty() {
                state.attempts.insert(device.to_owned(), recent);
            }
            return None;
        }
        recent.push(now);
        state.attempts.insert(device.to_owned(), recent);
        let id = state.next;
        state.next += 1;
        state.open.push((id, device.to_owned()));
        drop(state);

        let session = NkSession::open(id, device, limits, Arc::clone(&self.state));
        let weak = Arc::downgrade(&session.inner);
        let cancel = self.clock.schedule(
            limits.confirm_ms,
            Box::new(move || {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let session = NkSession { inner };
                // One step: a confirmation that landed first wins, and the channel keeps.
                if session.expire() {
                    expire();
                }
            }),
        );
        session.store_cancel(cancel);
        Some(session)
    }

    /// What unconfirmed sessions hold now.
    pub fn held(&self) -> Held {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        Held {
            sessions: state.open.len(),
            bytes: state.bytes,
            suppressed: state.seen.len(),
        }
    }
}

#[cfg(test)]
mod tests;
