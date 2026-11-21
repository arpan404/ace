// SPDX-License-Identifier: Apache-2.0

//! The quick-open index of one root: built in the background, served while it is rebuilt, and kept
//! right by the watcher's batches.
//!
//! A walk of a million files must not delay `openRoot` and must not stop quick open answering, so
//! the index is served through an `Arc` that a rebuild replaces in one swap. Changes the watcher
//! reports while a walk is running wait in the book and are replayed on the new index before it is
//! published, so nothing a person typed or an agent wrote is lost between two walks.

use std::sync::Arc;
use std::sync::atomic::Ordering;
#[cfg(feature = "test-hooks")]
use std::sync::atomic::{AtomicBool, AtomicUsize};

use files_index::{IndexChange, PathIndex};
use files_wire::IndexResult;

use crate::convert;
use crate::error::Error;
use crate::guard;
use crate::roots::RootEntry;

/// The answer while the index is still being built: nothing to search yet, and not an error.
fn empty_index() -> IndexResult {
    IndexResult {
        hits: Vec::new(),
        total: 0,
        truncated: false,
        ready: false,
    }
}

/// Test-only: `ACE_FILES_HOLD_INDEX_MS` keeps a finished walk from being published for that many
/// milliseconds, so a test can change the tree while the build is still in flight.
#[cfg(feature = "test-hooks")]
fn hold_publish() {
    let Some(ms) = std::env::var("ACE_FILES_HOLD_INDEX_MS")
        .ok()
        .and_then(|ms| ms.parse::<u64>().ok())
    else {
        return;
    };
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

/// One walk of the checkout: the whole tree, or one folder inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Walk {
    /// Every path under the root.
    Tree,
    /// One folder and everything below it.
    Folder(String),
}

impl Walk {
    /// The walk that covers both requests: the broader of two overlapping folders, or the whole
    /// tree when they are unrelated.
    fn merge(self, other: Walk) -> Walk {
        match (&self, &other) {
            (Walk::Tree, _) | (_, Walk::Tree) => Walk::Tree,
            (Walk::Folder(left), Walk::Folder(right)) => {
                if left == right || under(right, left) {
                    Walk::Folder(left.clone())
                } else if under(left, right) {
                    Walk::Folder(right.clone())
                } else {
                    Walk::Tree
                }
            }
        }
    }
}

/// Whether `path` sits inside `folder`, with the root as the empty folder.
fn under(path: &str, folder: &str) -> bool {
    folder.is_empty()
        || (path.len() > folder.len()
            && path.starts_with(folder)
            && path.as_bytes()[folder.len()] == b'/')
}

/// What the quick-open index is doing right now.
///
/// One lock guards both the build in flight and the changes waiting for it, so a change either
/// lands in the index that is being served or waits for the next one: neither is lost.
#[derive(Default)]
pub(crate) struct IndexBook {
    /// A walk is running, so watcher changes wait in `pending` instead of landing in the index
    /// the walk is about to replace.
    building: bool,
    /// What the running walk covers, when one is.
    walking: Option<Walk>,
    /// Changes that arrived while a walk was running, replayed when it publishes.
    pending: Vec<IndexChange>,
    /// A walk asked for while another was running. The running walk may have read the folder
    /// before the change that asked for it landed, so it is one generation behind and this
    /// walk follows it.
    again: Option<Walk>,
    /// Why the last build failed, until a query reports it or a build succeeds.
    failure: Option<String>,
}

/// Changes that arrive while a walk is running wait for it, up to this many. Past it the batch is
/// folded into "walk the tree again", which costs one more walk instead of unbounded memory.
const PENDING_LIMIT: usize = 50_000;

/// How many pending changes one publish replays before it swaps the index in. A busy watcher can
/// keep the queue nonempty forever; past this point the rest belongs to the next generation and
/// is applied to the index that is now served, so publishing never waits for quiet.
#[cfg(not(test))]
const REPLAY_LIMIT: usize = 20_000;
#[cfg(test)]
const REPLAY_LIMIT: usize = 4;

