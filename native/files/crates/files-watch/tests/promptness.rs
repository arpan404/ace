// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]

//! How soon a change reaches the caller: a lone change in a quiet folder within half a second,
//! and a change made the moment `Watcher::start` returns, even with many watches in one process.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use files_safe::Root;
use files_watch::{Batch, ChangeKind, WatchOptions, Watcher};

mod support;

use support::{Session, changes};

/// The longest a lone change in a quiet folder may take to reach the sink.
const PROMPT: Duration = Duration::from_millis(500);

/// What the daemon passes, so the latency measured is the one the Files panel sees.
fn daemon_options() -> WatchOptions {
    WatchOptions {
        debounce: Duration::from_millis(75),
        max_wait: Duration::from_secs(1),
        exclude: Vec::new(),
        max_batch: 5_000,
    }
}

/// How long one change took to be reported, measured from just before it was made.
fn timed(session: &Session, path: &str, kind: ChangeKind, change: impl FnOnce()) -> Duration {
    let started = Instant::now();
    change();
    session.wait_for(path, kind);
    started.elapsed()
}

#[test]
fn a_lone_create_delete_and_rename_in_a_quiet_folder_arrive_within_half_a_second() {
    // The root is always one of the open folders, so on macOS the kernel's word on it arrives
    // without waiting for fseventsd, which on a loaded machine hands a lone change over hundreds
    // of milliseconds late.
    let session = Session::start(daemon_options(), |root| {
        for index in 0..10 {
            std::fs::write(root.join(format!("old{index}.txt")), b"x").unwrap();
        }
    });
    let mut took = Vec::new();
    // Several rounds, each after a quiet spell, because a long-running watch that answers its
    // first change quickly and a later one late is exactly what this guards.
    for round in 0..5 {
        std::thread::sleep(Duration::from_millis(300));
        let created = format!("new{round}.txt");
        took.push(timed(&session, &created, ChangeKind::Created, || {
            std::fs::write(session.path(&created), b"x").unwrap();
        }));

        std::thread::sleep(Duration::from_millis(300));
        let deleted = format!("old{round}.txt");
        took.push(timed(&session, &deleted, ChangeKind::Deleted, || {
            std::fs::remove_file(session.path(&deleted)).unwrap();
        }));

        std::thread::sleep(Duration::from_millis(300));
        let from = format!("old{}.txt", round + 5);
        let to = format!("renamed{round}.txt");
        took.push(timed(&session, &to, ChangeKind::Created, || {
            std::fs::rename(session.path(&from), session.path(&to)).unwrap();
        }));
        session.wait_for(&from, ChangeKind::Deleted);
    }
    took.sort();
    let median = took[took.len() / 2];
    let slowest = took[took.len() - 1];
    eprintln!("lone changes: median {median:?}, all {took:?}");
    assert!(
        slowest <= PROMPT,
        "a lone change must arrive within {PROMPT:?}: median {median:?}, all {took:?}"
    );
}

/// One watcher over its own folder, recording what it hears.
struct Watched {
    _watcher: Watcher,
    dir: tempfile::TempDir,
    batches: Arc<Mutex<Vec<Batch>>>,
}

impl Watched {
    fn start(dir: tempfile::TempDir) -> Watched {
        let batches = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&batches);
        let watcher = Watcher::start(
            Root::open(dir.path()).unwrap(),
            daemon_options(),
            Box::new(move |batch| {
                recorded
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(batch);
            }),
        )
        .unwrap();
        Watched {
            _watcher: watcher,
            dir,
            batches,
        }
    }

    fn heard(&self, path: &str, kind: ChangeKind) -> bool {
        let batches = self
            .batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        changes(&batches)
            .iter()
            .any(|change| change.path == path && change.kind == kind)
    }

    fn path(&self, rel: &str) -> std::path::PathBuf {
        self.dir.path().join(rel)
    }
}

fn prepared(write: impl Fn(&Path)) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path());
    dir
}

#[test]
fn a_rename_made_the_moment_the_watch_starts_is_reported_with_many_watches_running() {
    // Many watches in one process is the suite and the daemon: each root has one. A stream that
    // starts at "now" as the OS sees it misses a change made right after the call returns when
    // the OS is slow to register it, and the rename is then never reported at all.
    const WATCHES: usize = 32;
    support::caught_up();
    let folders: Vec<tempfile::TempDir> = (0..WATCHES)
        .map(|_| prepared(|root| std::fs::write(root.join("before.txt"), b"x").unwrap()))
        .collect();
    // Let the writes above age out of the journal, so only the rename below is news.
    std::thread::sleep(Duration::from_millis(1_200));
    let watched: Vec<Watched> = folders
        .into_iter()
        .map(|dir| {
            let watched = Watched::start(dir);
            std::fs::rename(watched.path("before.txt"), watched.path("after.txt")).unwrap();
            watched
        })
        .collect();

    let deadline = Instant::now() + support::WAIT;
    loop {
        let missing: Vec<usize> = watched
            .iter()
            .enumerate()
            .filter(|(_, watched)| {
                !(watched.heard("before.txt", ChangeKind::Deleted)
                    && watched.heard("after.txt", ChangeKind::Created))
            })
            .map(|(index, _)| index)
            .collect();
        if missing.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{} of {WATCHES} watches never reported the rename made as they started: {missing:?}",
            missing.len()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn a_change_in_an_open_folder_arrives_promptly_right_after_a_burst_elsewhere() {
    // A burst anywhere on the volume queues behind fseventsd for every client; on a loaded Mac a
    // write after twenty thousand creates waited more than a minute and a half. The folder a
    // person has open must not wait behind it.
    let burst = tempfile::tempdir().unwrap();
    let session = Session::start(daemon_options(), |root| {
        std::fs::create_dir(root.join("src")).unwrap();
    });
    session.focus(vec!["src".to_owned()]);
    for index in 0..20_000 {
        std::fs::write(burst.path().join(format!("f{index}")), b"x").unwrap();
    }
    let took = timed(&session, "src/after.txt", ChangeKind::Created, || {
        std::fs::write(session.path("src/after.txt"), b"x").unwrap();
    });
    eprintln!("change after a burst elsewhere: {took:?}");
    assert!(
        took <= Duration::from_secs(2),
        "an open folder's change waited {took:?} behind a burst elsewhere"
    );
}
