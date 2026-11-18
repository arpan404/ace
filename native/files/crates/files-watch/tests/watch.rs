// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]

//! Watcher behaviour on real temp folders.
//!
//! The OS delivers events in bursts: FSEvents regularly takes a second, so every wait is
//! generous and a test that expects nothing writes another file afterwards to prove the
//! watcher was alive. One watcher runs per test, because several FSEvents streams in one
//! process interfere.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use files_safe::Root;
use files_watch::{Batch, Change, ChangeKind, WatchOptions, Watcher};

const DEBOUNCE: Duration = Duration::from_millis(100);
const WAIT: Duration = Duration::from_secs(15);
const SETTLE: Duration = Duration::from_secs(2);

/// One OS watcher at a time: several FSEvents streams in one process interfere on macOS.
static SERIAL: Mutex<()> = Mutex::new(());

struct Session {
    _watcher: Watcher,
    dir: tempfile::TempDir,
    batches: Arc<Mutex<Vec<Batch>>>,
    debounce: Duration,
    // Last, so the OS watch is closed before the next test takes the lock.
    _serial: MutexGuard<'static, ()>,
}

impl Session {
    fn start(options: WatchOptions, prepare: impl FnOnce(&Path)) -> Session {
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

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }

    /// How long the sink has to stay silent for a burst of batches to count as finished.
    fn quiet(&self) -> Duration {
        self.debounce.saturating_mul(3).max(SETTLE)
    }