/// Test-only: `ACE_FILES_PANIC_INDEX` makes every build panic, so a test can prove a stopped
/// worker becomes an error instead of a root that reports "not ready" forever.
#[cfg(feature = "test-hooks")]
fn panic_index_on_purpose() {
    if std::env::var_os("ACE_FILES_PANIC_INDEX").is_some() {
        panic!("test hook: the index build panics");
    }
}

/// Test-only: `ACE_FILES_PANIC_INDEX_ONCE` fails the first walk that starts after the first
/// published index, after its hold, so a test can put a batch in flight before the failure.
#[cfg(feature = "test-hooks")]
fn panic_after_hold_on_purpose() {
    static ONCE: AtomicBool = AtomicBool::new(false);
    if std::env::var_os("ACE_FILES_PANIC_INDEX_ONCE").is_some()
        && PUBLISHED.load(Ordering::Relaxed) > 0
        && !ONCE.swap(true, Ordering::Relaxed)
    {
        panic!("test hook: the next index build panics once");
    }
}

impl RootEntry {
    /// Build the quick-open index in the background, right after the root opens.
    ///
    /// The walk runs on a blocking thread and this task waits for it: a build whose worker panics
    /// must be seen, not silently dropped, or quick open would say "still indexing" forever.
    pub fn start_index(self: &Arc<Self>) {
        self.start_walk(Walk::Tree);
    }

    /// Start a walk, or queue one more after the running one when this request arrives while a
    /// walk is in flight. A request for a folder the running walk does not cover widens the
    /// follow-up to the whole tree, so no request is dropped.
    fn start_walk(self: &Arc<Self>, walk: Walk) {
        match guard::lock(&self.book) {
            Ok(mut book) => {
                if book.building {
                    book.again = Some(match book.again.take() {
                        Some(queued) => queued.merge(walk),
                        None => walk,
                    });
                    return;
                }
                if self.is_closed() {
                    return;
                }
                book.building = true;
                book.walking = Some(walk.clone());
                book.failure = None;
            }
            Err(_) => return,
        }
        self.build.store(false, Ordering::Relaxed);
        let entry = Arc::clone(self);
        self.handle.spawn(async move {
            let inner = Arc::clone(&entry);
            let built = tokio::task::spawn_blocking(move || inner.build(walk)).await;
            entry.finish_index(crate::dispatch::joined(built));
        });
    }

    /// The walk a build task performs, with the published index replaced when it lands.
    fn build(self: &Arc<Self>, walk: Walk) -> Result<(), Error> {
        match walk {
            Walk::Tree => self.build_index(),
            Walk::Folder(folder) => self.build_one_folder(&folder),
        }
    }

    /// Stop a build that is still walking, so closing a root does not leave it reading a tree
    /// nobody asked about.
    pub fn stop_index(&self) {
        self.build.store(true, Ordering::Relaxed);
    }

    /// Walk the checkout into a path index and hand it to [`RootEntry::publish`].
    fn build_index(self: &Arc<Self>) -> Result<(), Error> {
        #[cfg(feature = "test-hooks")]
        panic_index_on_purpose();
        let index = PathIndex::build(&self.root, &crate::hidden::index_options(), &self.build)?;
        #[cfg(feature = "test-hooks")]
        hold_publish();
        #[cfg(feature = "test-hooks")]
        panic_after_hold_on_purpose();
        self.publish(index)
    }

