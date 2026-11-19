// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]

//! Watcher behaviour on real temp folders.
//!
//! The OS delivers events in bursts: FSEvents regularly takes a second, so every wait is
//! generous and a test that expects nothing writes another file afterwards to prove the
//! watcher was alive. One session runs at a time, so a burst in one test does not slow the OS
//! events another test waits for.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use files_watch::{Batch, Change, ChangeKind, WatchOptions};

mod support;

use support::{Session, WAIT, changes, options};

/// How long a burst the OS hands over slowly may take to be fully reported. A twenty-thousand
/// create burst can dribble out of the OS for half a minute on a busy machine, and the watcher's
/// own windows are counted from its events, so the completeness wait is generous.
const BURST_WAIT: Duration = Duration::from_secs(60);

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
fn a_case_only_rename_reports_the_old_spelling_deleted_and_the_new_created() {
    // On a volume that ignores case the old path still resolves to the entry under its new
    // spelling; probing must answer for the spelling asked for, or the old name stays indexed.
    let session = Session::start(options(), |root| {
        std::fs::write(root.join("foo.txt"), b"content").unwrap();
    });
    std::fs::rename(session.path("foo.txt"), session.path("Foo.txt")).unwrap();
    session.wait_for("foo.txt", ChangeKind::Deleted);
    session.wait_for("Foo.txt", ChangeKind::Created);
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
fn a_burst_over_max_batch_never_sends_an_oversized_batch() {
    // A window over max_batch becomes one rescan of the folder holding the changes; a window that
    // stays under it is sent as changes. Which one happens depends on how the OS delivers the
    // writes, so the test holds the watcher to what either delivery promises: no batch is larger
    // than the limit, and every create is reported or covered by a rescan.
    let session = Session::start(
        WatchOptions {
            max_batch: 5,
            ..options()
        },
        |root| std::fs::create_dir(root.join("burst")).unwrap(),
    );
    let expected: Vec<String> = (0..20)
        .map(|index| format!("burst/file{index}.txt"))
        .collect();
    for path in &expected {
        std::fs::write(session.path(path), b"x").unwrap();
    }
    let batches = session.settle();
    for batch in &batches {
        if let Batch::Changes(changes) = batch {
            assert!(
                changes.len() <= 5,
                "no batch reports more changes than max_batch, saw {}",
                changes.len()
            );
        }
    }
    let rescans = rescans(&batches);
    assert!(rescans <= 1, "one rescan per burst window, saw {rescans}");
    let unaccounted = support::unaccounted(&batches, &expected);
    assert!(
        unaccounted.is_empty(),
        "{} of {} creates were neither reported nor covered by a rescan, first {:?}",
        unaccounted.len(),
        expected.len(),
        unaccounted.first()
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
    let reported = changes(&session.settle_on("x.txt"));
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
fn a_burst_of_twenty_thousand_files_is_never_more_than_one_rescan() {
    // A burst may be described change by change when the OS hands the writes over in windows
    // smaller than max_batch, and a window over max_batch becomes one rescan of its folder.
    // Either delivery is right; the burst must be fully accounted for, and it may never cost
    // more than one rescan.
    //
    // A checkpoint comes after five max_wait periods; this window is far longer than the burst,
    // so a rescan here is the burst's own and not a mid-burst checkpoint (that path has its own
    // test).
    let session = Session::start(
        WatchOptions {
            debounce: Duration::from_millis(3_000),
            max_wait: Duration::from_secs(30),
            ..options()
        },
        |root| {
            std::fs::create_dir(root.join("many")).unwrap();
        },
    );
    let expected: Vec<String> = (0..20_000)
        .map(|index| format!("many/file{index}"))
        .collect();
    for path in &expected {
        std::fs::write(session.path(path), b"x").unwrap();
    }

    // The OS hands the writes over as fast as it can, and how long that takes is not the
    // watcher's to decide: wait for every create to be accounted for, then judge the delivery.
    let deadline = Instant::now() + BURST_WAIT;
    let mut unaccounted = support::unaccounted(&session.seen(), &expected);
    while !unaccounted.is_empty() {
        assert!(
            Instant::now() < deadline,
            "{} of {} creates were neither reported nor covered by a rescan, first {:?} \
             within {BURST_WAIT:?}",
            unaccounted.len(),
            expected.len(),
            unaccounted.first()
        );
        std::thread::sleep(Duration::from_millis(100));
        unaccounted = support::unaccounted(&session.seen(), &expected);
    }

    let batches = session.seen();
    for batch in &batches {
        if let Batch::Changes(changes) = batch {
            assert!(
                changes.len() <= options().max_batch,
                "no batch reports more changes than max_batch, saw {}",
                changes.len()
            );
        }
    }
    let seen = rescans(&batches);
    assert!(
        seen <= 1,
        "one rescan per burst window, saw {seen} in {batches:?}"
    );
}

#[test]
fn a_folder_replaced_after_an_empty_window_is_read_again() {
    // A window whose news cancels out still closes, and the folders read while it filled must not
    // be trusted afterwards: the folder is replaced and the next create has to be found in the
    // folder that is there now, not in the one the empty window opened.
    let session = Session::start(
        WatchOptions {
            debounce: Duration::from_millis(6_000),
            max_wait: Duration::from_secs(8),
            ..options()
        },
        |root| std::fs::create_dir(root.join("d")).unwrap(),
    );
    std::fs::write(session.path("d/transient.txt"), b"x").unwrap();
    std::thread::sleep(Duration::from_millis(2_000));
    std::fs::remove_file(session.path("d/transient.txt")).unwrap();
    // The pair cancels out: a window that holds both deliveries says nothing, and one the OS split
    // says only that the name is gone. Either way the readings from this window must not be what
    // the next one judges the replaced folder by.
    let reported = changes(&after_quiet(&session));
    assert!(
        reported
            .iter()
            .all(|change| change.path == "d" || change.path == "d/transient.txt"),
        "nothing but the transient name or its folder is news, saw {reported:?}"
    );
    assert!(
        !reported
            .iter()
            .any(|change| change.path == "d/transient.txt" && change.kind == ChangeKind::Created),
        "a creation for a file that is gone must not reach the caller, saw {reported:?}"
    );

    std::fs::remove_dir(session.path("d")).unwrap();
    std::fs::create_dir(session.path("d")).unwrap();
    std::fs::write(session.path("d/after.txt"), b"x").unwrap();
    session.wait_for("d/after.txt", ChangeKind::Created);
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

/// How many rescans the sink has seen.
fn rescans(batches: &[Batch]) -> usize {
    batches
        .iter()
        .filter(|batch| matches!(batch, Batch::Rescan { .. }))
        .count()
}

#[test]
fn a_burst_that_never_goes_quiet_still_reports_rescans() {
    // The writer never pauses, so the watcher's queue is never empty at a deadline. The burst
    // still has to reach the caller: a checkpoint rescan while it continues, and the final one
    // when it stops.
    let session = Session::start(
        WatchOptions {
            debounce: Duration::from_millis(50),
            max_wait: Duration::from_millis(100),
            exclude: Vec::new(),
            max_batch: 10,
        },
        |root| std::fs::create_dir(root.join("endless")).unwrap(),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let folder = session.path("endless");
    let writer = {
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut index = 0u64;
            while !stop.load(Ordering::Acquire) {
                std::fs::write(folder.join(format!("file{index}")), b"x").unwrap();
                index += 1;
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };

    let first = session.wait_for_rescan();
    assert!(
        first.is_none() || first.as_deref() == Some("endless"),
        "the checkpoint names the burst folder, got {first:?}"
    );
    assert!(
        !stop.load(Ordering::Acquire),
        "a checkpoint rescan arrives while the burst is still writing"
    );

    stop.store(true, Ordering::Release);
    writer.join().unwrap();

    let deadline = Instant::now() + WAIT;
    while rescans(&session.seen()) < 2 {
        assert!(
            Instant::now() < deadline,
            "the end of the burst gets its own rescan; saw {:?}",
            session.seen()
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    // The watch is still alive: either it names the new file, or it walks the folder again and
    // the write is covered by that. Both mean the endless burst did not end the watch.
    let before = session.seen().len();
    std::fs::write(session.path("endless/after.txt"), b"x").unwrap();
    let deadline = Instant::now() + WAIT;
    loop {
        let seen = session.seen();
        let named = seen.iter().skip(before).any(|batch| {
            matches!(batch, Batch::Changes(changes)
                if changes.iter().any(|change| change.path == "endless/after.txt"))
        });
        let walked = seen.iter().skip(before).any(|batch| {
            matches!(batch, Batch::Rescan { dir } if support::covers(dir.as_deref(), "endless/after.txt"))
        });
        if named || walked {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "a write after the burst was neither reported nor covered by a rescan; saw {:?}",
            &seen[before.min(seen.len())..]
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}
