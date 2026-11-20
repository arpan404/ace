// SPDX-License-Identifier: Apache-2.0

//! Keeps the two halves of an FSEvents rename together.
//!
//! FSEvents reports a rename as two records with consecutive event ids, the old path first and the
//! new path one id later, but it can hand them over in separate deliveries, hundreds of
//! milliseconds apart and in either order. Reported as they come, one half could reach a caller in
//! one batch and the other in a later one, and an index would hold both names, or neither, in
//! between. Whichever half arrives first is held here until its partner has arrived, so both land
//! in one window. A name moved in from outside the root has no old path to wait for, and one moved
//! out has no new name, so the wait is bounded and a lone half is then reported alone.
//!
//! FSEvents keeps a path's flags for a while, so removing a name that was just renamed into place
//! arrives as one record flagged both renamed and removed. That record is a removal, not the old
//! half of another rename: when one of its events says the path was removed and none finds it on
//! disk, it is reported at once, with every later event of the same record. A real partner that
//! comes after it is then reported at once too, because its own partner has been seen, so an old
//! path still reaches the caller no later than the new name it moved to.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::batch::ChangeKind;
use crate::translate::Notice;

/// How long one half of a rename waits for the other.
pub(crate) const WAIT: Duration = Duration::from_secs(2);

/// How many recent rename ids are remembered: far more than arrive within [`WAIT`].
const REMEMBERED: usize = 4_096;

/// How many records reported as removals are remembered, for the events of each that follow.
const REMOVALS: usize = 256;

/// One half of a rename, waiting for the other.
#[derive(Debug)]
struct Waiting {
    id: u64,
    /// The event id of the half it waits for: one before a new name, one after an old path.
    partner: u64,
    notices: Vec<Notice>,
    until: Instant,
}

/// The rename records seen lately, and the halves waiting for their partners.
#[derive(Debug, Default)]
pub(crate) struct Pairs {
    seen: VecDeque<u64>,
    waiting: Vec<Waiting>,
    /// Records reported at once as removals: their remaining events are not held either.
    removals: VecDeque<u64>,
}

impl Pairs {
    /// Takes the notices of one rename record with event id `id`. Returns the notices to report
    /// now: nothing while this record waits for its partner, or this record's together with the
    /// partner that was waiting for it.
    pub(crate) fn take(&mut self, id: u64, notices: Vec<Notice>, now: Instant) -> Vec<Notice> {
        if !self.seen.contains(&id) {
            if self.seen.len() >= REMEMBERED {
                self.seen.pop_front();
            }
            self.seen.push_back(id);
        }
        if self.removals.contains(&id) {
            return notices;
        }
        if let Some(index) = self.waiting.iter().position(|waiting| waiting.id == id) {
            // Another event from the same record: it waits with the rest of it, unless it shows
            // the record is a removal.
            let waiting = &mut self.waiting[index];
            waiting.notices.extend(notices);
            if !is_a_removal(&waiting.notices) {
                return Vec::new();
            }
            let removal = self.waiting.swap_remove(index);
            self.remember_removal(id);
            return removal.notices;
        }
        // A record that names an entry there now is a new name, whose old path is the record
        // before it; any other is an old path, whose new name is the record after it.
        let partner = if names_a_new_entry(&notices) {
            id.wrapping_sub(1)
        } else {
            id.wrapping_add(1)
        };
        // This record may be the half another one was waiting for. A new name that is already
        // gone again looks like an old path, so the pair is also found from the waiting side.
        if let Some(index) = self
            .waiting
            .iter()
            .position(|waiting| waiting.partner == id || waiting.id == partner)
        {
            let mut ready = notices;
            ready.append(&mut self.waiting.swap_remove(index).notices);
            return ready;
        }
        if is_a_removal(&notices) {
            self.remember_removal(id);
            return notices;
        }
        if self.seen.contains(&partner) {
            return notices;
        }
        self.waiting.push(Waiting {
            id,
            partner,
            notices,
            until: now + WAIT,
        });
        Vec::new()
    }

    fn remember_removal(&mut self, id: u64) {
        if self.removals.len() >= REMOVALS {
            self.removals.pop_front();
        }
        self.removals.push_back(id);
    }

    /// When the next waiting half is due.
    pub(crate) fn next_due(&self) -> Option<Instant> {
        self.waiting.iter().map(|waiting| waiting.until).min()
    }

