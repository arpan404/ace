// SPDX-License-Identifier: Apache-2.0

//! Windows over the event stream: one batch per quiet period.
//!
//! A window stays open while events keep arriving and closes `debounce` after the last of
//! them, or `max_wait` after the first, so a continuous stream of changes still reaches the
//! caller. More changes than `max_batch`, or an overflow from the backend, turns the window
//! into one rescan of the narrowest folder that holds them; it is sent when the burst goes
//! quiet, so the walk it starts sees the finished tree. A change that arrives after that is
//! reported in the next window, and a fresh over-limit burst is a fresh rescan.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::batch::{Batch, Change};
use crate::observed::{Observed, parent};
use crate::translate::{Notice, Presence};

/// How many `max_wait` periods a burst may run before a checkpoint rescan, so a writer that
/// never stops cannot keep the tree stale forever.
const CHECKPOINT_PERIODS: u32 = 5;

/// The shortest interval between checkpoint rescans, whatever `max_wait` is: each one starts a
/// walk of the tree, and a short window must not turn a settling burst into a walk storm.
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(10);

/// Collects events into windows and turns them into batches.
pub(crate) struct Coalescer {
    debounce: Duration,
    max_wait: Duration,
    max_batch: usize,
    paths: BTreeMap<String, Observed>,
    /// Set once the window is over its limit or the backend lost events: the window closes with
    /// one rescan of the narrowest folder holding everything it heard, held as segments so a
    /// later change can widen it; empty means the root.
    ///
    /// The rescan waits for the burst to go quiet. A walk started while files are still landing
    /// would miss the rest, and the changes arriving meanwhile are covered by the same rescan.
    scope: Option<Vec<String>>,
    /// When the pending rescan last reached the caller: the burst began, or a checkpoint was
    /// sent. The next checkpoint is due `CHECKPOINT_PERIODS` windows after it.
    sent: Option<Instant>,
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
            scope: None,
            sent: None,
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

