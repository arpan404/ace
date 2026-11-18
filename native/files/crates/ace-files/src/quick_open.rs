// SPDX-License-Identifier: Apache-2.0

//! The quick-open index of one root: built in the background, served while it is rebuilt, and kept
//! right by the watcher's batches.
//!
//! A walk of a million files must not delay `openRoot` and must not stop quick open answering, so
//! the index is served through an `Arc` that a rebuild replaces in one swap. Changes the watcher
//! reports while a walk is running wait in the book and are replayed on the new index before it is
//! published, so nothing a person typed or an agent wrote is lost between two walks.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use files_index::{IndexChange, IndexOptions, PathIndex};
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
fn hold_publish() {
    let Some(ms) = std::env::var("ACE_FILES_HOLD_INDEX_MS")
        .ok()
        .and_then(|ms| ms.parse::<u64>().ok())
    else {
        return;
    };
    std::thread::sleep(std::time::Duration::from_millis(ms));
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
    /// Changes that arrived while a walk was running, replayed when it publishes.
    pending: Vec<IndexChange>,
    /// A rescan asked for a rebuild while one was already walking, so one more follows it.
    again: bool,
    /// Why the last build failed, until a query reports it or a build succeeds.
    failure: Option<String>,
}

impl RootEntry {
    /// Build the quick-open index in the background, right after the root opens.
    ///
    /// The walk runs on a blocking thread and this task waits for it: a build whose worker panics
    /// must be seen, not silently dropped, or quick open would say "still indexing" forever.
    pub fn start_index(self: &Arc<Self>) {
        match guard::lock(&self.book) {
            Ok(mut book) => {
                if book.building || self.is_closed() {
                    return;
                }
                book.building = true;
                book.failure = None;
            }
            Err(_) => return,
        }
        self.build.store(false, Ordering::Relaxed);
        let entry = Arc::clone(self);
        self.handle.spawn(async move {
            let inner = Arc::clone(&entry);
            let built = tokio::task::spawn_blocking(move || inner.build_index()).await;
            entry.finish_index(crate::dispatch::joined(built));
        });
    }

    /// Stop a build that is still walking, so closing a root does not leave it reading a tree
    /// nobody asked about.
    pub fn stop_index(&self) {
        self.build.store(true, Ordering::Relaxed);
    }

    /// Walk the checkout into a path index and hand it to [`RootEntry::publish`].
    fn build_index(self: &Arc<Self>) -> Result<(), Error> {
        if std::env::var_os("ACE_FILES_PANIC_INDEX").is_some() {
            panic!("test hook: the index build panics");
        }
        let index = PathIndex::build(&self.root, &IndexOptions::default(), &self.build)?;
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
                    book.building = false;
                    book.failure = None;
                    let again = std::mem::take(&mut book.again);
                    *guard::write(&self.index)? = Some(Arc::new(index));
                    drop(book);
                    note_publish();
                    rebuild_on_purpose(self);
                    if again {
                        self.start_index();
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
        if let Ok(mut book) = guard::lock(&self.book)
            && book.building
        {
            book.again = true;
            return;
        }
        self.start_index();
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
static PUBLISHED: AtomicUsize = AtomicUsize::new(0);

fn note_publish() {
    let count = PUBLISHED.fetch_add(1, Ordering::Relaxed) + 1;
    if std::env::var_os("ACE_FILES_INDEX_EVENTS").is_some() {
        eprintln!("ace-files: index published {count}");
    }
}

/// Test-only: `ACE_FILES_REBUILD_AFTER_MS` makes one rebuild follow the first published index
/// after that many milliseconds, so a test can watch quick open answer while a rescan walks.
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
