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
#[cfg(feature = "test-hooks")]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::runtime::Handle;

use files_index::PathIndex;
use files_list::Lister;
use files_safe::Root;
use files_watch::{Batch, WatchOptions, Watcher};

use crate::error::Error;
use crate::guard;
use crate::ops::watch;
use crate::quick_open::IndexBook;
use crate::subscriptions::{Kind, Subscriptions};
use crate::writer::Out;

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

/// How many root entries the process holds. Test-only: with the `test-hooks` feature, setting
/// `ACE_FILES_LIVE_ROOTS` makes the binary print the count on stderr whenever a root is dropped, so
/// a test can prove `closeRoot` released its root rather than leaking the watcher that points back
/// at it.
#[cfg(feature = "test-hooks")]
static LIVE_ROOTS: AtomicUsize = AtomicUsize::new(0);

/// Every root the daemon has open, by the number `openRoot` handed out.
pub struct Roots {
    inner: Mutex<HashMap<u64, Arc<RootEntry>>>,
    next: AtomicU64,
    /// Where a rebuild is spawned from. The watcher thread asks for one, and it has no runtime of
    /// its own.
    handle: Handle,
}

impl Roots {
    /// The open roots of one running daemon.
    pub fn new(handle: Handle) -> Roots {
        Roots {
            inner: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            handle,
        }
    }

    /// Open a checkout and keep it until `closeRoot`.
    pub fn open(&self, path: &Path) -> Result<Arc<RootEntry>, Error> {
        let root = Root::open(path)?;
        let lister = Arc::new(Lister::new(root.clone()));
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        #[cfg(feature = "test-hooks")]
        LIVE_ROOTS.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(RootEntry {
            id,
            root,
            lister,
            index: RwLock::new(None),
            book: Mutex::new(IndexBook::default()),
            build: AtomicBool::new(false),
            handle: self.handle.clone(),
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
    pub(crate) id: u64,
    pub(crate) root: Root,
    lister: Arc<Lister>,
    /// The index quick open is served from. An `Arc` so a watcher batch can prepare its update on
    /// a clone, without holding the read lock across the walk `prepare` does.
    pub(crate) index: RwLock<Option<Arc<PathIndex>>>,
    pub(crate) book: Mutex<IndexBook>,
    pub(crate) build: AtomicBool,
    /// Where a rebuild is spawned from, for the watcher thread that has no runtime of its own.
    pub(crate) handle: Handle,
    /// Set by `closeRoot` before anything is torn down. A watcher start or a subscription that
    /// races the close sees it and refuses, so a closed root leaves no thread or subscription.
    closed: AtomicBool,
    watcher: Mutex<Option<Watcher>>,
}

impl Drop for RootEntry {
    fn drop(&mut self) {
        #[cfg(feature = "test-hooks")]
        {
            let live = LIVE_ROOTS.fetch_sub(1, Ordering::Relaxed) - 1;
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
            max_wait: MAX_WAIT,
        };
        *slot = Some(Watcher::start(self.root.clone(), options, sink)?);
        Ok(())
    }
}