    /// Adds one event. A window over its limit, or one already rescanning, settles into the
    /// rescan instead of carrying the change.
    pub(crate) fn push(&mut self, notice: Notice, now: Instant) {
        self.record(now);
        let Notice {
            change,
            rename,
            present,
        } = notice;
        if self.scope.is_some() {
            self.widen(&change);
            return;
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
        if self.paths.len() > self.max_batch {
            self.begin_from_paths(now);
        }
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
    /// Nothing is sent yet: the changes still arriving are what make the rescan's folder narrow,
    /// and a walk started now would miss them.
    pub(crate) fn overflow(&mut self, dir: Option<String>, now: Instant) {
        self.record(now);
        let mut scope = match dir.as_deref() {
            Some(folder) => segments(folder),
            // Events lost with no folder named are only covered by a walk of the root.
            None => Vec::new(),
        };
        for (path, observed) in &self.paths {
            narrow(&mut scope, observed.scope(path));
        }
        if let Some(current) = &self.scope {
            scope = intersect(&scope, current);
        }
        self.paths.clear();
        self.scope = Some(scope);
        self.sent.get_or_insert(now);
    }

    /// The window holds more paths than a batch may carry: it closes with a rescan of the
    /// deepest folder that holds them all.
    fn begin_from_paths(&mut self, now: Instant) {
        let mut scope: Option<Vec<String>> = None;
        for (path, observed) in &self.paths {
            let folder = observed.scope(path);
            match &mut scope {
                Some(scope) => narrow(scope, folder),
                None => scope = Some(segments(folder)),
            }
        }
        let scope = scope.unwrap_or_default();
        self.paths.clear();
        self.scope = Some(scope);
        self.sent = Some(now);
    }

    /// A change arrived while the window is rescanning: the rescan now has to cover it too.
    fn widen(&mut self, change: &Change) {
        if let Some(scope) = &mut self.scope {
            narrow(scope, folder_of(change));
        }
    }

    /// How long a burst may stay dirty before a checkpoint rescan: five windows, but never
    /// sooner than the independent checkpoint interval.
    fn checkpoint(&self) -> Duration {
        CHECKPOINT_INTERVAL.max(self.max_wait.saturating_mul(CHECKPOINT_PERIODS))
    }

    /// Whether the window will close with a rescan. Everything that arrives until then is
    /// covered by it, so the worker can translate those events without asking the disk.
    pub(crate) fn is_rescanning(&self) -> bool {
        self.scope.is_some()
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
        look: &dyn Fn(&str) -> Presence,
    ) -> Option<Batch> {
        let activity = std::mem::take(&mut self.activity);
        if let Some(scope) = self.scope.clone() {
            if activity {
                // Still landing. Keep the true last-event time, so the quiet deadline is
                // measured from the last change; only the max_wait clock restarts, or the
                // worker would spin on a deadline that is already past.
                self.first = Some(now);
                let sent = self.sent.unwrap_or(now);
                if now.saturating_duration_since(sent) < self.checkpoint() {
                    return None;
                }
                // The burst has run long enough that a client must hear something before it
                // ends: report what the tree is now, and cover everything after it with the
                // final rescan (or another checkpoint).
                self.sent = Some(now);
                return Some(Batch::Rescan {
                    dir: (!scope.is_empty()).then(|| scope.join("/")),
                });
            }
            self.scope = None;
            self.sent = None;
            self.first = None;
            self.last = None;
            return Some(Batch::Rescan {
                dir: (!scope.is_empty()).then(|| scope.join("/")),
            });
        }
        let paths = std::mem::take(&mut self.paths);
        self.first = None;
        self.last = None;
        let mut changes = Vec::with_capacity(paths.len());
        for (path, observed) in &paths {
            if let Some(change) = observed.resolve(path, look) {
                changes.push(change);
            }
        }
        if changes.is_empty() {
            None
        } else {
            Some(Batch::Changes(changes))
        }
    }
}

/// The folder a change needs listed again.
fn folder_of(change: &Change) -> &str {
    if change.directory && change.kind != crate::batch::ChangeKind::Deleted {
        &change.path
    } else {
        parent(&change.path)
    }
}

/// The segments of a folder, empty for the root.
fn segments(folder: &str) -> Vec<String> {
    if folder.is_empty() {
        Vec::new()
    } else {
        folder.split('/').map(str::to_owned).collect()
    }
}

/// Narrows `scope` to the deepest folder holding it and `folder` as well.
fn narrow(scope: &mut Vec<String>, folder: &str) {
    if scope.is_empty() {
        // The root already holds everything.
        return;
    }
    if folder.is_empty() {
        scope.clear();
        return;
    }
    let common = scope
        .iter()
        .zip(folder.split('/'))
        .take_while(|(held, part)| held.as_str() == *part)
        .count();
    scope.truncate(common);
}

/// The deepest folder holding both scopes; empty when either is the root.
fn intersect(left: &[String], right: &[String]) -> Vec<String> {
    let common = left.iter().zip(right).take_while(|(a, b)| a == b).count();
    left[..common].to_vec()
}

#[cfg(test)]
mod tests {
    use super::Coalescer;
    use crate::batch::{Batch, Change, ChangeKind};
    use crate::translate::{Notice, Presence};
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

    fn exists(_: &str) -> Presence {
        Presence::Here(false)
    }

    fn gone(_: &str) -> Presence {
        Presence::Gone
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
    fn a_burst_over_max_batch_rescans_when_it_goes_quiet() {
        let mut coalescer = coalescer(2);
        let start = Instant::now();
        for index in 0..100 {
            let now = start + Duration::from_millis(index);
            coalescer.push(
                notice(&format!("burst/file{index}"), ChangeKind::Created),
                now,
            );
        }
        assert_eq!(
            coalescer.settle(start + Duration::from_millis(200), &exists),
            None,
            "the burst is still going in the watcher's queue"
        );
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(2), &exists),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(3), &exists),
            None,
            "one rescan covers the whole burst"
        );
    }

