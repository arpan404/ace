// SPDX-License-Identifier: Apache-2.0

//! Every open checkout root, with the lister and path index that live beside it.
//!
//! `openRoot` does all of its filesystem work before it answers: it canonicalizes the root, opens
//! the capability handle and builds a lister, so every op that follows finds what it needs. The
//! path index is different: a walk of a million files must not delay the answer, so it is built on
//! a background thread and `indexQuery` reports `ready: false` until it lands. One watcher starts
//! with the root and lives until it closes, so every subscription on one checkout shares one set
//! of operating system watches and the index stays right even when nobody is watching.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use files_index::{IndexChange, IndexOptions, PathIndex};
use files_list::Lister;
use files_safe::Root;
use files_watch::{Batch, WatchOptions, Watcher};
use files_wire::IndexResult;

use crate::convert;
use crate::error::Error;
use crate::guard;
use crate::io::Out;
use crate::ops::watch;
use crate::subscriptions::Subscriptions;

/// Quiet period that closes a watch batch, as the plan fixes it.
const DEBOUNCE: Duration = Duration::from_millis(75);
/// Folders whose churn is never news: git's object store and every installed package tree.
const EXCLUDES: [&str; 3] = [
    "**/.git/objects/**",
    "**/.git/subtree-cache/**",
    "**/node_modules/*/**",
];
/// A window holding more paths than this becomes a rescan instead of a batch.
const MAX_BATCH: usize = 5_000;
/// The longest a change waits while writes keep arriving, so a busy file can't delay the rest.
const MAX_WAIT: Duration = Duration::from_secs(1);

/// The answer while the index is still being built: nothing to search yet, and not an error.
fn empty_index() -> IndexResult {
    IndexResult {
        hits: Vec::new(),
        total: 0,
        truncated: false,
        ready: false,
    }
}

/// Every root the daemon has open, by the number `openRoot` handed out.
#[derive(Default)]
pub struct Roots {
    inner: Mutex<HashMap<u64, Arc<RootEntry>>>,
    next: AtomicU64,
}

impl Roots {
    /// Open a checkout and keep it until `closeRoot`.
    pub fn open(&self, path: &Path) -> Result<Arc<RootEntry>, Error> {
        let root = Root::open(path)?;
        let lister = Arc::new(Lister::new(root.clone()));
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let entry = Arc::new(RootEntry {
            id,
            root,
            lister,
            index: RwLock::new(None),
            build: Arc::new(AtomicBool::new(false)),
            watcher: Mutex::new(None),
        });
        guard::lock(&self.inner)?.insert(id, Arc::clone(&entry));
        Ok(entry)
    }

    /// The root with that id, or `INVALID_ARGUMENT` when the daemon never opened it.
    pub fn get(&self, id: u64) -> Result<Arc<RootEntry>, Error> {
        guard::lock(&self.inner)?
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::InvalidArgument(format!("no open root {id}")))
    }

    /// Forget a root. The caller drops the entry, which ends its watcher.
    pub fn take(&self, id: u64) -> Result<Option<Arc<RootEntry>>, Error> {
        Ok(guard::lock(&self.inner)?.remove(&id))
    }
}

/// One open checkout and everything shared by the requests that name it.
pub struct RootEntry {
    id: u64,
    root: Root,
    lister: Arc<Lister>,
    index: RwLock<Option<PathIndex>>,
    build: Arc<AtomicBool>,
    watcher: Mutex<Option<Watcher>>,
}

impl RootEntry {
    /// The number the daemon passes back in every op.
    pub fn id(&self) -> u64 {
        self.id
    }

    /// The confined root every op resolves paths through.
    pub fn root(&self) -> &Root {
        &self.root
    }

    /// The lister that answers `list` and `stat`, and that watch batches invalidate.
    pub fn lister(&self) -> &Arc<Lister> {
        &self.lister
    }

