// SPDX-License-Identifier: Apache-2.0
//! The admission state machine (T1a.5): one phase per upgrade, every transition a
//! compare-and-swap, and `release` and `opened` reachable from exactly one
//! transition each. It lives beside the binding because those two transitions are
//! JavaScript calls; the machine itself has no napi and no I/O, so its rules are
//! tested alone.
//!
//! ```text
//! Pending ──accept──▶ Writing ──101 flushed──▶ Opened
//!    │                   ├──released (failed checks, closing 503, failed 101)──▶ Released
//!    │                   └──the connection ends: the transport releases it──▶ Released
//!    ├──refuse──▶ (gone: nothing is held)
//!    ├──admitTimeoutMs──▶ TimedOut ──a late accept──▶ Released
//!    └──gone, or the close deadline──▶ Abandoned ──a late accept──▶ Released
//! ```
//!
//! Only `Pending` can be abandoned or timed out: once a reservation is `Writing`
//! the connection owns it, so no deadline, disconnect or close can take it away,
//! and only the connection's own release or `opened` moves it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// Where one upgrade stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Admitted, waiting for TypeScript's decision.
    Pending,
    /// Decided accept: the reservation is TypeScript's, and the connection owns
    /// the next step (the `ws` checks, the `101`, then `opened` or a release).
    Writing,
    /// The `101` was flushed and the socket handed to JavaScript.
    Opened,
    /// The connection went away while pending: no answer was written.
    Abandoned,
    /// Admission's own deadline passed: admission answered `503`.
    TimedOut,
    /// The reservation went back to TypeScript.
    Released,
}

impl Phase {
    fn code(self) -> u8 {
        match self {
            Phase::Pending => 0,
            Phase::Writing => 1,
            Phase::Opened => 2,
            Phase::Abandoned => 3,
            Phase::TimedOut => 4,
            Phase::Released => 5,
        }
    }
}

/// One upgrade. Its phase is the machine's one atomic, so a transition either
/// wins whole or does nothing.
struct Entry {
    phase: AtomicU8,
}

impl Entry {
    fn new() -> Self {
        Self {
            phase: AtomicU8::new(Phase::Pending.code()),
        }
    }

    fn phase(&self) -> Phase {
        match self.phase.load(Ordering::Acquire) {
            0 => Phase::Pending,
            1 => Phase::Writing,
            2 => Phase::Opened,
            3 => Phase::Abandoned,
            4 => Phase::TimedOut,
            _ => Phase::Released,
        }
    }

