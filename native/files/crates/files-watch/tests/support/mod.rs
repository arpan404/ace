// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]
// Each test binary compiles this module and uses a different part of it.
#![allow(dead_code)]

//! The harness both watcher test files share: one watcher, one temp folder, a recorded sink.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use files_safe::Root;
use files_watch::{Batch, Change, ChangeKind, WatchOptions, Watcher};

pub const DEBOUNCE: Duration = Duration::from_millis(100);
/// How long a test watches for an answer before calling it missing. FSEvents on a loaded machine
/// can take many seconds to hand an event over, and a wait that is too short reads as a watcher
/// that said nothing.
pub const WAIT: Duration = Duration::from_secs(30);
const SETTLE: Duration = Duration::from_secs(2);

/// One session at a time, so one test's burst never delays the OS events another test is timing.
/// Many watches in one process is covered on purpose by `promptness.rs`.
static SERIAL: Mutex<()> = Mutex::new(());

pub struct Session {
    _watcher: Watcher,
    dir: tempfile::TempDir,
    batches: Arc<Mutex<Vec<Batch>>>,
    /// When the sink received each batch in `batches`, in the same order.
    arrivals: Arc<Mutex<Vec<Instant>>>,
    debounce: Duration,
    // Last, so the OS watch is closed before the next test takes the lock.
    _serial: MutexGuard<'static, ()>,
}

