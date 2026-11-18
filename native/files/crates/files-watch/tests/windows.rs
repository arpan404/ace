// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::unwrap_used)]
#![cfg(windows)]

//! Windows-only watching: the kernel buffer overflows a burst and the watch recovers.
//!
//! This is the behaviour `notify` cannot give the crate: it discards the status that says the
//! kernel lost events. The `ReadDirectoryChangesW` backend turns that status into a rescan and
//! arms the watch again.

use std::time::Duration;

use files_watch::{Batch, ChangeKind};

mod support;

use support::{Session, options};

#[test]
fn a_flood_of_fifty_thousand_files_is_one_rescan_and_watching_continues() {
    // ReadDirectoryChangesW's 64 KiB buffer cannot hold this burst, so the kernel either
    // overflows (the status this backend turns into a rescan) or the coalescer sees more than
    // max_batch changes (also a rescan). Either way the tree hears one rescan, never a wall of
    // changes, and the watch must still report what happens next.
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
    std::fs::write(session.path("after.txt"), b"after").unwrap();
    session.wait_for("after.txt", ChangeKind::Created);
    session.settle();
    let batches = session.seen();
    let rescans: Vec<&Batch> = batches
        .iter()
        .filter(|batch| matches!(batch, Batch::Rescan { .. }))
        .collect();
    assert_eq!(rescans.len(), 1, "one rescan per flood, saw {rescans:?}");
}
