// SPDX-License-Identifier: Apache-2.0

//! Windows over the event stream: one batch per quiet period.
//!
//! A window stays open while events keep arriving and closes `debounce` after the last of
//! them, or `max_wait` after the first, so a continuous stream of changes still reaches the
//! caller. More changes than `max_batch`, or an overflow from the backend, turns the window
//! into one rescan of the narrowest folder that holds them; it is sent when the burst goes
//! quiet, so the walk it starts sees the finished tree. A change that arrives after that is
//! reported in the next window, and a fresh over-limit burst is a fresh rescan.
//!
//! A folder that keeps changing across several windows is walked once too. A backend may hand a
//! burst over in chunks smaller than `max_batch`, and may lose some of them without saying so, so
//! a burst that is replayed change by change depends on every one of them arriving. Past
//! `BURST_LIMIT` changes in one folder inside `BURST_WINDOW` the window becomes a rescan of that
//! folder instead: one walk finds what the events described, whatever the backend managed to
//! deliver.

use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

use crate::batch::{Batch, Change};
use crate::observed::{Observed, parent};
use crate::translate::{Notice, Reader};

/// How many `max_wait` periods a burst may run before a checkpoint rescan, so a writer that
/// never stops cannot keep the tree stale forever.
const CHECKPOINT_PERIODS: u32 = 5;

/// The shortest interval between checkpoint rescans, whatever `max_wait` is: each one starts a
/// walk of the tree, and a short window must not turn a settling burst into a walk storm.
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(10);

/// How many changes one folder may report inside [`BURST_WINDOW`] before the window becomes a
/// rescan of that folder. Ordinary editing is far below this; a checkout, a formatter or a burst
/// of generated files is far above it.
const BURST_LIMIT: usize = 500;

