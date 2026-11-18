// SPDX-License-Identifier: Apache-2.0

//! Windows over the event stream: one batch per quiet period.
//!
//! A window stays open while events keep arriving and closes `debounce` after the last of
//! them, or `max_wait` after the first, so a continuous stream of changes still reaches the
//! caller. More changes than `max_batch`, or an overflow from the backend, closes the window
//! with a single rescan of the narrowest folder that holds them.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::batch::{Batch, Change};
use crate::observed::{Observed, parent};
use crate::translate::Notice;

/// Collects events into windows and turns them into batches.
pub(crate) struct Coalescer {
    debounce: Duration,
    max_wait: Duration,
    max_batch: usize,
    paths: BTreeMap<String, Observed>,
    /// Set once the window is too big or the backend lost events: one rescan closes it.
    rescan: Option<Option<String>>,
    /// Folders named by overflow events, and whether one arrived without a folder.
    overflow: Vec<String>,
    overflow_unknown: bool,
    first: Option<Instant>,
    last: Option<Instant>,
    /// Whether anything arrived since the last settle, which is how a rescan tells a new
    /// burst from the tail of the one it already reported.
    activity: bool,
}

impl Coalescer {
    pub(crate) fn new(debounce: Duration, max_wait: Duration, max_batch: usize) -> Coalescer {
        Coalescer {
            debounce,
            max_wait,
            max_batch,
            paths: BTreeMap::new(),
            rescan: None,
            overflow: Vec::new(),
            overflow_unknown: false,
            first: None,
            last: None,
            activity: false,
        }
    }

    fn record(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.last = Some(now);
        self.activity = true;
    }

    /// Adds one event. Returns the rescan that closes the window when it has grown too big.
    pub(crate) fn push(&mut self, notice: Notice, now: Instant) -> Option<Batch> {
        self.record(now);
        let Notice {
            change,
            rename,
            present,
        } = notice;
        // Everything inside a folder already being rescanned is covered by that rescan.
        if let Some(dir) = &self.rescan
            && (dir.is_none() || under(&change.path, dir.as_deref().unwrap_or("")))
        {
            return None;
        }
        let path = change.path;
        let holds_a_change = self.holds_a_change(&path);
        let observed = self.paths.entry(path.clone()).or_default();
        observed.push(change.kind, change.directory, rename, present);
        if holds_a_change {
            observed.mark_directory();
        }
        // A path with news is a folder, and so is every ancestor already in the window.
        let mut folder = parent(&path);
        while !folder.is_empty() {
            if let Some(ancestor) = self.paths.get_mut(folder) {
                ancestor.mark_directory();
            }
            folder = parent(folder);
        }
        if self.rescan.is_none() && self.paths.len() > self.max_batch {
            let dir = self.narrowest();
            self.rescan = Some(dir.clone());
            self.paths.clear();
            return Some(Batch::Rescan { dir });
        }
        None
    }

    /// Whether the window already holds news about something inside `folder`.
    fn holds_a_change(&self, folder: &str) -> bool {
        let prefix = format!("{folder}/");
        self.paths
            .range(prefix.clone()..)
            .next()
            .is_some_and(|(path, _)| path.starts_with(&prefix))
    }

    /// The backend lost events. `dir` is the folder it named, if it named one.
    ///
    /// The window is not closed here, because the events the backend still delivers are what
    /// makes the rescan's folder narrow.
    pub(crate) fn overflow(&mut self, dir: Option<String>, now: Instant) -> Option<Batch> {
        self.record(now);
        match dir {
            Some(dir) => self.overflow.push(dir),
            None => self.overflow_unknown = true,
        }
        if self.rescan.is_some() {
            return None;
        }
        let dir = self.narrowest();
        self.rescan = Some(dir.clone());
        self.paths.clear();
        Some(Batch::Rescan { dir })
    }

    /// How long to wait for the next event, or `None` when the window is empty.
    pub(crate) fn wait(&self, now: Instant) -> Option<Duration> {
        let first = self.first?;
        let last = self.last.unwrap_or(first);
        let after_last = self
            .debounce
            .saturating_sub(now.saturating_duration_since(last));
        let after_first = self
            .max_wait
            .saturating_sub(now.saturating_duration_since(first));
        Some(after_last.min(after_first))
    }

