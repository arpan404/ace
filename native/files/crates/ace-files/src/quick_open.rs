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

    /// Whether a change in `folder` can make this walk's result stale: the folder it walks or one
    /// below it, or, for a folder that changed itself, a folder above it that may have moved it.
    fn touches(&self, folder: &str, directory: bool) -> bool {
        match self {
            Walk::Tree => true,
            Walk::Folder(walk) => {
                folder == walk || under(folder, walk) || (directory && under(walk, folder))
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

/// Test-only: `ACE_FILES_PANIC_INDEX` makes every build panic, so a test can prove a stopped
/// worker becomes an error instead of a root that reports "not ready" forever.
#[cfg(feature = "test-hooks")]
fn panic_index_on_purpose() {
    if std::env::var_os("ACE_FILES_PANIC_INDEX").is_some() {
        panic!("test hook: the index build panics");
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
        self.publish(index)
    }

    /// Swap a finished walk in, replaying the changes that arrived while it ran.
    ///
    /// The book lock is held for each drain and for the swap, so a watcher batch either lands in
    /// the index being served or joins `pending`; the changes themselves are applied with no index
    /// lock held, and the old index keeps answering every query until the swap.
    fn publish(self: &Arc<Self>, mut index: PathIndex) -> Result<(), Error> {
        loop {
            let changes = {
                let mut book = guard::lock(&self.book)?;
                if book.pending.is_empty() {
                    let swapped = match guard::write(&self.index) {
                        Ok(mut slot) => {
                            *slot = Some(Arc::new(index));
                            true
                        }
                        Err(_) => false,
                    };
                    book.building = false;
                    book.walking = None;
                    book.failure = None;
                    let again = std::mem::take(&mut book.again);
                    drop(book);
                    if !swapped {
                        return Err(Error::System(std::io::Error::other(
                            "the index lock was poisoned",
                        )));
                    }
                    #[cfg(feature = "test-hooks")]
                    note_publish();
                    #[cfg(feature = "test-hooks")]
                    rebuild_on_purpose(self);
                    if let Some(walk) = again {
                        self.start_walk(walk);
                    }
                    return Ok(());
                }
                std::mem::take(&mut book.pending)
            };
            index.apply(&self.root, &changes);
        }
    }

    /// Record what a build did: a build the close stopped says nothing, any other failure and a
    /// worker that panicked is kept so `indexQuery` can answer with it, and the changes that
    /// arrived meanwhile go to the index still being served.
    fn finish_index(self: &Arc<Self>, built: Result<(), Error>) {
        if built.is_ok() {
            return;
        }
        let changes = match guard::lock(&self.book) {
            Ok(mut book) => {
                book.building = false;
                book.walking = None;
                // A failed walk is reported, not retried forever; a queued one would only run
                // into the same failure.
                book.again = None;
                if let Err(error) = &built
                    && error.code() != "ABORTED"
                {
                    eprintln!("ace-files: index for root {}: {error}", self.id);
                    book.failure = Some(error.failure().message);
                }
                std::mem::take(&mut book.pending)
            }
            Err(_) => return,
        };
        if !changes.is_empty() {
            self.apply_changes(&changes);
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

    /// Record that a batch touched `folder` (the folder a changed path sits in, or a folder that
    /// changed itself, which `directory` says). A walk running over it is one generation behind
    /// and runs again when it publishes.
    pub fn note_touch(self: &Arc<Self>, folder: &str, directory: bool) {
        let Ok(mut book) = guard::lock(&self.book) else {
            return;
        };
        if !book.building {
            return;
        }
        let Some(walking) = book.walking.clone() else {
            return;
        };
        if !walking.touches(folder, directory) {
            return;
        }
        book.again = Some(match book.again.take() {
            Some(queued) => queued.merge(walking),
            None => walking,
        });
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
        let served = match guard::read(&self.index) {
            Ok(slot) => slot.as_ref().map(Arc::clone),
            Err(error) => return Err(error),
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
        let index = match guard::read(&self.index) {
            Ok(slot) => match slot.as_ref() {
                Some(index) => Arc::clone(index),
                None => return,
            },
            Err(_) => return,
        };
        let prepared = index.prepare(&self.root, changes);
        drop(index);
        let committed = match guard::write(&self.index) {
            Ok(mut slot) => match slot.as_mut().and_then(Arc::get_mut) {
                Some(index) => {
                    index.commit(prepared);
                    true
                }
                None => false,
            },
            Err(_) => false,
        };
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