    /// The halves whose partner never came in time, reported now.
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

/// Whether a record's notices say its path was removed and is gone: a removal of a name that was
/// renamed lately, which has no partner to wait for.
fn is_a_removal(notices: &[Notice]) -> bool {
    notices.iter().all(|notice| notice.present.is_none())
        && notices
            .iter()
            .any(|notice| notice.change.kind == ChangeKind::Deleted && !notice.rename)
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

    /// The event a record's removed flag becomes, for a path that is gone.
    fn removed(path: &str) -> Notice {
        Notice {
            rename: false,
            ..notice(path, ChangeKind::Deleted, false)
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
    fn an_old_path_that_arrives_first_waits_for_its_new_name() {
        // Reported alone, the deletion could close a window before the new name arrives, and one
        // rename would reach the caller as two batches.
        let mut pairs = Pairs::default();
        let now = Instant::now();
        let old = vec![notice("docs/old", ChangeKind::Deleted, false)];
        assert!(
            pairs.take(10, old, now).is_empty(),
            "the new name is not here yet"
        );
        let later = now + Duration::from_millis(200);
        let new = vec![notice("trash", ChangeKind::Created, true)];
        assert_eq!(
            paths(&pairs.take(11, new, later)),
            vec!["trash", "docs/old"]
        );
        assert!(pairs.next_due().is_none());
    }

    #[test]
    fn a_name_moved_out_of_the_root_is_reported_after_the_wait() {
        let mut pairs = Pairs::default();
        let now = Instant::now();
        let old = vec![notice("gone", ChangeKind::Deleted, false)];
        assert!(pairs.take(40, old, now).is_empty());
        assert!(
            pairs
                .release_due(now + Duration::from_millis(10))
                .is_empty()
        );
        assert_eq!(pairs.next_due(), Some(now + WAIT));
        assert_eq!(paths(&pairs.release_due(now + WAIT)), vec!["gone"]);
    }

    #[test]
    fn a_rename_whose_new_name_is_already_gone_is_reported_together() {
        // Renamed and then removed before either record was read: neither half is on disk, and
        // the second still completes the first rather than waiting for a partner of its own.
        let mut pairs = Pairs::default();
        let now = Instant::now();
        assert!(
            pairs
                .take(50, vec![notice("a", ChangeKind::Deleted, false)], now)
                .is_empty()
        );
        assert_eq!(
            paths(&pairs.take(51, vec![notice("b", ChangeKind::Deleted, false)], now)),
            vec!["b", "a"]
        );
        assert!(pairs.next_due().is_none());
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

    #[test]
    fn removing_a_name_that_was_just_renamed_is_reported_at_once() {
        // FSEvents flags the removal renamed as well as removed, and its removed event comes
        // first: neither event waits for a partner.
        let mut pairs = Pairs::default();
        let now = Instant::now();
        assert_eq!(
            paths(&pairs.take(60, vec![removed("moved")], now)),
            vec!["moved"]
        );
        assert_eq!(
            paths(&pairs.take(60, vec![notice("moved", ChangeKind::Deleted, false)], now)),
            vec!["moved"]
        );
        assert!(pairs.next_due().is_none());
    }

    #[test]
    fn a_record_that_turns_out_to_be_a_removal_stops_waiting() {
        // Created, removed and renamed: the created event comes first and waits as an old path
        // would, until the removed event shows there is no rename to complete.
        let mut pairs = Pairs::default();
        let now = Instant::now();
        let created = Notice {
            rename: false,
            ..notice("brief", ChangeKind::Created, false)
        };
        assert!(pairs.take(70, vec![created], now).is_empty());
        assert_eq!(
            paths(&pairs.take(70, vec![removed("brief")], now)),
            vec!["brief", "brief"]
        );
        assert!(pairs.next_due().is_none());
        assert_eq!(
            pairs
                .take(70, vec![notice("brief", ChangeKind::Deleted, false)], now)
                .len(),
            1
        );
    }

    #[test]
    fn a_removed_old_path_still_completes_the_new_name_waiting_for_it() {
        let mut pairs = Pairs::default();
        let now = Instant::now();
        let new = vec![notice("trash", ChangeKind::Created, true)];
        assert!(pairs.take(81, new, now).is_empty());
        assert_eq!(
            paths(&pairs.take(80, vec![removed("docs/old")], now)),
            vec!["docs/old", "trash"]
        );
        assert!(pairs.next_due().is_none());
    }

    #[test]
    fn a_new_name_after_its_removed_old_path_is_reported_at_once() {
        // The old path went first, so the new name may follow it straight away: old before new.
        let mut pairs = Pairs::default();
        let now = Instant::now();
        assert_eq!(
            paths(&pairs.take(90, vec![removed("old")], now)),
            vec!["old"]
        );
        let new = vec![notice("new", ChangeKind::Created, true)];
        assert_eq!(paths(&pairs.take(91, new, now)), vec!["new"]);
        assert!(pairs.next_due().is_none());
    }
}