    /// Swap a finished walk in, replaying the changes that arrived while it ran.
    ///
    /// The book lock is held for each drain and for the swap, so a watcher batch either lands in
    /// the index being served or joins `pending`; the changes themselves are applied with no index
    /// lock held, and the old index keeps answering every query until the swap.
    fn publish(self: &Arc<Self>, mut index: PathIndex) -> Result<(), Error> {
        let mut replayed = 0usize;
        let again = loop {
            // Take the queue under the lock; anything over the replay budget is carried.
            let (pending, carry) = {
                let mut book = guard::lock(&self.book)?;
                let mut pending = std::mem::take(&mut book.pending);
                let budget = REPLAY_LIMIT.saturating_sub(replayed);
                let carry = if pending.len() > budget {
                    pending.split_off(budget)
                } else {
                    Vec::new()
                };
                (pending, carry)
            };
            let spent = !carry.is_empty();
            let idle = !spent && pending.is_empty();
            if !pending.is_empty() {
                replayed += pending.len();
                index.apply(&self.root, &pending);
            }
            if !spent && !idle {
                // The budget covered this round; look again for edits that arrived meanwhile.
                continue;
            }
            // One locked transition from here: take every edit that arrived while the round
            // applied, append it after the carried ones so batch order is kept, install them
            // in the walk's index, and swap it in. No newer edit can commit and no walk can
            // snapshot until all of that has happened.
            let mut book = guard::lock(&self.book)?;
            let mut install = carry;
            install.extend(std::mem::take(&mut book.pending));
            if !install.is_empty() {
                index.apply(&self.root, &install);
            }
            let (swapped, replaced) = match guard::write(&self.index) {
                Ok(mut slot) => (true, slot.replace(Arc::new(index))),
                Err(_) => (false, None),
            };
            book.building = false;
            book.walking = None;
            book.failure = None;
            let again = std::mem::take(&mut book.again);
            drop(book);
            // The index it replaced goes now, unless a query still holds it, and with it whatever
            // the walk freed: give that memory back rather than keep it resident.
            drop(replaced);
            crate::memory::release();
            if !swapped {
                return Err(Error::System(std::io::Error::other(
                    "the index lock was poisoned",
                )));
            }
            break again;
        };
        #[cfg(feature = "test-hooks")]
        note_publish();
        #[cfg(feature = "test-hooks")]
        rebuild_on_purpose(self);
        if let Some(walk) = again {
            self.start_walk(walk);
        }
        Ok(())
    }

    /// Record what a build did: a build the close stopped says nothing, any other failure and a
    /// worker that panicked is kept so `indexQuery` can answer with it, and the changes that
    /// arrived meanwhile go to the index still being served.
    fn finish_index(self: &Arc<Self>, built: Result<(), Error>) {
        if built.is_ok() {
            return;
        }
        let (folded, again) = match guard::lock(&self.book) {
            Ok(mut book) => {
                book.building = false;
                book.walking = None;
                if let Err(error) = &built
                    && error.code() != "ABORTED"
                {
                    eprintln!("ace-files: index for root {}: {error}", self.id);
                    book.failure = Some(error.failure().message);
                }
                // The edits that waited for this walk are older than anything a watcher can
                // deliver now. Fold them while the book lock still holds, so a newer batch
                // cannot commit first, and keep the queue order.
                let changes = std::mem::take(&mut book.pending);
                let folded = if changes.is_empty() {
                    true
                } else {
                    self.fold_served(&changes)
                };
                (folded, std::mem::take(&mut book.again))
            }
            Err(_) => return,
        };
        if !folded {
            eprintln!(
                "ace-files: cannot update the index of root {}; rebuilding it",
                self.id
            );
            self.start_index();
            return;
        }
        if let Some(walk) = again {
            // This walk was asked for by a batch, not by the failure, so the failure says
            // nothing about it. `start_walk` refuses once the root is closing.
            self.start_walk(walk);
        }
    }

    /// Answer a quick-open query. Before the build lands there is nothing to search, which the
    /// daemon shows as an empty list rather than an error; a build that failed answers with why,
    /// so quick open never waits forever on an index that will not arrive.
    pub fn index_query(&self, query: &str, limit: usize) -> Result<IndexResult, Error> {
        let index = guard::read(&self.index)?;
        if let Some(index) = index.as_ref() {
            return Ok(IndexResult {
                hits: index
                    .search(query, limit)
                    .into_iter()
                    .map(convert::hit)
                    .collect(),
                total: u64::try_from(index.len()).unwrap_or(u64::MAX),
                truncated: index.truncated(),
                ready: true,
            });
        }
        drop(index);
        let failure = guard::lock(&self.book)?.failure.clone();
        match failure {
            Some(message) => Err(Error::System(std::io::Error::other(format!(
                "the quick-open index could not be built: {message}"
            )))),
            None => Ok(empty_index()),
        }
    }

