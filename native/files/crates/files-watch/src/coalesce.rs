// SPDX-License-Identifier: Apache-2.0

//! Windows over the event stream: one batch per quiet period.
//!
//! A window stays open while events keep arriving and closes `debounce` after the last of
//! them. More changes than `max_batch`, or an overflow signal from the backend, close it with
//! a rescan of the narrowest folder that holds them.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::batch::{Batch, Change, ChangeKind};
use crate::observed::{Flavour, Observed};

/// Collects events into windows and turns them into batches.
pub(crate) struct Coalescer {
    debounce: Duration,
    max_batch: usize,
    flavour: Flavour,
    paths: BTreeMap<String, Observed>,
    overflow: bool,
    last: Option<Instant>,
}

impl Coalescer {
    pub(crate) fn new(debounce: Duration, max_batch: usize, flavour: Flavour) -> Coalescer {
        Coalescer {
            debounce,
            max_batch,
            flavour,
            paths: BTreeMap::new(),
            overflow: false,
            last: None,
        }
    }

    /// Adds one event. Returns a batch when the window has to close now.
    pub(crate) fn push(&mut self, change: Change, now: Instant) -> Option<Batch> {
        self.last = Some(now);
        self.paths.entry(change.path).or_default().push(
            change.kind,
            change.directory,
            self.flavour,
        );
        if self.paths.len() > self.max_batch {
            return self.settle();
        }
        None
    }

    /// The backend lost events: the next settle closes with a rescan.
    ///
    /// The window is not closed here, because the events the backend still delivers are what
    /// makes the rescan's folder narrow.
    pub(crate) fn overflow(&mut self, now: Instant) {
        self.overflow = true;
        self.last = Some(now);
    }

    /// How long to wait for the next event, or `None` when the window is empty.
    pub(crate) fn wait(&self, now: Instant) -> Option<Duration> {
        match self.last {
            Some(last) => Some(
                self.debounce
                    .saturating_sub(now.saturating_duration_since(last)),
            ),
            None if self.overflow => Some(Duration::ZERO),
            None => None,
        }
    }

    /// Closes the window and returns what the sink should hear, if anything.
    pub(crate) fn settle(&mut self) -> Option<Batch> {
        let overflow = std::mem::take(&mut self.overflow);
        self.last = None;
        let paths = std::mem::take(&mut self.paths);
        let mut changes = Vec::with_capacity(paths.len());
        for (path, observed) in &paths {
            if let Some(change) = observed.change(path, self.flavour) {
                changes.push(change);
            }
        }
        if overflow || changes.len() > self.max_batch {
            return Some(Batch::Rescan {
                dir: narrowest_dir(changes.iter().map(folder)),
            });
        }
        if changes.is_empty() {
            None
        } else {
            Some(Batch::Changes(changes))
        }
    }
}

/// The folder a rescan has to cover for one change: a directory names itself, a file names
/// the folder holding it, and a deleted directory names its parent because it is gone.
fn folder(change: &Change) -> &str {
    if change.directory && change.kind != ChangeKind::Deleted {
        &change.path
    } else {
        change
            .path
            .rsplit_once('/')
            .map_or("", |(folder, _)| folder)
    }
}

/// The deepest folder holding every path, or `None` for the root.
fn narrowest_dir<'a>(folders: impl Iterator<Item = &'a str>) -> Option<String> {
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
    use crate::observed::Flavour;
    use std::time::{Duration, Instant};

    const DEBOUNCE: Duration = Duration::from_millis(75);

    fn change(path: &str, kind: ChangeKind) -> Change {
        Change {
            path: path.to_owned(),
            kind,
            directory: false,
        }
    }

    fn coalescer(max_batch: usize) -> Coalescer {
        Coalescer::new(DEBOUNCE, max_batch, Flavour::Exact)
    }

    fn changes_of(batch: Option<Batch>) -> Vec<Change> {
        match batch {
            Some(Batch::Changes(changes)) => changes,
            other => panic!("expected changes, got {other:?}"),
        }
    }

    #[test]
    fn the_window_closes_a_debounce_after_the_last_event() {
        let mut coalescer = coalescer(100);
        let start = Instant::now();
        coalescer.push(change("a.txt", ChangeKind::Modified), start);
        assert_eq!(coalescer.wait(start), Some(DEBOUNCE));
        let later = start + Duration::from_millis(50);
        coalescer.push(change("a.txt", ChangeKind::Modified), later);
        assert_eq!(coalescer.wait(later), Some(DEBOUNCE));
        assert_eq!(
            coalescer.wait(later + Duration::from_millis(10)),
            Some(Duration::from_millis(65))
        );
        assert_eq!(coalescer.wait(later + DEBOUNCE), Some(Duration::ZERO));
        assert_eq!(changes_of(coalescer.settle()).len(), 1);
        assert_eq!(coalescer.wait(Instant::now()), None);
    }

    #[test]
    fn changes_are_reported_sorted_by_path() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        for path in ["b.txt", "c/d.txt", "a.txt"] {
            coalescer.push(change(path, ChangeKind::Modified), now);
        }
        let changes = changes_of(coalescer.settle());
        let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "b.txt", "c/d.txt"]);
    }

    #[test]
    fn more_changes_than_max_batch_rescans_the_common_folder() {
        let mut coalescer = coalescer(2);
        let now = Instant::now();
        assert!(
            coalescer
                .push(change("burst/a", ChangeKind::Created), now)
                .is_none()
        );
        assert!(
            coalescer
                .push(change("burst/b", ChangeKind::Created), now)
                .is_none()
        );
        assert_eq!(
            coalescer.push(change("burst/c", ChangeKind::Created), now),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
    }

    #[test]
    fn changes_in_unrelated_folders_rescan_the_root() {
        let mut coalescer = coalescer(1);
        let now = Instant::now();
        coalescer.push(change("one/a.txt", ChangeKind::Created), now);
        assert_eq!(
            coalescer.push(change("two/b.txt", ChangeKind::Created), now),
            Some(Batch::Rescan { dir: None })
        );
    }

    #[test]
    fn overflow_rescans_the_folder_holding_the_pending_changes() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.push(change("src/a.txt", ChangeKind::Modified), now);
        coalescer.overflow(now);
        assert_eq!(
            coalescer.settle(),
            Some(Batch::Rescan {
                dir: Some("src".to_owned())
            })
        );
        assert_eq!(coalescer.wait(now), None);
    }

    #[test]
    fn overflow_without_changes_rescans_the_root() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.overflow(now);
        assert_eq!(coalescer.wait(now), Some(DEBOUNCE));
        assert_eq!(coalescer.settle(), Some(Batch::Rescan { dir: None }));
    }

    #[test]
    fn a_directory_being_listed_again_names_itself_as_the_rescan_folder() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.push(
            Change {
                path: "burst".to_owned(),
                kind: ChangeKind::Created,
                directory: true,
            },
            now,
        );
        coalescer.push(change("burst/a.txt", ChangeKind::Created), now);
        coalescer.overflow(now);
        assert_eq!(
            coalescer.settle(),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
    }
}