    /// Closes the window and returns what the sink should hear, if anything.
    pub(crate) fn settle(
        &mut self,
        now: Instant,
        look: &dyn Fn(&str) -> Option<bool>,
    ) -> Option<Batch> {
        let rescanning = self.rescan.clone();
        let activity = std::mem::take(&mut self.activity);
        let overflowed = self.overflow_unknown;
        let overflowed_folders = std::mem::take(&mut self.overflow);
        let mut paths = std::mem::take(&mut self.paths);
        self.first = None;
        self.last = None;
        if rescanning.is_some() {
            if !activity {
                // The burst is over; the rescan was already sent when it started, and
                // whatever was kept from outside it reports now.
                self.rescan = None;
            } else {
                // Keep waiting: everything inside the rescanned folder is covered by the
                // rescan already sent, and anything outside it waits for the next window.
                if let Some(Some(dir)) = &rescanning {
                    paths.retain(|path, _| !under(path, dir));
                } else {
                    paths.clear();
                }
                self.paths = paths;
                self.first = Some(now);
                self.last = Some(now);
                return None;
            }
        }
        let _ = (overflowed, overflowed_folders);
        let mut changes = Vec::with_capacity(paths.len());
        for (path, observed) in &paths {
            if let Some(change) = observed.resolve(path, look) {
                changes.push(change);
            }
        }
        if changes.len() > self.max_batch {
            return Some(Batch::Rescan {
                dir: narrowest(changes.iter().map(scope)),
            });
        }
        if changes.is_empty() {
            None
        } else {
            Some(Batch::Changes(changes))
        }
    }

    fn narrowest(&self) -> Option<String> {
        narrowest(
            self.overflow.iter().map(String::as_str).chain(
                self.paths
                    .iter()
                    .map(|(path, observed)| observed.scope(path)),
            ),
        )
    }
}

/// The folder a change needs listed again.
fn scope(change: &Change) -> &str {
    if change.directory && change.kind != crate::batch::ChangeKind::Deleted {
        &change.path
    } else {
        parent(&change.path)
    }
}

fn under(path: &str, folder: &str) -> bool {
    path.len() > folder.len() && path.starts_with(folder) && path.as_bytes()[folder.len()] == b'/'
}

