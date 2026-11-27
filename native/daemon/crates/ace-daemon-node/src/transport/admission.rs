// SPDX-License-Identifier: Apache-2.0
//! The admission state machine (T1a.5): one phase per upgrade, every transition a
//! compare-and-swap, and `release` and `opened` reachable from exactly one
//! transition each. It lives beside the binding because those two transitions are
//! JavaScript calls; the machine itself has no napi and no I/O, so its rules are
//! tested alone.
//!
//! ```text
//! Pending ──accept──▶ Accepted ──checks pass──▶ Writing ──101 flushed──▶ Opened
//!    │                    │                        └──101 failed──▶ Released
//!    │                    └──failed checks, closing 503, client gone──▶ Released
//!    ├──refuse──▶ (gone: nothing is held)
//!    ├──admitTimeoutMs──▶ TimedOut ──a late accept──▶ Released
//!    └──gone, or the close deadline──▶ Abandoned ──a late accept──▶ Released
//! ```
//!
//! Only `Pending` can be abandoned or timed out, and only `Accepted` (the
//! reservation held while `ws`'s checks run) and `Writing` (the `101` is being
//! written, and the connection is past every deadline) can be released. Once a
//! reservation is `Writing`, only the connection's own release or `opened`
//! moves it.
//!
//! An upgrade's reservation and its phase are published under the rows lock in
//! one step, so a connection that goes away sees either nothing to release or a
//! reservation to release — never a phase without its reservation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// Where one upgrade stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Admitted, waiting for TypeScript's decision.
    Pending,
    /// Decided accept: the reservation is TypeScript's while the connection runs
    /// `ws`'s checks. A connection dropped here releases it.
    Accepted,
    /// Every check passed and the `101` is being written: no deadline may take
    /// the reservation away any more.
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
            Phase::Accepted => 1,
            Phase::Writing => 2,
            Phase::Opened => 3,
            Phase::Abandoned => 4,
            Phase::TimedOut => 5,
            Phase::Released => 6,
        }
    }
}

/// One upgrade. Its phase is the machine's one atomic, so a transition either
/// wins whole or does nothing; its reservation is stored under the rows lock
/// with the phase, never apart from it.
struct Entry {
    phase: AtomicU8,
    reservation: AtomicU64,
}

impl Entry {
    fn new() -> Self {
        Self {
            phase: AtomicU8::new(Phase::Pending.code()),
            reservation: AtomicU64::new(0),
        }
    }

