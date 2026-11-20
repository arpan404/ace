// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]
#![cfg(windows)]

//! Windows-only watching: a kernel burst becomes rescans and the watch recovers.
//!
//! This is the behaviour `notify` cannot give the crate: it discards the status that says the
//! kernel lost events. The `ReadDirectoryChangesW` backend turns that status into a rescan and
//! arms the watch again.

use std::time::Duration;

use files_watch::{Batch, ChangeKind};

mod support;

use support::{Session, changes, options};

#[test]
fn a_flood_of_fifty_thousand_files_is_rescans_and_watching_continues() {
    // ReadDirectoryChangesW's 64 KiB buffer cannot hold this burst, so the kernel overflows
    // (the status this backend turns into a rescan) or the coalescer sees more than max_batch
    // changes (also a rescan). A burst this long also gets checkpoint rescans while it runs,
    // but never a wall of changes, and the watch must still report what happens next.
    let session = Session::start(
        files_watch::WatchOptions {
            debounce: Duration::from_millis(3_000),
            ..options()
        },
        |root| {
            std::fs::create_dir(root.join("flood")).unwrap();
        },
    );
    for index in 0..50_000 {
        std::fs::write(session.path(&format!("flood/file{index}")), b"x").unwrap();
    }
    let dir = session.wait_for_rescan();
    assert!(
        dir.is_none() || dir.as_deref() == Some("flood"),
        "a flood rescans the flood folder or the root, got {dir:?}"
    );

    // Changes written while the rescan's window is open are covered by it, so keep writing
    // until one is reported: that is what proves the watch survived the flood. Each probe is
    // spaced wider than max_wait so the window can close between them once the burst's
    // backlog is drained, which takes a while on a busy machine.
    let mut reported = false;
    for index in 0..25 {
        std::fs::write(session.path(&format!("after{index}.txt")), b"after").unwrap();
        std::thread::sleep(Duration::from_millis(1_300));
        if changes(&session.seen())
            .iter()
            .any(|change| change.path.starts_with("after") && change.kind == ChangeKind::Created)
        {
            reported = true;
            break;
        }
    }
    assert!(
        reported,
        "the watch stopped reporting after the flood; saw {:?}",
        session.seen()
    );

    let batches = session.seen();
    let rescans: Vec<Option<&str>> = batches
        .iter()
        .filter_map(|batch| match batch {
            Batch::Rescan { dir } => Some(dir.as_deref()),
            _ => None,
        })
        .collect();
    assert!(!rescans.is_empty(), "the flood is reported as a rescan");
    assert!(
        rescans
            .iter()
            .all(|dir| dir.is_none() || *dir == Some("flood")),
        "every rescan names the flood folder or the root, saw {rescans:?}"
    );
}

#[test]
fn a_file_moved_out_of_the_tree_is_reported_deleted() {
    // A move out of the watched tree names only the old half of the rename. Nothing will ever
    // pair with it, so the watch reports the deletion on its own.
    let outside = tempfile::tempdir().unwrap();
    let session = Session::start(options(), |root| {
        std::fs::write(root.join("moving.txt"), b"x").unwrap();
    });
    std::fs::rename(session.path("moving.txt"), outside.path().join("moved.txt")).unwrap();
    session.wait_for("moving.txt", ChangeKind::Deleted);
}