/// The deepest folder holding every path, or `None` for the root.
fn narrowest<'a>(folders: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut common: Option<Vec<&str>> = None;
    for folder in folders {
        let segments: Vec<&str> = if folder.is_empty() {
            Vec::new()
        } else {
            folder.split('/').collect()
        };
        common = Some(match common {
            None => segments,
            Some(current) => current
                .into_iter()
                .zip(segments)
                .take_while(|(left, right)| left == right)
                .map(|(segment, _)| segment)
                .collect(),
        });
    }
    let segments = common?;
    (!segments.is_empty()).then(|| segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::Coalescer;
    use crate::batch::{Batch, Change, ChangeKind};
    use crate::translate::Notice;
    use std::time::{Duration, Instant};

    const DEBOUNCE: Duration = Duration::from_millis(75);
    const MAX_WAIT: Duration = Duration::from_secs(1);

    fn notice(path: &str, kind: ChangeKind) -> Notice {
        Notice {
            change: Change {
                path: path.to_owned(),
                kind,
                directory: false,
            },
            rename: false,
            present: Some(false),
        }
    }

    fn coalescer(max_batch: usize) -> Coalescer {
        Coalescer::new(DEBOUNCE, MAX_WAIT, max_batch)
    }

    fn changes_of(batch: Option<Batch>) -> Vec<Change> {
        match batch {
            Some(Batch::Changes(changes)) => changes,
            other => panic!("expected changes, got {other:?}"),
        }
    }

    fn exists(_: &str) -> Option<bool> {
        Some(false)
    }

    fn gone(_: &str) -> Option<bool> {
        None
    }

    #[test]
    fn the_window_closes_a_debounce_after_the_last_event() {
        let mut coalescer = coalescer(100);
        let start = Instant::now();
        coalescer.push(notice("a.txt", ChangeKind::Modified), start);
        assert_eq!(coalescer.wait(start), Some(DEBOUNCE));
        let later = start + Duration::from_millis(50);
        coalescer.push(notice("a.txt", ChangeKind::Modified), later);
        assert_eq!(coalescer.wait(later), Some(DEBOUNCE));
        assert_eq!(
            coalescer.wait(later + Duration::from_millis(10)),
            Some(Duration::from_millis(65))
        );
        assert_eq!(
            changes_of(coalescer.settle(later + DEBOUNCE, &exists)).len(),
            1
        );
        assert_eq!(coalescer.wait(Instant::now()), None);
    }

    #[test]
    fn pushes_every_ten_milliseconds_settle_at_first_plus_max_wait() {
        let mut coalescer = coalescer(100_000);
        let start = Instant::now();
        let mut now = start;
        loop {
            coalescer.push(notice("hot.txt", ChangeKind::Modified), now);
            let remaining = coalescer.wait(now + Duration::from_millis(10));
            now += Duration::from_millis(10);
            if remaining == Some(Duration::ZERO) {
                break;
            }
        }
        assert_eq!(now.duration_since(start), MAX_WAIT);
        assert!(coalescer.settle(now, &exists).is_some());
    }

    #[test]
    fn changes_are_reported_sorted_by_path() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        for path in ["b.txt", "c/d.txt", "a.txt"] {
            coalescer.push(notice(path, ChangeKind::Modified), now);
        }
        let changes = changes_of(coalescer.settle(now, &exists));
        let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "b.txt", "c/d.txt"]);
    }

    #[test]
    fn a_burst_over_max_batch_is_one_rescan_and_stays_one() {
        let mut coalescer = coalescer(2);
        let start = Instant::now();
        let mut rescans = None;
        for index in 0..100 {
            let now = start + Duration::from_millis(index);
            rescans = coalescer
                .push(
                    notice(&format!("burst/file{index}"), ChangeKind::Created),
                    now,
                )
                .or(rescans);
        }
        assert_eq!(
            rescans,
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(2), &exists),
            None
        );
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(3), &exists),
            None
        );
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(3), &exists),
            None,
            "one rescan covers the whole burst"
        );
    }

    #[test]
    fn changes_outside_a_rescanned_folder_survive_it() {
        let mut coalescer = coalescer(1);
        let start = Instant::now();
        coalescer.push(notice("burst/a", ChangeKind::Created), start);
        assert_eq!(
            coalescer.push(notice("burst/b", ChangeKind::Created), start),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
        coalescer.push(notice("other/c", ChangeKind::Modified), start);
        assert_eq!(coalescer.settle(start, &exists), None);
        let changes = changes_of(coalescer.settle(start + Duration::from_secs(1), &exists));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "other/c");
    }

    #[test]
    fn an_overflow_naming_a_folder_rescans_that_folder() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.push(notice("src/a.txt", ChangeKind::Modified), now);
        assert_eq!(
            coalescer.overflow(Some("src".to_owned()), now),
            Some(Batch::Rescan {
                dir: Some("src".to_owned())
            })
        );
        assert_eq!(coalescer.settle(now, &exists), None);
    }

    #[test]
    fn an_overflow_without_a_folder_rescans_the_root() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        assert_eq!(
            coalescer.overflow(None, now),
            Some(Batch::Rescan { dir: None })
        );
        assert_eq!(coalescer.settle(now, &gone), None);
    }

    #[test]
    fn a_directory_being_listed_again_names_itself_as_the_rescan_folder() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.push(
            Notice {
                change: Change {
                    path: "burst".to_owned(),
                    kind: ChangeKind::Created,
                    directory: true,
                },
                rename: false,
                present: Some(true),
            },
            now,
        );
        coalescer.push(notice("burst/a.txt", ChangeKind::Created), now);
        assert_eq!(
            coalescer.overflow(Some("burst".to_owned()), now),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
    }

    #[test]
    fn a_creation_and_deletion_in_one_window_reports_nothing() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.push(
            Notice {
                change: Change {
                    path: "fleeting.txt".to_owned(),
                    kind: ChangeKind::Created,
                    directory: false,
                },
                rename: false,
                present: Some(false),
            },
            now,
        );
        coalescer.push(notice("fleeting.txt", ChangeKind::Deleted), now);
        assert_eq!(coalescer.settle(now, &gone), None);
    }

    #[test]
    fn a_deleted_folder_is_known_from_the_children_it_reported() {
        // Windows reports a deleted folder exactly like a deleted file. The children removed
        // first are the evidence that the path was a folder, in either order of arrival.
        for children_first in [true, false] {
            let mut coalescer = coalescer(100);
            let now = Instant::now();
            if children_first {
                coalescer.push(notice("gone/file.txt", ChangeKind::Deleted), now);
                coalescer.push(notice("gone", ChangeKind::Deleted), now);
            } else {
                coalescer.push(notice("gone", ChangeKind::Deleted), now);
                coalescer.push(notice("gone/file.txt", ChangeKind::Deleted), now);
            }
            let changes = changes_of(coalescer.settle(now, &gone));
            let folder = changes.iter().find(|change| change.path == "gone").unwrap();
            assert!(folder.directory, "children_first = {children_first}");
        }
    }
}