    /// Rebuild the index after the watcher lost track of the tree, so quick open drops paths a
    /// rescan made stale.
    ///
    /// The index being served keeps answering while the walk runs, and the new one replaces it in
    /// one swap. A build that is already walking may have passed the folder the watcher lost, so
    /// one more build follows it.
    pub fn rescan_index(self: &Arc<Self>) {
        self.start_walk(Walk::Tree);
    }

    /// Walk one folder again because the watcher lost track of it.
    ///
    /// The walk runs in the background while the served index keeps answering, so a batch that
    /// arrives meanwhile finds the book building and is replayed on the new index. Any batch
    /// that touches the folder while the walk runs schedules one more walk after it: the walk
    /// may have read the folder before that change landed.
    pub fn rescan_folder(self: &Arc<Self>, folder: String) {
        self.start_walk(Walk::Folder(folder));
    }

    /// Rebuild one folder after an ignore-rule file changed inside it.
    ///
    /// Editing a `.gitignore`, the repository's `info/exclude` or the user's global excludes file
    /// changes which paths belong in the index without touching them, so the watcher cannot
    /// describe the update file by file: the folder has to be walked again under the new rules,
    /// which drops paths that just became ignored and finds paths that just became visible.
    ///
    /// The walk runs on a blocking thread while the index being served keeps answering, and its
    /// result is merged into a copy that replaces the served index in one swap, like a rescan.
    /// The root's "building" flag also holds watcher batches in `pending`, so a change that lands
    /// mid-walk is replayed onto the new index rather than lost against the old one. A build that
    /// is already walking may have read the old rules, so one more walk follows it: the same
    /// folder, or the whole tree when the running walk covers somewhere else.
    pub fn rebuild_folder(self: &Arc<Self>, folder: String) {
        self.start_walk(Walk::Folder(folder));
    }

    fn build_one_folder(self: &Arc<Self>, folder: &str) -> Result<(), Error> {
        let served = {
            let slot = guard::read(&self.index)?;
            slot.as_ref().map(Arc::clone)
        };
        let rebuilt = match served {
            Some(index) => index.rebuilt_folder(
                &self.root,
                folder,
                &crate::hidden::index_options(),
                &self.build,
            )?,
            // Nothing is being served yet, or the first build failed: a rule edit is a good
            // reason to try the whole tree again.
            None => PathIndex::build(&self.root, &crate::hidden::index_options(), &self.build)?,
        };
        #[cfg(feature = "test-hooks")]
        hold_publish();
        #[cfg(feature = "test-hooks")]
        panic_after_hold_on_purpose();
        self.publish(rebuilt)
    }

    /// Fold a watcher batch into the index.
    ///
    /// The batch goes to `pending` while a rebuild is walking, so the walk cannot publish an index
    /// that has already forgotten it. Otherwise the created folders are walked on a clone of the
    /// index, with no lock held, and only the commit takes the write lock.
    pub fn apply_changes(self: &Arc<Self>, changes: &[IndexChange]) {
        let mut book = match guard::lock(&self.book) {
            Ok(book) => book,
            Err(_) => return,
        };
        if book.building {
            if book.pending.len() + changes.len() > PENDING_LIMIT {
                book.pending.clear();
                book.again = Some(match book.again.take() {
                    Some(queued) => queued.merge(Walk::Tree),
                    None => Walk::Tree,
                });
                return;
            }
            book.pending.extend_from_slice(changes);
            return;
        }
        let committed = self.fold_served(changes);
        drop(book);
        if !committed {
            // Something still holds the index, so this batch has nowhere to land: walk the tree
            // again instead of dropping what the watcher saw.
            eprintln!(
                "ace-files: cannot update the index of root {}; rebuilding it",
                self.id
            );
            self.start_index();
        }
    }

