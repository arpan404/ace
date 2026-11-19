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
pub const WAIT: Duration = Duration::from_secs(15);
const SETTLE: Duration = Duration::from_secs(2);

/// One OS watcher at a time: several FSEvents streams in one process interfere on macOS.
static SERIAL: Mutex<()> = Mutex::new(());

pub struct Session {
    _watcher: Watcher,
    dir: tempfile::TempDir,
    batches: Arc<Mutex<Vec<Batch>>>,
    debounce: Duration,
    // Last, so the OS watch is closed before the next test takes the lock.
    _serial: MutexGuard<'static, ()>,
}

impl Session {
    pub fn start(options: WatchOptions, prepare: impl FnOnce(&Path)) -> Session {
        let serial = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
        let dir = tempfile::tempdir().unwrap();
        prepare(dir.path());
        // FSEvents replays the last second of the journal when a stream starts, which would
        // resurface whatever `prepare` wrote as creations; let that history age out first.
        std::thread::sleep(Duration::from_millis(1_200));
        let root = Root::open(dir.path()).unwrap();
        let batches = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&batches);
        let debounce = options.debounce;
        let watcher = Watcher::start(
            root,
            options,
            Box::new(move |batch| {
                recorded
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(batch);
            }),
        )
        .unwrap();
        Session {
            _watcher: watcher,
            dir,
            batches,
            debounce,
            _serial: serial,
        }
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