/// How far back the changes counted against [`BURST_LIMIT`] reach.
const BURST_WINDOW: Duration = Duration::from_secs(5);

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
    /// Changes per folder since that folder's first change inside [`BURST_WINDOW`], so a burst
    /// that arrives in chunks smaller than `max_batch` still becomes one walk.
    bursts: BTreeMap<String, (Instant, usize)>,
    /// When each count in `bursts` started, oldest first, so expired counts are dropped as time
    /// passes at a cost proportional to the folders that changed, not to all those ever counted.
    started: VecDeque<(Instant, String)>,
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
            bursts: BTreeMap::new(),
            started: VecDeque::new(),
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
        let folder_with_news = folder_of(&change).to_owned();
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
            return;
        }
        self.count_burst(&folder_with_news, now);
    }

    /// Adds what a check of the open folders found.
    ///
    /// The check runs on its own clock and often finds what an event in this window already
    /// described. Those facts join the path's record without restarting the quiet period: the
    /// window closes when the events go quiet, and the disk decides the change then either way.
    /// Anything the window does not hold yet is pushed as news.
    pub(crate) fn push_found(&mut self, notice: Notice, now: Instant) {
        if self.scope.is_none()
            && let Some(observed) = self.paths.get_mut(&notice.change.path)
        {
            let Notice {
                change,
                rename,
                present,
            } = notice;
            observed.push(change.kind, change.directory, rename, present);
            return;
        }
        self.push(notice, now);
    }

    /// Turns a folder that keeps changing into one rescan of itself.
    ///
    /// The window is already over what one folder can reasonably re-report change by change, even
    /// though each window stayed under `max_batch`: a backend handing a burst over in chunks, or
    /// losing some of them, would leave the tree short of what happened. A walk of that folder
    /// finds the truth instead of trusting the events.
    fn count_burst(&mut self, folder: &str, now: Instant) {
        self.forget_bursts(now);
        let entry = self.bursts.entry(folder.to_owned()).or_insert((now, 0));
        if entry.1 == 0 || now.saturating_duration_since(entry.0) > BURST_WINDOW {
            *entry = (now, 0);
            self.started.push_back((now, folder.to_owned()));
        }
        entry.1 += 1;
        if entry.1 > BURST_LIMIT {
            self.begin_from_paths(now);
        }
    }

    /// Drops the counts whose burst window has passed.
    fn forget_bursts(&mut self, now: Instant) {
        while let Some((start, _)) = self.started.front()
            && now.saturating_duration_since(*start) > BURST_WINDOW
        {
            let Some((start, folder)) = self.started.pop_front() else {
                break;
            };
            // A count restarted since has a later entry of its own.
            if self.bursts.get(&folder).is_some_and(|(at, _)| *at == start) {
                self.bursts.remove(&folder);
            }
        }
    }

    /// Forgets every burst count: a rescan covers what they counted.
    fn clear_bursts(&mut self) {
        self.bursts.clear();
        self.started.clear();
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

    /// How many folders' burst counts are kept.
    #[cfg(test)]
    fn counted_folders(&self) -> usize {
        self.bursts.len()
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
    pub(crate) fn settle(&mut self, now: Instant, reader: &mut impl Reader) -> Option<Batch> {
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
                self.clear_bursts();
                return Some(Batch::Rescan {
                    dir: (!scope.is_empty()).then(|| scope.join("/")),
                });
            }
            self.scope = None;
            self.sent = None;
            self.first = None;
            self.last = None;
            self.clear_bursts();
            return Some(Batch::Rescan {
                dir: (!scope.is_empty()).then(|| scope.join("/")),
            });
        }
        self.forget_bursts(now);
        let paths = std::mem::take(&mut self.paths);
        self.first = None;
        self.last = None;
        let mut changes = Vec::with_capacity(paths.len());
        for (path, observed) in &paths {
            if observed.renamed() {
                // A rename in this window changed the names the folder stores, and the window may
                // have read them before it: the stored spelling that decides this change has to
                // be read now.
                reader.renamed(path);
            }
            if let Some(change) = observed.resolve(path, reader) {
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
    use crate::translate::{Notice, Presence, Reader};
    use std::time::{Duration, Instant};

    const DEBOUNCE: Duration = Duration::from_millis(75);
    const MAX_WAIT: Duration = Duration::from_secs(1);

    /// A notice the backend described as a rename.
    fn renamed(path: &str, kind: ChangeKind) -> Notice {
        let mut notice = notice(path, kind);
        notice.rename = true;
        notice
    }

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

    /// A tree where every path is there and is not a folder.
    struct Exists;

    impl Reader for Exists {
        fn presence(&mut self, _path: &str) -> Presence {
            Presence::Here(false)
        }

        fn renamed(&mut self, _path: &str) {}
    }

    /// A tree where every path is gone.
    struct Gone;

    impl Reader for Gone {
        fn presence(&mut self, _path: &str) -> Presence {
            Presence::Gone
        }

        fn renamed(&mut self, _path: &str) {}
    }

    /// A tree where every path is there, with the folders whose stored names were announced as
    /// changed by a rename.
    struct Renames {
        announced: Vec<String>,
    }

    impl Reader for Renames {
        fn presence(&mut self, _path: &str) -> Presence {
            Presence::Here(false)
        }

        fn renamed(&mut self, path: &str) {
            self.announced.push(path.to_owned());
        }
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
            changes_of(coalescer.settle(later + DEBOUNCE, &mut Exists)).len(),
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
        assert!(coalescer.settle(now, &mut Exists).is_some());
    }

    #[test]
    fn changes_are_reported_sorted_by_path() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        for path in ["b.txt", "c/d.txt", "a.txt"] {
            coalescer.push(notice(path, ChangeKind::Modified), now);
        }
        let changes = changes_of(coalescer.settle(now, &mut Exists));
        let paths: Vec<&str> = changes.iter().map(|change| change.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "b.txt", "c/d.txt"]);
    }

    #[test]
    fn a_burst_over_max_batch_rescans_once_when_it_goes_quiet() {
        let mut coalescer = coalescer(2);
        let start = Instant::now();
        for index in 0..100 {
            let now = start + Duration::from_millis(index);
            coalescer.push(
                notice(&format!("burst/file{index}"), ChangeKind::Created),
                now,
            );
        }
        // One window sends at most one rescan: it covers everything that arrived until it was
        // sent, so a second one would report the same window twice however often it is asked.
        let mut rescans = Vec::new();
        for at in [200u64, 2_000, 3_000, 4_000, 5_000] {
            if let Some(batch) = coalescer.settle(start + Duration::from_millis(at), &mut Exists) {
                rescans.push(batch);
            }
        }
        assert_eq!(
            rescans,
            [Batch::Rescan {
                dir: Some("burst".to_owned())
            }],
            "the burst reaches the caller as one rescan of its folder"
        );
    }

    #[test]
    fn a_folder_that_keeps_changing_becomes_one_rescan() {
        // A backend may hand a burst over in chunks smaller than max_batch, and may lose some of
        // them: past the burst limit a folder is walked once instead of being replayed change by
        // change, so the tree ends up right whatever arrived.
        let mut coalescer = Coalescer::new(DEBOUNCE, MAX_WAIT, 1_000_000);
        let start = Instant::now();
        for window in 0..3 {
            for index in 0..300 {
                coalescer.push(
                    notice(
                        &format!("many/file{}", window * 300 + index),
                        ChangeKind::Created,
                    ),
                    start,
                );
            }
            let settled = coalescer.settle(
                start + Duration::from_millis(window as u64 + 1),
                &mut Exists,
            );
            if window == 0 {
                assert!(
                    matches!(settled, Some(Batch::Changes(_))),
                    "a window under the burst limit is replayed: {settled:?}"
                );
            } else {
                assert_eq!(
                    settled, None,
                    "past the limit the window is a rescan, held until the burst is quiet"
                );
            }
        }
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(2), &mut Exists),
            Some(Batch::Rescan {
                dir: Some("many".to_owned())
            }),
            "the folder is walked once instead"
        );
    }

    #[test]
    fn a_rename_announces_every_path_it_touched() {
        // A rename changes the names both folders store, and the window may have read them before
        // the rename: settlement is told about every path the rename touched, so the stored
        // spelling is read again rather than matched against a name that is gone.
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.push(renamed("d/Readme.txt", ChangeKind::Deleted), now);
        coalescer.push(renamed("d/readme.txt", ChangeKind::Created), now);
        let mut reader = Renames {
            announced: Vec::new(),
        };
        let changes = changes_of(coalescer.settle(now + DEBOUNCE, &mut reader));
        assert_eq!(changes.len(), 2, "both spellings are reported");
        assert_eq!(
            reader.announced,
            ["d/Readme.txt", "d/readme.txt"],
            "both paths were announced before either was judged"
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
                && let Some(batch) = coalescer.settle(now, &mut Exists)
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
            coalescer.settle(quiet, &mut Exists),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
        assert_eq!(
            coalescer.settle(quiet + Duration::from_secs(1), &mut Exists),
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
        assert_eq!(coalescer.settle(start, &mut Exists), None);
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(1), &mut Exists),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
        let later = start + Duration::from_secs(2);
        coalescer.push(notice("other/c", ChangeKind::Modified), later);
        let changes = changes_of(coalescer.settle(later + Duration::from_secs(1), &mut Exists));
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "other/c");
    }

    #[test]
    fn a_second_burst_after_a_rescan_is_a_second_rescan() {
        let mut coalescer = coalescer(1);
        let start = Instant::now();
        coalescer.push(notice("first/a", ChangeKind::Created), start);
        coalescer.push(notice("first/b", ChangeKind::Created), start);
        assert_eq!(coalescer.settle(start, &mut Exists), None);
        assert_eq!(
            coalescer.settle(start + Duration::from_secs(1), &mut Exists),
            Some(Batch::Rescan {
                dir: Some("first".to_owned())
            })
        );
        let later = start + Duration::from_secs(2);
        coalescer.push(notice("second/a", ChangeKind::Created), later);
        coalescer.push(notice("second/b", ChangeKind::Created), later);
        assert_eq!(coalescer.settle(later, &mut Exists), None);
        assert_eq!(
            coalescer.settle(later + Duration::from_secs(1), &mut Exists),
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
        assert_eq!(coalescer.settle(now, &mut Exists), None);
        assert_eq!(
            coalescer.settle(now + Duration::from_secs(1), &mut Exists),
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
        assert_eq!(coalescer.settle(now, &mut Gone), None);
        assert_eq!(
            coalescer.settle(now + Duration::from_secs(1), &mut Gone),
            Some(Batch::Rescan { dir: None })
        );
    }

    #[test]
    fn a_change_outside_an_overflowing_folder_widens_its_rescan() {
        let mut coalescer = coalescer(100);
        let now = Instant::now();
        coalescer.overflow(Some("src".to_owned()), now);
        coalescer.push(notice("docs/a.txt", ChangeKind::Modified), now);
        assert_eq!(coalescer.settle(now, &mut Exists), None);
        assert_eq!(
            coalescer.settle(now + Duration::from_secs(1), &mut Exists),
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
        assert_eq!(coalescer.settle(now, &mut Exists), None);
        assert_eq!(
            coalescer.settle(now + Duration::from_secs(1), &mut Exists),
            Some(Batch::Rescan {
                dir: Some("burst".to_owned())
            })
        );
    }

    #[test]
    fn a_check_that_finds_what_the_window_already_holds_does_not_hold_it_open() {
        // The open-folder check runs on its own clock. Landing inside a window, it finds the
        // deletion an event already described, and restarting the quiet period for that would
        // report every such delete a whole debounce late.
        let mut coalescer = coalescer(100);
        let start = Instant::now();
        coalescer.push(notice("gone.txt", ChangeKind::Deleted), start);
        let checked = start + Duration::from_millis(50);
        coalescer.push_found(notice("gone.txt", ChangeKind::Deleted), checked);
        assert_eq!(
            coalescer.wait(checked),
            Some(DEBOUNCE - Duration::from_millis(50))
        );
        assert_eq!(
            changes_of(coalescer.settle(start + DEBOUNCE, &mut Gone)),
            vec![Change {
                path: "gone.txt".to_owned(),
                kind: ChangeKind::Deleted,
                directory: false,
            }]
        );

        // News the window does not hold yet is news: it waits for a quiet period of its own.
        let start = Instant::now();
        coalescer.push(notice("a.txt", ChangeKind::Deleted), start);
        let checked = start + Duration::from_millis(50);
        coalescer.push_found(notice("b.txt", ChangeKind::Deleted), checked);
        assert_eq!(coalescer.wait(checked), Some(DEBOUNCE));
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
        assert_eq!(coalescer.settle(now, &mut Gone), None);
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
            let changes = changes_of(coalescer.settle(now, &mut Gone));
            let folder = changes.iter().find(|change| change.path == "gone").unwrap();
            assert!(folder.directory, "children_first = {children_first}");
        }
    }

    #[test]
    fn burst_counts_are_forgotten_once_their_window_has_passed() {
        // Ordinary batches never rescan, so nothing else would ever drop the count of a folder
        // touched once: memory would grow with every folder ever changed.
        let mut coalescer = coalescer(100);
        let start = Instant::now();
        for window in 0..10 {
            let now = start + Duration::from_millis(window);
            for index in 0..50 {
                coalescer.push(
                    notice(&format!("f{window}-{index}/a.txt"), ChangeKind::Modified),
                    now,
                );
            }
            assert!(matches!(
                coalescer.settle(now, &mut Exists),
                Some(Batch::Changes(_))
            ));
        }
        assert_eq!(coalescer.counted_folders(), 500);
        let later = start + super::BURST_WINDOW + Duration::from_secs(1);
        coalescer.push(notice("other/a.txt", ChangeKind::Modified), later);
        assert!(coalescer.settle(later, &mut Exists).is_some());
        assert_eq!(
            coalescer.counted_folders(),
            1,
            "only the folder changed inside the burst window is still counted"
        );
    }
}