    /// Fold changes into the served index. The caller holds the book lock, which is what keeps
    /// an older batch from being overtaken by a newer one.
    fn fold_served(&self, changes: &[IndexChange]) -> bool {
        let index = match guard::read(&self.index) {
            Ok(slot) => match slot.as_ref() {
                Some(index) => Arc::clone(index),
                None => return true,
            },
            Err(_) => return true,
        };
        let prepared = index.prepare(&self.root, changes);
        drop(index);
        match guard::write(&self.index) {
            Ok(mut slot) => match slot.as_mut().and_then(Arc::get_mut) {
                Some(index) => {
                    index.commit(prepared);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }
}

/// Test-only: `ACE_FILES_INDEX_EVENTS` writes one line to stderr per published index, so a test
/// can wait for a rebuild instead of sleeping.
#[cfg(feature = "test-hooks")]
static PUBLISHED: AtomicUsize = AtomicUsize::new(0);

#[cfg(feature = "test-hooks")]
fn note_publish() {
    let count = PUBLISHED.fetch_add(1, Ordering::Relaxed) + 1;
    if std::env::var_os("ACE_FILES_INDEX_EVENTS").is_some() {
        eprintln!("ace-files: index published {count}");
    }
}

/// Test-only: `ACE_FILES_REBUILD_AFTER_MS` makes one rebuild follow the first published index
/// after that many milliseconds, so a test can watch quick open answer while a rescan walks.
#[cfg(feature = "test-hooks")]
fn rebuild_on_purpose(entry: &Arc<RootEntry>) {
    static ONCE: AtomicBool = AtomicBool::new(false);
    let Some(ms) = std::env::var("ACE_FILES_REBUILD_AFTER_MS")
        .ok()
        .and_then(|ms| ms.parse::<u64>().ok())
    else {
        return;
    };
    if ONCE.swap(true, Ordering::Relaxed) {
        return;
    }
    let entry = Arc::clone(entry);
    let handle = entry.handle.clone();
    handle.spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        entry.rescan_index();
    });
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use files_index::{IndexChange, PathIndex};
    use tokio::runtime::Handle;

    use super::{REPLAY_LIMIT, Walk};
    use crate::error::Error;
    use crate::roots::Roots;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_publish_carries_the_edits_it_did_not_replay() {
        let checkout = tempfile::tempdir().unwrap();
        let count = REPLAY_LIMIT + 3;
        let changes: Vec<IndexChange> = (0..count)
            .map(|index| {
                let path = format!("late{index}.txt");
                std::fs::write(checkout.path().join(&path), "x").unwrap();
                IndexChange {
                    path,
                    deleted: false,
                    directory: false,
                }
            })
            .collect();
        let roots = Roots::new(Handle::current());
        let entry = roots.open(checkout.path()).unwrap();
        {
            let mut book = entry.book.lock().unwrap();
            book.building = true;
            book.walking = Some(Walk::Tree);
            book.pending = changes;
        }
        *entry.index.write().unwrap() = Some(Arc::new(PathIndex::from_paths(Vec::<String>::new())));

        // The walk's result knows nothing about the edits that arrived while it walked. The
        // publish replays what fits its budget and carries the rest onto the served index.
        let built = PathIndex::from_paths(Vec::<String>::new());
        entry.publish(built).unwrap();

        let index = entry.index_query("late", 100).unwrap();
        assert!(index.ready);
        assert_eq!(
            index.total, count as u64,
            "an edit past the replay budget lands on the new index"
        );
        entry.close();
    }

    fn new_files(count: usize) -> Vec<IndexChange> {
        (0..count)
            .map(|index| IndexChange {
                path: format!("late{index}.txt"),
                deleted: false,
                directory: false,
            })
            .collect()
    }

    fn create(path: &str) -> IndexChange {
        IndexChange {
            path: path.to_owned(),
            deleted: false,
            directory: false,
        }
    }

    fn delete(path: &str) -> IndexChange {
        IndexChange {
            path: path.to_owned(),
            deleted: true,
            directory: false,
        }
    }

    fn wait_until(wanted: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !wanted() {
            assert!(
                Instant::now() < deadline,
                "the background index work never reached the expected state"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_create_and_delete_that_spans_the_replay_budget_leaves_nothing() {
        let checkout = tempfile::tempdir().unwrap();
        let roots = Roots::new(Handle::current());
        let entry = roots.open(checkout.path()).unwrap();
        let mut changes = vec![create("x.txt")];
        changes.extend(new_files(REPLAY_LIMIT - 1));
        changes.push(delete("x.txt"));
        {
            let mut book = entry.book.lock().unwrap();
            book.building = true;
            book.walking = Some(Walk::Tree);
            book.pending = changes;
        }
        entry
            .publish(PathIndex::from_paths(Vec::<String>::new()))
            .unwrap();

        let index = entry.index_query("x", 10).unwrap();
        assert!(
            index.hits.iter().all(|hit| hit.path != "x.txt"),
            "a create and its later delete keep batch order: {:?}",
            index.hits
        );
        entry.close();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_newer_edit_never_overtakes_the_edits_a_publish_carries() {
        let checkout = tempfile::tempdir().unwrap();
        std::fs::write(checkout.path().join("x.txt"), "x").unwrap();
        let roots = Roots::new(Handle::current());
        let entry = roots.open(checkout.path()).unwrap();
        let mut changes = new_files(REPLAY_LIMIT);
        changes.push(delete("x.txt"));
        {
            let mut book = entry.book.lock().unwrap();
            book.building = true;
            book.walking = Some(Walk::Tree);
            book.pending = changes;
        }
        let built = PathIndex::from_paths(["x.txt".to_owned()]);
        let publishing = {
            let entry = Arc::clone(&entry);
            std::thread::spawn(move || entry.publish(built))
        };

        // A ready index means the swap is in place, so this create is newer than everything the
        // publish replayed or carried.
        wait_until(|| entry.index_query("late", 1).unwrap().ready);
        entry.apply_changes(&[create("x.txt")]);
        publishing.join().unwrap().unwrap();

        let index = entry.index_query("x", 10).unwrap();
        assert!(
            index.hits.iter().any(|hit| hit.path == "x.txt"),
            "the newer create must win over the carried delete: {:?}",
            index.hits
        );
        entry.close();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_recovered_edit_is_folded_before_a_newer_one() {
        let checkout = tempfile::tempdir().unwrap();
        std::fs::write(checkout.path().join("x.txt"), "x").unwrap();
        let roots = Roots::new(Handle::current());
        let entry = roots.open(checkout.path()).unwrap();
        *entry.index.write().unwrap() = Some(Arc::new(PathIndex::from_paths(["x.txt".to_owned()])));
        {
            let mut book = entry.book.lock().unwrap();
            book.building = true;
            book.walking = Some(Walk::Tree);
            book.pending = vec![delete("x.txt")];
        }
        let failing = {
            let entry = Arc::clone(&entry);
            std::thread::spawn(move || {
                entry.finish_index(Err(Error::System(std::io::Error::other("the walk failed"))));
            })
        };

        // The failed walk hands its recovered edit to the served index before it lets go of the
        // book, so an edit that arrives now is applied after it.
        wait_until(|| !entry.book.lock().unwrap().building);
        entry.apply_changes(&[create("x.txt")]);
        failing.join().unwrap();

        let index = entry.index_query("x", 10).unwrap();
        assert!(
            index.hits.iter().any(|hit| hit.path == "x.txt"),
            "the newer create must win over the recovered delete: {:?}",
            index.hits
        );
        entry.close();
    }
}
