// SPDX-License-Identifier: Apache-2.0

//! Keeps the two halves of an FSEvents rename together.
//!
//! FSEvents reports a rename as two records with consecutive event ids, the old path first and the
//! new path one id later, but it can hand them over in separate deliveries, hundreds of
//! milliseconds apart and in either order. Reported as they come, the new name could reach a
//! caller in one batch and the old path's deletion in a later one, and an index would hold both in
//! between. The new name's notices are held here until the record before it has arrived, so both
//! halves land in one window. A name moved in from outside the root has no first half to wait for,
//! so the wait is bounded.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::translate::Notice;

/// How long a rename's new name waits for its old path.
pub(crate) const WAIT: Duration = Duration::from_secs(2);

/// How many recent rename ids are remembered: far more than arrive within [`WAIT`].
const REMEMBERED: usize = 4_096;

/// One rename's new name, waiting for its first half.
#[derive(Debug)]
struct Waiting {
    id: u64,
    notices: Vec<Notice>,
    until: Instant,
}

/// The rename records seen lately, and the new names waiting for their partners.
#[derive(Debug, Default)]
pub(crate) struct Pairs {
    seen: VecDeque<u64>,
    waiting: Vec<Waiting>,
}

impl Pairs {
    /// Takes the notices of one rename record with event id `id`. Returns the notices to report
    /// now: this record's, unless it is a new name whose first half has not arrived, plus any new
    /// name that was waiting for this record.
    pub(crate) fn take(&mut self, id: u64, notices: Vec<Notice>, now: Instant) -> Vec<Notice> {
        if !self.seen.contains(&id) {
            if self.seen.len() >= REMEMBERED {
                self.seen.pop_front();
            }
            self.seen.push_back(id);
        }
        let mut ready = Vec::new();
        if let Some(waiting) = self.waiting.iter_mut().find(|waiting| waiting.id == id) {
            // Another event from the same record: it waits with the rest of it.
            waiting.notices.extend(notices);
        } else if names_a_new_entry(&notices) && !self.seen.contains(&id.wrapping_sub(1)) {
            self.waiting.push(Waiting {
                id,
                notices,
                until: now + WAIT,
            });
        } else {
            ready.extend(notices);
        }
        // This record may be the first half another one was waiting for.
        let partner = id.wrapping_add(1);
        if let Some(index) = self
            .waiting
            .iter()
            .position(|waiting| waiting.id == partner)
        {
            ready.extend(self.waiting.swap_remove(index).notices);
        }
        ready
    }

    /// When the next waiting name is due.
    pub(crate) fn next_due(&self) -> Option<Instant> {
        self.waiting.iter().map(|waiting| waiting.until).min()
    }

    /// The new names whose first half never came in time, reported now.
    pub(crate) fn release_due(&mut self, now: Instant) -> Vec<Notice> {
        let mut ready = Vec::new();
        self.waiting.retain_mut(|waiting| {
            if waiting.until <= now {
                ready.append(&mut waiting.notices);
                false
            } else {
                true
            }
        });
        ready
    }
}

/// Whether a record's notices name an entry that is there now: the new half of a rename.
fn names_a_new_entry(notices: &[Notice]) -> bool {
    notices.iter().any(|notice| notice.present.is_some())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{Pairs, WAIT};
    use crate::batch::{Change, ChangeKind};
    use crate::translate::Notice;

    fn notice(path: &str, kind: ChangeKind, present: bool) -> Notice {
        Notice {
            change: Change {
                path: path.to_owned(),
                kind,
                directory: true,
            },
            rename: true,
            present: present.then_some(true),
        }
    }

    fn paths(notices: &[Notice]) -> Vec<&str> {
        notices
            .iter()
            .map(|notice| notice.change.path.as_str())
            .collect()
    }

    #[test]
    fn a_new_name_that_arrives_first_waits_for_its_old_path() {
        let mut pairs = Pairs::default();
        let now = Instant::now();
        let new = vec![notice("trash", ChangeKind::Created, true)];
        assert!(
            pairs.take(11, new, now).is_empty(),
            "the old path is not here yet"
        );
        let old = vec![notice("docs/old", ChangeKind::Deleted, false)];
        assert_eq!(paths(&pairs.take(10, old, now)), vec!["docs/old", "trash"]);
        assert!(pairs.next_due().is_none());
    }

    #[test]
    fn a_new_name_whose_old_path_came_first_is_reported_at_once() {
        let mut pairs = Pairs::default();
        let now = Instant::now();
        let old = vec![notice("docs/old", ChangeKind::Deleted, false)];
        assert_eq!(paths(&pairs.take(10, old, now)), vec!["docs/old"]);
        let new = vec![notice("trash", ChangeKind::Created, true)];
        assert_eq!(paths(&pairs.take(11, new, now)), vec!["trash"]);
    }

    #[test]
    fn a_name_moved_in_from_outside_is_reported_after_the_wait() {
        let mut pairs = Pairs::default();
        let now = Instant::now();
        let new = vec![notice("arrived", ChangeKind::Created, true)];
        assert!(pairs.take(20, new, now).is_empty());
        assert!(
            pairs
                .release_due(now + Duration::from_millis(10))
                .is_empty()
        );
        assert_eq!(pairs.next_due(), Some(now + WAIT));
        assert_eq!(paths(&pairs.release_due(now + WAIT)), vec!["arrived"]);
    }

    #[test]
    fn every_event_of_a_waiting_record_waits_with_it() {
        let mut pairs = Pairs::default();
        let now = Instant::now();
        assert!(
            pairs
                .take(31, vec![notice("new", ChangeKind::Created, true)], now)
                .is_empty()
        );
        assert!(
            pairs
                .take(31, vec![notice("new", ChangeKind::Modified, true)], now)
                .is_empty()
        );
        assert_eq!(
            pairs
                .take(30, vec![notice("old", ChangeKind::Deleted, false)], now)
                .len(),
            3
        );
    }
}