    /// The one transition; `true` to exactly one caller.
    fn take(&self, from: Phase, to: Phase) -> bool {
        self.phase
            .compare_exchange(from.code(), to.code(), Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
}

#[derive(Default)]
struct Rows {
    /// Upgrades still deciding, or those whose late acceptance still has a
    /// reservation to release: id → entry.
    by_id: HashMap<u64, Arc<Entry>>,
    /// The reservations connections hold: reservation → entry.
    held: HashMap<u64, Arc<Entry>>,
}

/// Every upgrade's phase, and the reservations the connections hold.
pub struct Admission {
    rows: Mutex<Rows>,
    next: AtomicU64,
}

impl Default for Admission {
    fn default() -> Self {
        Self::new()
    }
}

impl Admission {
    pub fn new() -> Self {
        Self {
            rows: Mutex::new(Rows::default()),
            next: AtomicU64::new(1),
        }
    }

    fn rows(&self) -> MutexGuard<'_, Rows> {
        self.rows
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// A new upgrade waiting for its decision. The id names it to TypeScript.
    pub fn begin(&self) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.rows().by_id.insert(id, Arc::new(Entry::new()));
        id
    }

    fn take(&self, id: u64, from: Phase, to: Phase) -> bool {
        let entry = self.rows().by_id.get(&id).cloned();
        entry.is_some_and(|entry| entry.take(from, to))
    }

    /// Admission's deadline passed. `true` once: the connection owes the `503`,
    /// and from then on an acceptance is released, never opened.
    pub fn timed_out(&self, id: u64) -> bool {
        self.take(id, Phase::Pending, Phase::TimedOut)
    }

    /// The connection went away while pending. `true` once; nothing is written.
    pub fn abandoned(&self, id: u64) -> bool {
        self.take(id, Phase::Pending, Phase::Abandoned)
    }

    /// The decision was accept: the reservation is recorded and the connection
    /// owns the upgrade from here. `false` once it was abandoned or timed out.
    pub fn hand_over(&self, id: u64, reservation: u64) -> bool {
        let mut rows = self.rows();
        let Some(entry) = rows.by_id.get(&id).cloned() else {
            return false;
        };
        if !entry.take(Phase::Pending, Phase::Writing) {
            return false;
        }
        // Held reservations are looked up by their reservation from here on.
        rows.by_id.remove(&id);
        rows.held.insert(reservation, entry);
        true
    }

    /// The connection released its reservation: a failed `ws` check, the closing
    /// `503`, a failed `101`, or hyper's upgrade failing. `true` exactly once.
    pub fn released(&self, reservation: u64) -> bool {
        let mut rows = self.rows();
        let Some(entry) = rows.held.get(&reservation).cloned() else {
            return false;
        };
        if !entry.take(Phase::Writing, Phase::Released) {
            return false;
        }
        rows.held.remove(&reservation);
        true
    }

    /// The `101` was flushed and the socket is registered. `true` exactly once:
    /// a reservation that was released never opens.
    pub fn opened(&self, reservation: u64) -> bool {
        let mut rows = self.rows();
        let Some(entry) = rows.held.get(&reservation).cloned() else {
            return false;
        };
        if !entry.take(Phase::Writing, Phase::Opened) {
            return false;
        }
        rows.held.remove(&reservation);
        true
    }

    /// An acceptance that arrived after `TimedOut` or `Abandoned`: its
    /// reservation is released at once and nothing else. `true` exactly once.
    pub fn released_late(&self, id: u64) -> bool {
        let Some(entry) = self.rows().by_id.get(&id).cloned() else {
            return false;
        };
        let phase = entry.phase();
        if !matches!(phase, Phase::TimedOut | Phase::Abandoned) {
            return false;
        }
        entry.take(phase, Phase::Released)
    }

    /// Nothing more can reach this upgrade: its decision was a refusal, or its
    /// promise settled. The entry goes; a held reservation never does.
    pub fn settled(&self, id: u64) {
        self.rows().by_id.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use super::Admission;

    #[test]
    fn a_decision_racing_the_deadline_leaves_exactly_one_owner() {
        for _ in 0..64 {
            let admission = Arc::new(Admission::new());
            let id = admission.begin();
            let deciding = Arc::clone(&admission);
            let timing_out = Arc::clone(&admission);
            let (handed, timed_out) = thread::scope(|scope| {
                let handed = scope.spawn(move || deciding.hand_over(id, 4));
                let timed_out = scope.spawn(move || timing_out.timed_out(id));
                (handed.join().unwrap(), timed_out.join().unwrap())
            });
            assert_ne!(handed, timed_out, "exactly one transition wins the race");
            if handed {
                assert!(
                    !admission.released_late(id),
                    "a held upgrade is no late one"
                );
                assert!(admission.released(4), "the holder releases its reservation");
                assert!(!admission.released(4), "once");
            } else {
                assert!(!admission.released(4), "nothing was held");
                assert!(
                    admission.released_late(id),
                    "the late acceptance is released"
                );
                assert!(!admission.released_late(id), "once");
            }
        }
    }

    #[test]
    fn only_one_of_many_threads_releases_a_held_reservation() {
        let admission = Arc::new(Admission::new());
        let id = admission.begin();
        assert!(admission.hand_over(id, 21));
        let releases = thread::scope(|scope| {
            let threads: Vec<_> = (0..8)
                .map(|_| {
                    let admission = Arc::clone(&admission);
                    scope.spawn(move || admission.released(21))
                })
                .collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(|released| *released)
                .count()
        });
        assert_eq!(releases, 1, "release happens exactly once across threads");
        assert!(!admission.opened(21), "and the reservation never opens");
    }

    #[test]
    fn a_timeout_takes_an_upgrade_nobody_holds_and_nothing_else_can() {
        let admission = Admission::new();
        let id = admission.begin();
        assert!(admission.timed_out(id), "the deadline answers 503 once");
        assert!(
            !admission.timed_out(id),
            "a second deadline changes nothing"
        );
        assert!(
            !admission.hand_over(id, 7),
            "an acceptance after the deadline never becomes a held reservation"
        );
        assert!(
            !admission.abandoned(id),
            "a timed-out upgrade is no longer pending"
        );
        assert!(
            admission.released_late(id),
            "the late acceptance is released"
        );
        assert!(
            !admission.released_late(id),
            "and released exactly once, however often it is reported"
        );
    }

    #[test]
    fn a_held_reservation_is_released_exactly_once() {
        let admission = Admission::new();
        let id = admission.begin();
        assert!(admission.hand_over(id, 11));
        assert!(
            admission.released(11),
            "the connection's release is the one"
        );
        assert!(!admission.released(11), "and a repeat releases nothing");
        assert!(!admission.opened(11), "a released reservation never opens");
        assert!(
            !admission.hand_over(id, 12),
            "the upgrade was handed over already"
        );
    }

    #[test]
    fn an_opened_socket_is_never_released_afterwards() {
        let admission = Admission::new();
        let id = admission.begin();
        assert!(admission.hand_over(id, 3));
        assert!(admission.opened(3), "the flushed 101 registers one socket");
        assert!(!admission.opened(3), "and a repeated opened registers none");
        assert!(
            !admission.released(3),
            "a released reservation would double-release an open socket"
        );
    }

    #[test]
    fn a_deadline_cannot_abandon_or_time_out_a_held_reservation() {
        let admission = Admission::new();
        let id = admission.begin();
        assert!(admission.hand_over(id, 5));
        assert!(
            !admission.abandoned(id),
            "writing is past the close deadline"
        );
        assert!(!admission.timed_out(id), "and past admission's deadline");
        assert!(admission.opened(5), "only the connection moves it on");
    }

    #[test]
    fn a_connection_lost_while_pending_releases_a_late_acceptance_once() {
        let admission = Admission::new();
        let id = admission.begin();
        assert!(admission.abandoned(id), "the connection went away");
        assert!(
            !admission.hand_over(id, 9),
            "the acceptance arrives after nobody is listening"
        );
        assert!(
            admission.released_late(id),
            "so its reservation is released"
        );
        assert!(!admission.released_late(id));
        assert!(!admission.opened(9), "and nothing is ever opened");
    }

    #[test]
    fn a_refusal_holds_no_reservation_and_no_reservation_of_its_own_can_move() {
        let admission = Admission::new();
        let id = admission.begin();
        admission.settled(id);
        assert!(
            !admission.released(1),
            "a refused upgrade's reservation was never TypeScript's"
        );
        assert!(!admission.opened(1));
        assert!(!admission.released_late(id), "nothing is held to release");
        assert!(
            !admission.hand_over(id, 1),
            "a settled upgrade stays settled"
        );
    }
}
