// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]

//! Watcher behaviour on real temp folders.
//!
//! The OS delivers events in bursts: FSEvents regularly takes a second, so every wait is
//! generous and a test that expects nothing writes another file afterwards to prove the
//! watcher was alive. One watcher runs per test, because several FSEvents streams in one
//! process interfere.

use std::time::Duration;

use files_watch::{Batch, Change, ChangeKind, WatchOptions};

mod support;

use support::{Session, changes, options};

/// Waits a quiet period and returns everything the sink saw.
fn after_quiet(session: &Session) -> Vec<Batch> {
    std::thread::sleep(session.quiet());
    session.seen()
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
            max_wait: Duration::from_secs(8),
            ..options()
        },
        |_| {},
    );
    std::fs::write(session.path("fleeting.txt"), b"brief").unwrap();
    std::thread::sleep(Duration::from_millis(2_000));
    std::fs::remove_file(session.path("fleeting.txt")).unwrap();
    let reported = changes(&after_quiet(&session));
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
    // A slow disk can stall between a removal and the write that recreates the file. The wide
    // window keeps all twenty pairs in one batch, which is what the rule is about; split
    // across windows, the removal is a truthful deletion and a later creation follows.
    let session = Session::start(
        WatchOptions {
            debounce: Duration::from_secs(2),
            ..options()
        },
        |root| {
            for index in 0..20 {
                std::fs::write(root.join(format!("file{index}.txt")), b"old").unwrap();
            }
        },
    );
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
fn an_atomic_save_never_reports_the_saved_file_deleted() {
    // A rename over an existing file can arrive as Created or Modified depending on how the OS
    // splits the window; either keeps the file in the tree. A Deleted would drop it.
    let session = Session::start(options(), |root| {
        std::fs::write(root.join("x.txt"), b"old").unwrap();
    });
    std::fs::write(session.path("x.tmp"), b"new").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    std::fs::rename(session.path("x.tmp"), session.path("x.txt")).unwrap();
    let reported = changes(&session.settle());
    let last = reported
        .iter()
        .rev()
        .find(|change| change.path == "x.txt")
        .unwrap_or_else(|| panic!("no change for x.txt, saw {reported:?}"));
    assert_ne!(last.kind, ChangeKind::Deleted, "saw {reported:?}");
    assert!(!last.directory);
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

#[cfg(unix)]
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
            debounce: Duration::from_millis(3_000),
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