    /// Build the quick-open index in the background, right after the root opens.
    pub fn start_index(self: &Arc<Self>) {
        let entry = Arc::clone(self);
        tokio::task::spawn_blocking(move || entry.build_index());
    }

    /// Stop a build that is still walking, so closing a root does not leave it reading a tree
    /// nobody asked about.
    pub fn stop_index(&self) {
        self.build.store(true, Ordering::Relaxed);
    }

    /// Walk the checkout into a path index and publish it.
    fn build_index(&self) {
        match PathIndex::build(&self.root, &IndexOptions::default(), &self.build) {
            Ok(index) => {
                if let Ok(mut slot) = guard::write(&self.index) {
                    *slot = Some(index);
                }
            }
            Err(files_index::Error::Aborted) => {}
            Err(error) => eprintln!("ace-files: index for root {}: {error}", self.id),
        }
    }

    /// Start the one watcher this root has, unless it is already running. The sink invalidates
    /// listings, updates the index and forwards the batch to every watch subscription on the root.
    ///
    /// Runs on a blocking thread: starting a watcher walks the tree, and dropping one joins its
    /// worker, so neither belongs on a runtime worker.
    pub fn ensure_watcher(
        self: &Arc<Self>,
        subscriptions: &Arc<Subscriptions>,
        out: &Out,
    ) -> Result<(), Error> {
        let mut slot = guard::lock(&self.watcher)?;
        if slot.is_some() {
            return Ok(());
        }
        let entry = Arc::clone(self);
        let subscriptions = Arc::clone(subscriptions);
        let out = out.clone();
        let sink =
            Box::new(move |batch: Batch| watch::deliver(&entry, &subscriptions, &out, batch));
        let options = WatchOptions {
            debounce: DEBOUNCE,
            exclude: EXCLUDES.iter().map(|glob| (*glob).to_owned()).collect(),
            max_batch: MAX_BATCH,
            max_wait: MAX_WAIT,
        };
        *slot = Some(Watcher::start(self.root.clone(), options, sink)?);
        Ok(())
    }

    /// Answer a quick-open query. Before the build lands there is nothing to search, which the
    /// daemon shows as an empty list rather than an error.
    pub fn index_query(&self, query: &str, limit: usize) -> IndexResult {
        let index = match guard::read(&self.index) {
            Ok(index) => index,
            Err(_) => return empty_index(),
        };
        match index.as_ref() {
            None => empty_index(),
            Some(index) => IndexResult {
                hits: index
                    .search(query, limit)
                    .into_iter()
                    .map(convert::hit)
                    .collect(),
                total: u64::try_from(index.len()).unwrap_or(u64::MAX),
                truncated: index.truncated(),
                ready: true,
            },
        }
    }

    /// Rebuild the index after the watcher lost track of the tree, so quick open drops paths a
    /// rescan made stale. A build that is still running already walks the whole checkout, so it
    /// needs no restart.
    pub fn rescan_index(self: &Arc<Self>) {
        let built = matches!(guard::read(&self.index), Ok(slot) if slot.is_some());
        if !built {
            return;
        }
        if let Ok(mut slot) = guard::write(&self.index) {
            *slot = None;
        }
        self.start_index();
    }

    /// Fold a watcher batch into the index: created folders are walked outside the write lock, so
    /// quick open keeps answering while a large folder is being indexed.
    pub fn apply_changes(&self, changes: &[IndexChange]) {
        let prepared = {
            let index = match guard::read(&self.index) {
                Ok(index) => index,
                Err(_) => return,
            };
            match index.as_ref() {
                Some(index) => index.prepare(&self.root, changes),
                None => return,
            }
        };
        match guard::write(&self.index) {
            Ok(mut index) => {
                if let Some(index) = index.as_mut() {
                    index.commit(prepared);
                }
            }
            Err(error) => {
                eprintln!(
                    "ace-files: cannot update the index of root {}: {error}",
                    self.id
                )
            }
        }
    }
}
