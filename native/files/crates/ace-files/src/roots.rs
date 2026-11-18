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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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
use crate::subscriptions::{Kind, Subscriptions};

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

/// The answer while the index is still being built: nothing to search yet, and not an error.
fn empty_index() -> IndexResult {
    IndexResult {
        hits: Vec::new(),
        total: 0,
        truncated: false,
        ready: false,
    }
}

/// How many root entries the process holds. Test-only: with `ACE_FILES_LIVE_ROOTS` set, the
/// binary prints the count on stderr whenever a root is dropped, so a test can prove `closeRoot`
/// released its root rather than leaking the watcher that points back at it.
static LIVE_ROOTS: AtomicUsize = AtomicUsize::new(0);

/// Test-only: `ACE_FILES_HOLD_INDEX_MS` keeps a finished walk from being published for that many
/// milliseconds, so a test can change the tree while the build is still in flight.
fn hold_publish() {
    let Some(ms) = std::env::var("ACE_FILES_HOLD_INDEX_MS")
        .ok()
        .and_then(|ms| ms.parse::<u64>().ok())
    else {
        return;
    };
    std::thread::sleep(Duration::from_millis(ms));
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
        LIVE_ROOTS.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(RootEntry {
            id,
            root,
            lister,
            index: RwLock::new(None),
            failure: Mutex::new(None),
            build: Arc::new(AtomicBool::new(false)),
            closed: AtomicBool::new(false),
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
    /// Why the last build failed, kept until a query reports it and a new build clears it.
    failure: Mutex<Option<String>>,
    build: Arc<AtomicBool>,
    /// Set by `closeRoot` before anything is torn down. A watcher start or a subscription that
    /// races the close sees it and refuses, so a closed root leaves no thread or subscription.
    closed: AtomicBool,
    watcher: Mutex<Option<Watcher>>,
}

impl Drop for RootEntry {
    fn drop(&mut self) {
        let live = LIVE_ROOTS.fetch_sub(1, Ordering::Relaxed) - 1;
        if std::env::var_os("ACE_FILES_LIVE_ROOTS").is_some() {
            eprintln!("ace-files: live-roots {live}");
        }
    }
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

    /// Whether `closeRoot` already claimed this root.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Claim the root for closing: a watcher start or a new subscription that has not looked yet
    /// sees the flag and backs out, and a build that is still walking stops at its next file.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.stop_index();
    }

    /// Take the watcher out of its slot, so dropping it joins its worker thread somewhere the
    /// caller chooses: `closeRoot` does that on a blocking thread, never on a runtime worker.
    pub fn take_watcher(&self) -> Option<Watcher> {
        guard::lock(&self.watcher)
            .ok()
            .and_then(|mut slot| slot.take())
    }

    /// Register a watch or search subscription on this root unless `closeRoot` closed it first.
    /// The flag and the registry are checked under one lock, so a close that races a subscription
    /// leaves neither a live subscription nor a watcher behind.
    pub fn subscribe(
        &self,
        subscriptions: &Subscriptions,
        kind: Kind,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<u64, Error> {
        match subscriptions.create(self.id, kind, cancel, &self.closed)? {
            Some(id) => Ok(id),
            None => Err(Error::InvalidArgument(format!(
                "root {} was closed",
                self.id
            ))),
        }
    }

    /// Build the quick-open index in the background, right after the root opens.
    ///
    /// The walk runs on a blocking thread and this task waits for it: a build whose worker panics
    /// must be seen, not silently dropped, or quick open would say "still indexing" forever.
    pub fn start_index(self: &Arc<Self>) {
        let entry = Arc::clone(self);
        tokio::spawn(async move {
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

    /// Walk the checkout into a path index and publish it.
    fn build_index(&self) -> Result<(), Error> {
        if std::env::var_os("ACE_FILES_PANIC_INDEX").is_some() {
            panic!("test hook: the index build panics");
        }
        let index = PathIndex::build(&self.root, &IndexOptions::default(), &self.build)?;
        hold_publish();
        if let Ok(mut slot) = guard::write(&self.index) {
            *slot = Some(index);
        }
        Ok(())
    }

    /// Record what a build did. A build the close stopped says nothing; any other failure, and a
    /// worker that panicked, is kept so `indexQuery` can answer with it.
    fn finish_index(&self, built: Result<(), Error>) {
        match built {
            Ok(()) => {}
            Err(error) if error.code() == "ABORTED" => {}
            Err(error) => {
                eprintln!("ace-files: index for root {}: {error}", self.id);
                if let Ok(mut failure) = guard::lock(&self.failure) {
                    *failure = Some(error.failure().message);
                }
            }
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
        if self.is_closed() {
            return Err(Error::InvalidArgument(format!(
                "root {} was closed",
                self.id
            )));
        }
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
        };
        *slot = Some(Watcher::start(self.root.clone(), options, sink)?);
        Ok(())
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
        match guard::lock(&self.failure)?.take() {
            Some(message) => Err(Error::System(std::io::Error::other(format!(
                "the quick-open index could not be built: {message}"
            )))),
            None => Ok(empty_index()),
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
