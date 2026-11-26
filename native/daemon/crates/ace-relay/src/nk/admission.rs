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
        if self.bytes + bytes > limits.total_bytes {
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

struct HeldState {
    confirmed: bool,
    closed: bool,
    bytes: usize,
    events: usize,
    output: usize,
    cancel: Option<Cancel>,
}

struct SessionInner {
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
            (held.cancel.take(), std::mem::take(&mut held.bytes))
        };
        if let Some(cancel) = cancel {
            cancel();
        }
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.give(self.id, bytes);
    }
}

/// One unconfirmed session's hold on the daemon (`NkSession`, `admission.ts:67`).
#[derive(Clone)]
pub struct NkSession {
    inner: Arc<SessionInner>,
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

    fn locked(&self) -> std::sync::MutexGuard<'_, HeldState> {
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
        if held.closed || held.bytes + bytes > self.inner.limits.session_bytes {
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
        if held.closed || held.events + count > self.inner.limits.session_events {
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
        if held.closed || held.output + bytes > self.inner.limits.session_output {
            return false;
        }
        held.output += bytes;
        true
    }

    /// The client confirmed: its limits lift and its reservations are given back.
    pub fn confirm(&self) {
        {
            let mut held = self.locked();
            if held.closed || held.confirmed {
                return;
            }
            held.confirmed = true;
        }
        self.inner.release();
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
        Suppressive::Claimed(Suppression {
            state: Arc::clone(&self.state),
            key,
            released: false,
        })
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

        let session = NkSession {
            inner: Arc::new(SessionInner {
                id,
                device: device.to_owned(),
                limits,
                state: Arc::clone(&self.state),
                held: Mutex::new(HeldState {
                    confirmed: false,
                    closed: false,
                    bytes: 0,
                    events: 0,
                    output: 0,
                    cancel: None,
                }),
            }),
        };
        let weak = Arc::downgrade(&session.inner);
        let cancel = self.clock.schedule(
            limits.confirm_ms,
            Box::new(move || {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                {
                    let held = inner.held.lock().unwrap_or_else(|error| error.into_inner());
                    if held.confirmed || held.closed {
                        return;
                    }
                }
                let session = NkSession { inner };
                session.close();
                expire();
            }),
        );
        {
            let mut held = session.locked();
            held.cancel = Some(cancel);
        }
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
mod tests {
    //! Ports `apps/daemon/src/relay-nk/admission.test.ts`.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::{Arc, Mutex};

    use super::{Held, NK_LIMITS, NkAdmission, NkLimits, NkSession, Suppressive};

    use crate::nk::tests_support::ManualClock;

    fn admission(limits: NkLimits) -> (Arc<ManualClock>, NkAdmission) {
        let clock = ManualClock::new();
        let admission = NkAdmission::new(clock.clone(), limits);
        (clock, admission)
    }

    fn with(apply: impl FnOnce(&mut NkLimits)) -> NkLimits {
        let mut limits = NK_LIMITS;
        apply(&mut limits);
        limits
    }

    fn key(n: u32) -> Vec<u8> {
        let mut bytes = vec![(n % 256) as u8; 32];
        bytes[0] = (n >> 8) as u8;
        bytes
    }

    #[test]
    fn the_daemon_decrypts_at_most_forty_first_messages_at_once_and_twenty_a_second_after_that() {
        let (clock, admission) = admission(NK_LIMITS);
        let mut taken = 0;
        for _ in 0..100 {
            if admission.arrive() {
                taken += 1;
            }
        }
        assert_eq!(taken, 40);
        clock.advance(1_000);
        taken = 0;
        for _ in 0..100 {
            if admission.arrive() {
                taken += 1;
            }
        }
        assert_eq!(taken, 20);
    }

    #[test]
    fn one_claimed_device_gets_four_at_once_and_two_a_second_without_using_anothers_room() {
        let (clock, admission) = admission(NK_LIMITS);
        let results: Vec<bool> = (0..10).map(|_| admission.claim("phone")).collect();
        assert_eq!(results.iter().filter(|taken| **taken).count(), 4);
        assert!(admission.claim("tablet"));
        clock.advance(1_000);
        assert_eq!(
            [
                admission.claim("phone"),
                admission.claim("phone"),
                admission.claim("phone")
            ],
            [true, true, false]
        );
    }

    #[test]
    fn a_flood_of_made_up_device_ids_cannot_grow_the_table_and_idle_ids_make_room() {
        let limits = with(|limits| limits.tracked_devices = 8);
        let (clock, admission) = admission(limits);
        for n in 0..8 {
            assert!(admission.claim(&format!("fake-{n}")));
        }
        assert!(!admission.claim("real"));
        // Once their buckets refill they are forgotten, and a new id is tracked.
        clock.advance(2_000);
        assert!(admission.claim("real"));
    }

    #[test]
    fn an_identical_first_message_is_refused_for_five_minutes_and_a_refused_key_is_given_back() {
        let limits = with(|limits| limits.suppress_entries = 3);
        let (clock, admission) = admission(limits);
        let first = admission.suppress(&key(1));
        assert!(matches!(first, Suppressive::Claimed(_)));
        assert!(matches!(admission.suppress(&key(1)), Suppressive::Seen));
        let Suppressive::Claimed(mut refused) = admission.suppress(&key(2)) else {
            panic!("expected a claim");
        };
        refused.release();
        assert!(matches!(
            admission.suppress(&key(2)),
            Suppressive::Claimed(_)
        ));
        assert!(matches!(
            admission.suppress(&key(3)),
            Suppressive::Claimed(_)
        ));
        // Full: refused, nothing forgotten early.
        assert!(matches!(admission.suppress(&key(4)), Suppressive::Full));
        assert!(matches!(admission.suppress(&key(1)), Suppressive::Seen));
        clock.advance(NK_LIMITS.suppress_ms);
        assert!(matches!(
            admission.suppress(&key(1)),
            Suppressive::Claimed(_)
        ));
        let held: Held = admission.held();
        assert_eq!(held.suppressed, 1);
    }

    #[test]
    fn a_device_holds_two_unconfirmed_sessions_and_the_daemon_thirty_two() {
        let (_clock, admission) = admission(NK_LIMITS);
        let first = admission.admit("phone", || {}).unwrap();
        let second = admission.admit("phone", || {}).unwrap();
        assert!(admission.admit("phone", || {}).is_none());
        first.confirm();
        // Confirmed sessions keep working with no limits, and no longer count.
        assert!(first.output(10 * 1024 * 1024));
        assert!(admission.admit("phone", || {}).is_some());
        let others: Vec<Option<NkSession>> = (0..40)
            .map(|n| admission.admit(&format!("device-{n}"), || {}))
            .collect();
        assert_eq!(others.iter().filter(|each| each.is_some()).count(), 30);
        for session in others.into_iter().flatten() {
            session.close();
        }
        assert!(admission.admit("device-x", || {}).is_some());
        let _ = second;
    }

    #[test]
    fn a_device_gets_at_most_six_nk_attempts_a_minute() {
        let (clock, admission) = admission(NK_LIMITS);
        for _ in 0..6 {
            admission.admit("phone", || {}).unwrap().confirm();
        }
        assert!(admission.admit("phone", || {}).is_none());
        clock.advance(60_001);
        assert!(admission.admit("phone", || {}).is_some());
    }

    #[test]
    fn an_unconfirmed_session_holds_at_most_eight_mib_and_all_of_them_sixty_four() {
        let (_clock, admission) = admission(NK_LIMITS);
        let mib = 1024 * 1024;
        let sessions: Vec<NkSession> = (0..9)
            .map(|n| admission.admit(&format!("d{n}"), || {}).unwrap())
            .collect();
        let first = &sessions[0];
        assert!(first.reserve_bytes(8 * mib));
        assert!(!first.reserve_bytes(1));
        for session in &sessions[1..8] {
            assert!(session.reserve_bytes(8 * mib));
        }
        assert_eq!(admission.held().bytes, 64 * mib);
        // The ninth has its own room but the daemon has none.
        assert!(!sessions[8].reserve_bytes(1));
        first.confirm();
        assert!(sessions[8].reserve_bytes(8 * mib));
        for session in &sessions {
            session.close();
        }
        assert_eq!(
            admission.held(),
            Held {
                sessions: 0,
                bytes: 0,
                suppressed: 0
            }
        );
    }

    #[test]
    fn an_unconfirmed_session_replays_at_most_two_thousand_events_and_sends_256_kib() {
        let (_clock, admission) = admission(NK_LIMITS);
        let session = admission.admit("phone", || {}).unwrap();
        assert!(session.reserve_events(1_500));
        assert!(!session.reserve_events(501));
        assert!(session.reserve_events(500));
        assert!(session.output(200 * 1024));
        assert!(!session.output(57 * 1024));
        assert!(session.output(56 * 1024));
        session.confirm();
        assert!(session.reserve_events(1_000_000));
        assert!(session.output(64 * 1024 * 1024));
    }

    #[test]
    fn a_session_that_does_not_confirm_in_five_seconds_is_closed_and_gives_everything_back() {
        let (clock, admission) = admission(NK_LIMITS);
        let expired = Arc::new(Mutex::new(Vec::new()));
        let late_expiry = Arc::clone(&expired);
        let late = admission
            .admit("phone", move || late_expiry.lock().unwrap().push("phone"))
            .unwrap();
        let prompt_expiry = Arc::clone(&expired);
        let prompt = admission
            .admit("tablet", move || {
                prompt_expiry.lock().unwrap().push("tablet")
            })
            .unwrap();
        late.reserve_bytes(1024);
        prompt.reserve_bytes(1024);
        clock.advance(4_000);
        prompt.confirm();
        clock.advance(1_000);
        assert_eq!(*expired.lock().unwrap(), vec!["phone"]);
        assert!(!late.reserve_bytes(1));
        assert!(prompt.output(1024 * 1024));
        assert_eq!(
            admission.held(),
            Held {
                sessions: 0,
                bytes: 0,
                suppressed: 0
            }
        );
        assert_eq!(clock.pending(), 0);
    }

    #[test]
    fn a_vanished_session_does_not_keep_the_daemons_bytes() {
        let (_clock, admission) = admission(NK_LIMITS);
        {
            let session = admission.admit("phone", || {}).unwrap();
            assert!(session.reserve_bytes(1024));
            session.close();
        }
        assert_eq!(admission.held().bytes, 0);
        assert_eq!(admission.held().sessions, 0);
    }
}