    fn phase(&self) -> Phase {
        match self.phase.load(Ordering::Acquire) {
            0 => Phase::Pending,
            1 => Phase::Accepted,
            2 => Phase::Writing,
            3 => Phase::Opened,
            4 => Phase::Abandoned,
            5 => Phase::TimedOut,
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

/// What a settled or released upgrade gave back, and whether the close wait was
/// counting it as on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Held {
    pub reservation: u64,
    /// It had reached `Writing`, so the listener's close waits on it.
    pub writing: bool,
}

#[derive(Default)]
struct Rows {
    /// Every upgrade that is deciding, held, or has a late acceptance to
    /// release: id → entry.
    by_id: HashMap<u64, Arc<Entry>>,
    /// The reservations connections hold: reservation → the upgrade's id.
    held: HashMap<u64, u64>,
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

    /// The connection owns nothing more: a pending upgrade is abandoned (its
    /// late acceptance is still released by the decision task), and a held one
    /// is released. Exactly one of the two, whoever gets here first, and the
    /// reservation it held is never lost in between.
    pub fn settle(&self, id: u64) -> Option<Held> {
        let mut rows = self.rows();
        let entry = rows.by_id.get(&id).cloned()?;
        match entry.phase() {
            // Abandoned, not removed: the decision task may still hold an
            // acceptance whose reservation it must release.
            Phase::Pending => {
                entry.take(Phase::Pending, Phase::Abandoned);
                None
            }
            Phase::Accepted | Phase::Writing => {
                let phase = entry.phase();
                if !entry.take(phase, Phase::Released) {
                    return None;
                }
                let held = Held {
                    reservation: entry.reservation.load(Ordering::Acquire),
                    writing: phase == Phase::Writing,
                };
                rows.held.remove(&held.reservation);
                rows.by_id.remove(&id);
                Some(held)
            }
            Phase::Opened | Phase::Abandoned | Phase::TimedOut | Phase::Released => None,
        }
    }

    /// The decision was accept: the reservation is recorded and the upgrade
    /// became `Accepted` in one step under the rows lock, so a connection that
    /// goes away can neither miss the reservation nor release it twice. `false`
    /// once it was abandoned or timed out.
    pub fn accepted(&self, id: u64, reservation: u64) -> bool {
        let mut rows = self.rows();
        let Some(entry) = rows.by_id.get(&id).cloned() else {
            return false;
        };
        entry.reservation.store(reservation, Ordering::Release);
        if !entry.take(Phase::Pending, Phase::Accepted) {
            return false;
        }
        rows.held.insert(reservation, id);
        true
    }

    /// Every `ws` check passed and the `101` is about to be written: from here
    /// no deadline, disconnect or close may move the reservation. False when it
    /// was already released, and nothing may be written then.
    pub fn writing(&self, reservation: u64) -> bool {
        let rows = self.rows();
        let Some(id) = rows.held.get(&reservation).copied() else {
            return false;
        };
        let Some(entry) = rows.by_id.get(&id).cloned() else {
            return false;
        };
        entry.take(Phase::Accepted, Phase::Writing)
    }

    /// The connection released its reservation: a failed `ws` check, the closing
    /// `503`, a failed `101`, hyper's upgrade failing, or the connection being
    /// dropped after the accept. `Some` exactly once.
    pub fn released(&self, reservation: u64) -> Option<Held> {
        let mut rows = self.rows();
        let id = rows.held.get(&reservation).copied()?;
        let entry = rows.by_id.get(&id).cloned()?;
        // The connection may move to `Writing` in the same instant.
        loop {
            let phase = entry.phase();
            if !matches!(phase, Phase::Accepted | Phase::Writing) {
                return None;
            }
            if entry.take(phase, Phase::Released) {
                rows.held.remove(&reservation);
                rows.by_id.remove(&id);
                return Some(Held {
                    reservation,
                    writing: phase == Phase::Writing,
                });
            }
        }
    }

    /// The `101` was flushed and the socket is registered. `Some` exactly once:
    /// a reservation that was released never opens.
    pub fn opened(&self, reservation: u64) -> Option<Held> {
        let mut rows = self.rows();
        let id = rows.held.get(&reservation).copied()?;
        let entry = rows.by_id.get(&id).cloned()?;
        if !entry.take(Phase::Writing, Phase::Opened) {
            return None;
        }
        rows.held.remove(&reservation);
        rows.by_id.remove(&id);
        Some(Held {
            reservation,
            writing: false,
        })
    }

    /// An acceptance that arrived after `TimedOut` or `Abandoned`: its
    /// reservation is released at once and nothing else. `true` exactly once.
    pub fn released_late(&self, id: u64) -> bool {
        let mut rows = self.rows();
        let Some(entry) = rows.by_id.get(&id).cloned() else {
            return false;
        };
        let phase = entry.phase();
        if !matches!(phase, Phase::TimedOut | Phase::Abandoned) {
            return false;
        }
        if !entry.take(phase, Phase::Released) {
            return false;
        }
        rows.by_id.remove(&id);
        true
    }

    /// Nothing more can reach this upgrade: its decision was a refusal, or its
    /// promise settled. The entry goes; a held reservation never does.
    pub fn settled(&self, id: u64) {
        self.rows().by_id.remove(&id);
    }

    /// Shutdown ended this upgrade's decision task while it still waited: a
    /// still-pending acceptance is abandoned, never opened, and the row goes.
    /// A reservation the task never received is TypeScript's to drop at close.
    pub fn abandoned(&self, id: u64) {
        let _ = self.take(id, Phase::Pending, Phase::Abandoned);
        self.rows().by_id.remove(&id);
    }
}

#[cfg(test)]
mod tests;
