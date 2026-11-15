// SPDX-License-Identifier: Apache-2.0
//! Which privacy epoch a picture belongs to (docs/media/plan.md, "Recording privacy barrier"),
//! shared by the native producers (E1 on Windows, E2 on Linux). The daemon applies epochs at
//! moments the helper records on its capture clock; a picture takes the epoch in force at its
//! own capture time, however late it is read, encoded or sent again. Pure: times come in as
//! ticks of whatever monotonic clock the helper captures on.
//!
//! The rule errs toward private: an epoch the daemon doesn't mark is private, and a picture
//! whose capture time can't be told apart from a switch (a tie, or a timestamp coarser than the
//! clock) takes the private epoch among those that may have been in force.
use std::collections::VecDeque;

/// A privacy epoch, and whether pictures under it are private.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Epoch {
    pub id: u32,
    pub private: bool,
}
impl Epoch {
    /// An epoch the daemon didn't say the privacy of: private.
    pub fn unsaid(id: u32) -> Self {
        Self { id, private: true }
    }
}

/// When a picture was captured: every tick it may have been taken at (closed range).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptureTime {
    pub first: i64,
    pub last: i64,
}
impl CaptureTime {
    pub fn exact(ticks: i64) -> Self {
        Self {
            first: ticks,
            last: ticks,
        }
    }
    /// The ticks `t` whose `floor(t * 10^7 / frequency)` is `units`: the counter value a 100 ns
    /// timestamp was rounded down from (Windows' capture timestamps are 100 ns units, coarser
    /// than the counter on many machines).
    pub fn from_100ns(units: i64, frequency: i64) -> Self {
        if frequency <= 0 {
            return Self::exact(units);
        }
        let ceil = |numerator: i128| -> i64 {
            let denominator = 10_000_000i128;
            (numerator.div_euclid(denominator) + i128::from(numerator.rem_euclid(denominator) != 0))
                as i64
        };
        let f = i128::from(frequency);
        Self {
            first: ceil(i128::from(units) * f),
            last: ceil((i128::from(units) + 1) * f) - 1,
        }
    }
}

/// Epoch applications kept: far more than can happen within a picture's lifetime in a helper.
pub const KEPT: usize = 64;

/// When each epoch was applied, oldest first.
#[derive(Clone, Debug, Default)]
pub struct EpochLedger {
    applied: VecDeque<(i64, Epoch)>,
}

impl EpochLedger {
    /// `epoch` applies from `at`. The same epoch again changes nothing.
    pub fn apply(&mut self, at: i64, epoch: Epoch) {
        if self.applied.back().map(|(_, e)| *e) == Some(epoch) {
            return;
        }
        self.applied.push_back((at, epoch));
        if self.applied.len() > KEPT {
            self.applied.pop_front();
        }
    }

    /// The epoch of a picture captured at `when`. Every epoch that may have been in force
    /// during it is a candidate: the one before its first tick, and any applied within it (an
    /// application at exactly the picture's tick may have come either side of it). A private
    /// candidate wins, the earliest one; otherwise the latest. So a tie at a switch from private
    /// to clear stays private, and one at a switch to private is private already. 0 before any
    /// epoch was given.
    pub fn epoch_at(&self, when: CaptureTime) -> u32 {
        let before = self
            .applied
            .iter()
            .rev()
            .find(|(at, _)| *at < when.first)
            .map(|(_, epoch)| *epoch)
            .unwrap_or(Epoch {
                id: 0,
                private: false,
            });
        let within = self
            .applied
            .iter()
            .filter(|(at, _)| (when.first..=when.last).contains(at))
            .map(|(_, epoch)| *epoch);
        let candidates: Vec<Epoch> = std::iter::once(before).chain(within).collect();
        candidates
            .iter()
            .find(|epoch| epoch.private)
            .or(candidates.last())
            .map_or(0, |epoch| epoch.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIVATE: bool = true;
    const CLEAR: bool = false;

    /// Epoch 4 from tick 100, then epoch 5 from tick 300.
    fn switched(from: bool, to: bool) -> EpochLedger {
        let mut ledger = EpochLedger::default();
        ledger.apply(
            100,
            Epoch {
                id: 4,
                private: from,
            },
        );
        ledger.apply(300, Epoch { id: 5, private: to });
        ledger
    }

    #[test]
    fn private_to_clear_a_tie_at_the_switch_stays_private() {
        let ledger = switched(PRIVATE, CLEAR);
        assert_eq!(
            ledger.epoch_at(CaptureTime::exact(299)),
            4,
            "one tick before"
        );
        assert_eq!(
            ledger.epoch_at(CaptureTime::exact(300)),
            4,
            "exactly at: private wins"
        );
        assert_eq!(ledger.epoch_at(CaptureTime::exact(301)), 5, "just after");
    }

    #[test]
    fn clear_to_private_a_tie_at_the_switch_is_already_private() {
        let ledger = switched(CLEAR, PRIVATE);
        assert_eq!(
            ledger.epoch_at(CaptureTime::exact(299)),
            4,
            "one tick before"
        );
        assert_eq!(
            ledger.epoch_at(CaptureTime::exact(300)),
            5,
            "exactly at: private wins"
        );
        assert_eq!(ledger.epoch_at(CaptureTime::exact(301)), 5, "just after");
    }

    #[test]
    fn a_coarse_timestamp_that_may_fall_either_side_of_a_switch_to_clear_stays_private() {
        // A 24 MHz counter: one 100 ns unit spans 2.4 ticks, so frame time 125 (100 ns) is any
        // tick from 300 to 302, and the switch to clear at tick 301 may come after it.
        let mut ledger = EpochLedger::default();
        ledger.apply(
            100,
            Epoch {
                id: 4,
                private: PRIVATE,
            },
        );
        ledger.apply(
            301,
            Epoch {
                id: 5,
                private: CLEAR,
            },
        );
        let frame = CaptureTime::from_100ns(125, 24_000_000);
        assert_eq!((frame.first, frame.last), (300, 302));
        assert_eq!(ledger.epoch_at(frame), 4);
    }

    #[test]
    fn an_epoch_the_daemon_doesnt_mark_is_private() {
        let mut ledger = EpochLedger::default();
        ledger.apply(100, Epoch::unsaid(4));
        ledger.apply(
            300,
            Epoch {
                id: 5,
                private: CLEAR,
            },
        );
        assert_eq!(ledger.epoch_at(CaptureTime::exact(300)), 4);
    }

    #[test]
    fn before_any_epoch_a_picture_has_none() {
        let mut ledger = EpochLedger::default();
        assert_eq!(ledger.epoch_at(CaptureTime::exact(5)), 0);
        ledger.apply(
            10,
            Epoch {
                id: 2,
                private: CLEAR,
            },
        );
        assert_eq!(ledger.epoch_at(CaptureTime::exact(9)), 0);
        assert_eq!(ledger.epoch_at(CaptureTime::exact(11)), 2);
    }
}