    fn seen(&self) -> Vec<Batch> {
        self.batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Waits until at least one batch arrived and the sink has been quiet for a while.
    fn settle(&self) -> Vec<Batch> {
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

    /// Waits for one change, whichever batch carries it.
    fn wait_for(&self, path: &str, kind: ChangeKind) -> Change {
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
    fn wait_for_rescan(&self) -> Option<String> {
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

    /// Waits a quiet period and returns everything the sink saw.
    fn after_quiet(&self) -> Vec<Batch> {
        std::thread::sleep(self.quiet());
        self.seen()
    }
}

fn options() -> WatchOptions {
    WatchOptions {
        debounce: DEBOUNCE,
        max_wait: Duration::from_secs(1),
        exclude: Vec::new(),
        max_batch: 5_000,
    }
}

fn changes(batches: &[Batch]) -> Vec<Change> {
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

#[test]
fn reports_a_created_file() {
    let session = Session::start(options(), |_| {});
    std::fs::write(session.path("hello.txt"), b"hi").unwrap();
    let change = session.wait_for("hello.txt", ChangeKind::Created);
    assert!(!change.directory);
}

#[test]
fn reports_a_deleted_folder() {
    let session = Session::start(options(), |root| {
        std::fs::create_dir(root.join("doomed")).unwrap();
        std::fs::write(root.join("doomed/inner.txt"), b"inner").unwrap();
    });
    std::fs::remove_dir_all(session.path("doomed")).unwrap();
    let change = session.wait_for("doomed", ChangeKind::Deleted);
    assert!(change.directory);
}

#[test]
fn rename_is_delete_plus_create() {
    let session = Session::start(options(), |root| {
        std::fs::write(root.join("before.txt"), b"content").unwrap();
    });
    std::fs::rename(session.path("before.txt"), session.path("after.txt")).unwrap();
    session.wait_for("before.txt", ChangeKind::Deleted);
    session.wait_for("after.txt", ChangeKind::Created);
}

#[test]
fn create_then_delete_in_one_window_reports_nothing() {
    // The gap makes FSEvents report the creation on its own, which is the case the rule is
    // about; the debounce is wide enough to hold both deliveries in one window. When FSEvents
    // still merges them, the pair can only arrive as the deletion of a path that is gone, and
    // what must never reach the tree is a creation for a file that no longer exists.
    let session = Session::start(
        WatchOptions {
            debounce: Duration::from_millis(6_000),
            ..options()
        },
        |_| {},
    );
    std::fs::write(session.path("fleeting.txt"), b"brief").unwrap();
    std::thread::sleep(Duration::from_millis(1_000));
    std::fs::remove_file(session.path("fleeting.txt")).unwrap();
    let reported = changes(&session.after_quiet());
    assert!(
        reported.is_empty(),
        "a create and delete in one window cancels out, saw {reported:?}"
    );
    std::fs::write(session.path("kept.txt"), b"kept").unwrap();
    session.wait_for("kept.txt", ChangeKind::Created);
}

#[test]
fn many_writes_to_one_file_coalesce() {
    let session = Session::start(
        WatchOptions {
            debounce: Duration::from_millis(1_500),
            ..options()
        },
        |root| std::fs::write(root.join("hot.txt"), b"").unwrap(),
    );
    for index in 0..20 {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(session.path("hot.txt"))
            .unwrap();
        std::io::Write::write_all(&mut file, format!("{index}\n").as_bytes()).unwrap();
    }
    let reported: Vec<Change> = changes(&session.settle())
        .into_iter()
        .filter(|change| change.path == "hot.txt")
        .collect();
    assert_eq!(reported.len(), 1, "one change per quiet period");
    // FSEvents puts its created flag on writes to a file it did not watch being created, so
    // a write can be named a creation; what this test guards is that the writes are one change.
    assert!(matches!(
        reported[0].kind,
        ChangeKind::Created | ChangeKind::Modified
    ));
}

#[test]
fn burst_over_max_batch_becomes_rescan() {
    let session = Session::start(
        WatchOptions {
            max_batch: 5,
            ..options()
        },
        |root| std::fs::create_dir(root.join("burst")).unwrap(),
    );
    for index in 0..20 {
        std::fs::write(session.path(&format!("burst/file{index}.txt")), b"x").unwrap();
    }
    let dir = session.wait_for_rescan();
    // A rescan of the root is also what FSEvents' own overflow asks for; both are correct.
    assert!(
        dir.is_none() || dir.as_deref() == Some("burst"),
        "a burst over max_batch rescans the burst folder, got {dir:?}"
    );
    let batches = session.seen();
    assert!(
        batches
            .iter()
            .all(|batch| !matches!(batch, Batch::Changes(changes) if changes.len() > 5)),
        "no batch reports more changes than max_batch, saw {batches:?}"
    );
}

#[test]
fn excluded_folders_report_nothing() {
    let session = Session::start(
        WatchOptions {
            exclude: vec!["**/node_modules".to_owned()],
            ..options()
        },
        |root| {
            std::fs::create_dir_all(root.join("node_modules/react")).unwrap();
            std::fs::write(root.join("node_modules/react/index.js"), b"module").unwrap();
        },
    );
    std::fs::write(session.path("node_modules/react/other.js"), b"module").unwrap();
    std::fs::write(session.path("src.txt"), b"source").unwrap();
    session.wait_for("src.txt", ChangeKind::Created);
    session.settle();
    let reported = changes(&session.seen());
    assert!(
        !reported
            .iter()
            .any(|change| change.path.starts_with("node_modules")),
        "excluded folders must not be reported, saw {reported:?}"
    );
}

#[test]
fn new_subfolder_is_watched() {
    let session = Session::start(options(), |_| {});
    std::fs::create_dir(session.path("fresh")).unwrap();
    std::fs::write(session.path("fresh/inside.txt"), b"inside").unwrap();
    session.wait_for("fresh/inside.txt", ChangeKind::Created);
}

#[test]
fn deleting_and_recreating_files_never_reports_deleted() {
    let session = Session::start(options(), |root| {
        for index in 0..20 {
            std::fs::write(root.join(format!("file{index}.txt")), b"old").unwrap();
        }
    });
    for index in 0..20 {
        let path = session.path(&format!("file{index}.txt"));
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"new").unwrap();
    }
    let reported = changes(&session.settle());
    for index in 0..20 {
        let path = format!("file{index}.txt");
        let change = reported
            .iter()
            .find(|change| change.path == path)
            .unwrap_or_else(|| panic!("no change for {path}, saw {reported:?}"));
        assert_ne!(
            change.kind,
            ChangeKind::Deleted,
            "{path} is still there, saw {reported:?}"
        );
    }
}

#[test]
fn an_atomic_save_is_a_modification() {
    let session = Session::start(options(), |root| {
        std::fs::write(root.join("x.txt"), b"old").unwrap();
    });
    std::fs::write(session.path("x.tmp"), b"new").unwrap();
    std::fs::rename(session.path("x.tmp"), session.path("x.txt")).unwrap();
    let change = session.wait_for("x.txt", ChangeKind::Modified);
    assert!(!change.directory);
}

#[test]
fn a_renamed_in_folder_reports_its_files() {
    let session = Session::start(options(), |root| {
        std::fs::create_dir(root.join("src")).unwrap();
        for name in ["one.txt", "two.txt", "three.txt"] {
            std::fs::write(root.join("src").join(name), b"x").unwrap();
        }
    });
    std::fs::rename(session.path("src"), session.path("dst")).unwrap();
    session.wait_for("src", ChangeKind::Deleted);
    for name in ["one.txt", "two.txt", "three.txt"] {
        session.wait_for(&format!("dst/{name}"), ChangeKind::Created);
    }
}

#[test]
fn a_symlink_is_one_file_change_and_its_tree_is_never_walked() {
    let session = Session::start(options(), |_| {});
    std::os::unix::fs::symlink("/usr", session.path("link")).unwrap();
    let change = session.wait_for("link", ChangeKind::Created);
    assert!(!change.directory, "a link is not the tree it points at");
    session.settle();
    let reported = changes(&session.seen());
    assert!(
        !reported
            .iter()
            .any(|change| change.path.starts_with("link/")),
        "nothing inside a symbolic link is reported, saw {reported:?}"
    );
}

#[test]
fn a_burst_of_twenty_thousand_files_is_one_rescan() {
    let session = Session::start(
        WatchOptions {
            debounce: Duration::from_millis(2_000),
            ..options()
        },
        |root| {
            std::fs::create_dir(root.join("many")).unwrap();
        },
    );
    for index in 0..20_000 {
        std::fs::write(session.path(&format!("many/file{index}")), b"x").unwrap();
    }
    session.settle();
    let rescans = session
        .seen()
        .iter()
        .filter(|batch| matches!(batch, Batch::Rescan { .. }))
        .count();
    assert_eq!(rescans, 1, "one rescan per burst");
}

#[cfg(target_os = "linux")]
#[test]
fn a_folder_moved_away_and_recreated_is_watched() {
    let session = Session::start(options(), |root| {
        std::fs::create_dir(root.join("a")).unwrap();
        std::fs::write(root.join("a/old.txt"), b"x").unwrap();
    });
    std::fs::rename(session.path("a"), session.path("b")).unwrap();
    std::fs::create_dir(session.path("a")).unwrap();
    std::fs::write(session.path("a/x"), b"x").unwrap();
    session.wait_for("a/x", ChangeKind::Created);
}