impl Session {
    pub fn start(options: WatchOptions, prepare: impl FnOnce(&Path)) -> Session {
        let serial = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
        caught_up();
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path());
        // FSEvents replays the last second of the journal when a stream starts, which would
        // resurface whatever `prepare` wrote as creations; let that history age out first.
        std::thread::sleep(Duration::from_millis(1_200));
        let root = Root::open(dir.path()).unwrap();
        let batches = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&batches);
        let arrivals = Arc::new(Mutex::new(Vec::new()));
        let arrived = Arc::clone(&arrivals);
        let debounce = options.debounce;
        let watcher = Watcher::start(
            root,
            options,
            Box::new(move |batch| {
                // One lock for both, so a reader never sees a batch without its time.
                let mut recorded = recorded.lock().unwrap_or_else(PoisonError::into_inner);
                arrived
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(Instant::now());
                recorded.push(batch);
            }),
        )
        .unwrap();
        Session {
            _watcher: watcher,
            dir,
            batches,
            arrivals,
            debounce,
            _serial: serial,
        }
    }

    /// Names the folders the watcher's caller has open.
    pub fn focus(&self, folders: Vec<String>) {
        self._watcher.focus(folders);
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }

    /// How long the sink has to stay silent for a burst of batches to count as finished.
    pub fn quiet(&self) -> Duration {
        self.debounce.saturating_mul(3).max(SETTLE)
    }

    pub fn seen(&self) -> Vec<Batch> {
        self.batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Waits until at least one batch arrived and the sink has been quiet for a while.
    pub fn settle(&self) -> Vec<Batch> {
        let deadline = Instant::now() + WAIT;
        let mut last = 0;
        let mut quiet_since = Instant::now();
        loop {
            let count = self
                .batches
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .len();
            if count != last {
                last = count;
                quiet_since = Instant::now();
            }
            if count > 0 && quiet_since.elapsed() >= self.quiet() {
                return self.seen();
            }
            if Instant::now() >= deadline {
                return self.seen();
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Waits until some change names `path`, whatever its kind, then for the sink to go quiet.
    pub fn settle_on(&self, path: &str) -> Vec<Batch> {
        let deadline = Instant::now() + WAIT;
        while !changes(&self.seen())
            .iter()
            .any(|change| change.path == path)
        {
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        self.settle()
    }

    /// Waits for one change, whichever batch carries it.
    pub fn wait_for(&self, path: &str, kind: ChangeKind) -> Change {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(change) = changes(&self.seen())
                .into_iter()
                .find(|change| change.path == path && change.kind == kind)
            {
                return change;
            }
            if Instant::now() >= deadline {
                panic!(
                    "no {kind:?} for {path} within {WAIT:?}; saw {:?}",
                    self.seen()
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Waits for one change and returns the batch that carried it with the moment the sink
    /// received it, so a latency is measured to the delivery and not to the test's next poll.
    pub fn wait_for_delivery(&self, path: &str, kind: ChangeKind) -> (Vec<Change>, Instant) {
        let deadline = Instant::now() + WAIT;
        loop {
            {
                let batches = self.batches.lock().unwrap_or_else(PoisonError::into_inner);
                let arrivals = self.arrivals.lock().unwrap_or_else(PoisonError::into_inner);
                for (batch, at) in batches.iter().zip(arrivals.iter()) {
                    if let Batch::Changes(changes) = batch
                        && changes
                            .iter()
                            .any(|change| change.path == path && change.kind == kind)
                    {
                        return (changes.clone(), *at);
                    }
                }
            }
            if Instant::now() >= deadline {
                panic!(
                    "no {kind:?} for {path} within {WAIT:?}; saw {:?}",
                    self.seen()
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Waits for a rescan and returns the folder it names.
    pub fn wait_for_rescan(&self) -> Option<String> {
        let deadline = Instant::now() + WAIT;
        loop {
            for batch in self.seen() {
                if let Batch::Rescan { dir } = batch {
                    return dir;
                }
            }
            if Instant::now() >= deadline {
                panic!("no rescan within {WAIT:?}; saw {:?}", self.seen());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

pub fn options() -> WatchOptions {
    WatchOptions {
        debounce: DEBOUNCE,
        max_wait: Duration::from_secs(1),
        exclude: Vec::new(),
        max_batch: 5_000,
    }
}

pub fn changes(batches: &[Batch]) -> Vec<Change> {
    let mut changes = Vec::new();
    for batch in batches {
        match batch {
            Batch::Changes(reported) => changes.extend(reported.iter().cloned()),
            Batch::Warning(message) => panic!("unexpected warning: {message}"),
            Batch::Rescan { .. } => {}
        }
    }
    changes
}

/// Whether a rescan of `dir` covers `path`: the whole root, the folder `path` sits in, or a folder
/// above that one.
pub fn covers(dir: Option<&str>, path: &str) -> bool {
    match dir {
        None => true,
        Some(dir) => {
            path == dir
                || path
                    .strip_prefix(dir)
                    .is_some_and(|rest| rest.starts_with('/'))
        }
    }
}

/// The paths no batch accounts for.
///
/// A path is accounted for by a change naming it, by a change naming the folder that holds it (a
/// folder change says "the contents of this folder changed", which a consumer answers by walking
/// or listing it), or by a rescan of a folder that covers it. A burst may be delivered as change
/// batches or as one rescan of its folder, so this is what a test asserts instead of picking one
/// of them.
pub fn unaccounted(batches: &[Batch], expected: &[String]) -> Vec<String> {
    let reported = changes(batches);
    let rescans: Vec<Option<&str>> = batches
        .iter()
        .filter_map(|batch| match batch {
            Batch::Rescan { dir } => Some(dir.as_deref()),
            _ => None,
        })
        .collect();
    expected
        .iter()
        .filter(|path| {
            let named = reported
                .iter()
                .any(|change| named_change_covers(change, path));
            !named && !rescans.iter().any(|dir| covers(*dir, path))
        })
        .cloned()
        .collect()
}

/// Whether a change accounts for `path`: it names the path, or it is about the folder that holds
/// it and says that folder's contents changed.
///
/// A deletion never accounts for anything here: it says a name is gone, which is the opposite of
/// the create a burst test is looking for. A deletion of a folder does not cover the names it
/// used to hold either.
fn named_change_covers(change: &Change, path: &str) -> bool {
    if change.kind == ChangeKind::Deleted {
        return false;
    }
    change.path == path || (change.directory && covers(Some(&change.path), path))
}

/// How long [`caught_up`] waits for the OS watcher to report a fresh write.
const CATCH_UP: Duration = Duration::from_secs(180);

/// Waits until the OS watcher reports a write made now, so a test starts with nothing queued ahead
/// of it.
///
/// fseventsd is one process serving every client on a Mac, and a burst written by an earlier test
/// (or by anything else on the machine) can keep it busy for a minute and more; a test that starts
/// in that backlog sees its own events late. The write goes into a subfolder nobody has open, so
/// only the OS watch can report it: the watcher's own checks of open folders would not.
pub fn caught_up() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let seen = Arc::new(Mutex::new(false));
    let recorded = Arc::clone(&seen);
    let watcher = Watcher::start(
        Root::open(dir.path()).unwrap(),
        options(),
        Box::new(move |batch| {
            if let Batch::Changes(changes) = batch
                && changes.iter().any(|change| change.path == "sub/sentinel")
            {
                *recorded.lock().unwrap_or_else(PoisonError::into_inner) = true;
            }
        }),
    )
    .unwrap();
    std::fs::write(dir.path().join("sub/sentinel"), b"x").unwrap();
    let deadline = Instant::now() + CATCH_UP;
    while !*seen.lock().unwrap_or_else(PoisonError::into_inner) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    drop(watcher);
}