    #[test]
    fn a_burst_that_never_quiets_still_gets_checkpoint_rescans() {
        let mut coalescer = Coalescer::new(DEBOUNCE, MAX_WAIT, 2);
        let start = Instant::now();
        let mut rescans = Vec::new();
        let mut step = 0u64;
        loop {
            let now = start + Duration::from_millis(step * 10);
            if now.saturating_duration_since(start) > Duration::from_secs(25) {
                break;
            }
            // A writer that never pauses: one event every ten milliseconds, so the queue is
            // never empty when a max_wait boundary comes around. Two checkpoint intervals fit
            // in the simulated quarter minute.
            coalescer.push(
                notice(&format!("burst/file{step}"), ChangeKind::Created),
                now,
            );
            if coalescer.wait(now) == Some(Duration::ZERO)
                && let Some(batch) = coalescer.settle(now, &exists)
            {
                rescans.push(batch);
            }
            step += 1;
        }
        assert!(
            rescans.len() >= 2,
            "a dirty burst reports checkpoints before it quiets: {rescans:?}"
        );
        assert!(
            rescans.iter().all(|batch| matches!(
                batch,
                Batch::Rescan { dir: Some(dir) } if dir == "burst"
            )),
            "every checkpoint names the burst folder: {rescans:?}"
        );

        // The final rescan still follows once the writer stops.
        let quiet = start + Duration::from_secs(20);
        assert_eq!(
            coalescer.settle(quiet, &exists),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
        assert_eq!(
            coalescer.settle(quiet + Duration::from_secs(1), &exists),
            None,
            "the burst is over"
        );
    }

    #[test]
    fn a_change_after_the_rescan_starts_a_new_window() {
        let mut coalescer = coalescer(1);
        let start = Instant::now();
        coalescer.push(notice("burst/a", ChangeKind::Created), start);
        coalescer.push(notice("burst/b", ChangeKind::Created), start);
        assert_eq!(coalescer.settle(start, &exists), None);
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(1), &exists),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
        let later = start + Duration::from_secs(2);
        coalescer.push(notice("other/c", ChangeKind::Modified), later);
        let changes = changes_of(coalescer.settle(later + Duration::from_secs(1), &exists));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "other/c");
    }

    #[test]
    fn a_second_burst_after_a_rescan_is_a_second_rescan() {
        let mut coalescer = coalescer(1);
        let start = Instant::now();
        coalescer.push(notice("first/a", ChangeKind::Created), start);
        coalescer.push(notice("first/b", ChangeKind::Created), start);
        assert_eq!(coalescer.settle(start, &exists), None);
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(1), &exists),
            Some(Batch::Rescan {
                dir: Some("first".to_owned())
            })
        );
        let later = start + Duration::from_secs(2);
        coalescer.push(notice("second/a", ChangeKind::Created), later);
        coalescer.push(notice("second/b", ChangeKind::Created), later);
        assert_eq!(coalescer.settle(later, &exists), None);
        assert_eq!(
            coalescer.settle(later + Duration::from_secs(1), &exists),
            Some(Batch::Rescan {
                dir: Some("second".to_owned())
            })
        );
    }

    #[test]
    fn an_overflow_naming_a_folder_rescans_that_folder() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.push(notice("src/a.txt", ChangeKind::Modified), now);
        coalescer.overflow(Some("src".to_owned()), now);
        assert_eq!(coalescer.settle(now, &exists), None);
        assert_eq!(
            coalescer.settle(now + Duration::from_secs(1), &exists),
            Some(Batch::Rescan {
                dir: Some("src".to_owned())
            })
        );
    }

    #[test]
    fn an_overflow_without_a_folder_rescans_the_root() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.overflow(None, now);
        assert_eq!(coalescer.settle(now, &gone), None);
        assert_eq!(
            coalescer.settle(now + Duration::from_secs(1), &gone),
            Some(Batch::Rescan { dir: None })
        );
    }

    #[test]
    fn a_change_outside_an_overflowing_folder_widens_its_rescan() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.overflow(Some("src".to_owned()), now);
        coalescer.push(notice("docs/a.txt", ChangeKind::Modified), now);
        assert_eq!(coalescer.settle(now, &exists), None);
        assert_eq!(
            coalescer.settle(now + Duration::from_secs(1), &exists),
            Some(Batch::Rescan { dir: None }),
            "the root holds both folders"
        );
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
        coalescer.overflow(Some("burst".to_owned()), now);
        assert_eq!(coalescer.settle(now, &exists), None);
        assert_eq!(
            coalescer.settle(now + Duration::from_secs(1), &exists),
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
