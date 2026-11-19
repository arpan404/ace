// SPDX-License-Identifier: Apache-2.0

//! Watching: one watcher per root, shared by every subscription on it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::fs;
use std::time::{Duration, Instant};

use files_wire::{Op, Reply};

use common::{Client, await_reported, checkout, watch, write_file};

/// Files one burst creates: more than the watcher's 5,000-change window, so it turns into a
/// rescan instead of a batch.
const BURST: usize = 20_000;

/// Files per folder in the burst.
const SET: usize = 1_000;

/// How long the burst's rescan and its walk may take before the test calls it hung.
const BURST_DEADLINE: Duration = Duration::from_secs(60);

/// One quick-open query, at most `limit` hits.
fn index(client: &mut Client, root: u64, query: &str, limit: u64) -> files_wire::IndexResult {
    let id = client.request(Op::IndexQuery {
        root,
        query: query.to_owned(),
        limit,
    });
    match client.reply(id) {
        Reply::Index(index) => index,
        other => panic!("indexQuery answered {other:?}"),
    }
}

#[test]
fn reports_a_created_file_to_the_watch() {
    let checkout = checkout(&[("existing.txt", "before\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let subscription = watch(&mut client, root);

    write_file(checkout.path(), "created.txt", "hello\n");
    await_reported(&mut client, checkout.path(), subscription, "created.txt");
}

#[test]
fn a_change_in_a_focused_folder_is_reported_while_the_os_watch_is_busy() {
    // A burst anywhere on the volume queues behind fseventsd for every client, and on a loaded
    // Mac a single write after it waited minutes. The folders the daemon names as open must not
    // wait: the watcher checks them itself.
    let checkout = checkout(&[("src/existing.txt", "")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let subscription = watch(&mut client, root);
    let id = client.request(Op::Focus {
        root,
        folders: vec!["src".to_owned()],
    });
    assert!(matches!(client.reply(id), Reply::Done { .. }));

    let elsewhere = tempfile::tempdir().unwrap();
    for index in 0..1_000 {
        fs::write(elsewhere.path().join(format!("f{index}")), b"x").unwrap();
    }
    let started = Instant::now();
    write_file(checkout.path(), "src/after.txt", "after\n");
    let deadline = started + Duration::from_secs(3);
    loop {
        if let Some(files_wire::EventPayload::Changes { changes }) =
            client.try_event(subscription, Duration::from_millis(50))
            && changes.iter().any(|change| change.path == "src/after.txt")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "a focused folder's change was not reported within 3 s of being made"
        );
    }
}

#[test]
fn every_watch_on_a_root_reports_the_same_batch() {
    let checkout = checkout(&[("existing.txt", "")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let first = watch(&mut client, root);
    let second = watch(&mut client, root);

    write_file(checkout.path(), "created.txt", "hello\n");
    await_reported(&mut client, checkout.path(), first, "created.txt");
    await_reported(&mut client, checkout.path(), second, "created.txt");
}

/// Waits until the OS watch reports a write made now, so a burst test does not start behind a
/// backlog: fseventsd serves every client on a Mac, and the last run's burst can keep it busy for
/// a minute and more. The write lands in a subfolder no one has open, which only the OS watch
/// reports.
fn os_watch_caught_up(client: &mut Client) {
    let probe = checkout(&[("sub/keep.txt", "")]);
    let root = client.open_root(probe.path());
    let subscription = watch(client, root);
    write_file(probe.path(), "sub/sentinel.txt", "now\n");
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        if let Some(files_wire::EventPayload::Changes { changes }) =
            client.try_event(subscription, Duration::from_millis(100))
            && changes
                .iter()
                .any(|change| change.path == "sub/sentinel.txt")
        {
            return;
        }
    }
}

#[test]
fn a_burst_of_twenty_thousand_files_ends_up_in_quick_open() {
    let checkout = checkout(&[]);
    let mut client = Client::greeted();
    os_watch_caught_up(&mut client);
    let root = client.open_root(checkout.path());
    let subscription = watch(&mut client, root);

    // The burst is a change on top of a finished walk, not part of the first one.
    let deadline = Instant::now() + BURST_DEADLINE;
    while !index(&mut client, root, "a", 10).ready {
        assert!(
            Instant::now() < deadline,
            "the first index was not ready within {BURST_DEADLINE:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    for set in 0..BURST.div_ceil(SET) {
        fs::create_dir_all(checkout.path().join("burst").join(format!("set_{set:02}")))
            .expect("the burst folder");
    }
    for file in 0..BURST {
        let path = checkout
            .path()
            .join("burst")
            .join(format!("set_{:02}/burst_{file:05}.txt", file / SET));
        fs::write(path, "burst\n").expect("the burst file");
    }
    // One unique name, so the check that quick open can find a burst file is about the index
    // and not about how a fuzzy matcher ranks twenty thousand near-identical names.
    fs::write(
        checkout.path().join("burst/final_burst_marker.txt"),
        "burst\n",
    )
    .expect("the marker file");

    // The watcher may describe the burst as change batches or as one rescan of the folder it
    // happened in; both are correct, and which one it picks depends on how fast the writes land.
    // What matters is that quick open ends up holding every file: the files a batch names, and
    // the ones only a walk would find. The subscription is read throughout, so a watcher with
    // more news than the pipe holds is never stuck behind it.
    let sets = BURST.div_ceil(SET);
    let complete = (BURST + 1 + sets) as u64;
    let deadline = Instant::now() + BURST_DEADLINE;
    let mut missing = Vec::new();
    loop {
        while client
            .try_event(subscription, Duration::from_millis(2))
            .is_some()
        {}
        let burst = index(&mut client, root, "final_burst_marker", 10);
        let marker = burst.ready
            && burst
                .hits
                .iter()
                .any(|hit| hit.path.ends_with("final_burst_marker.txt"));
        // The count is a cheap gate; only when it looks complete is every file asked for by name,
        // because a scoped walk that raced the writes can leave a hole the count cannot show.
        if marker && burst.total >= complete {
            missing = missing_burst_files(&mut client, root, sets);
            if missing.is_empty() {
                // The burst's own folder is part of the index only when a batch named its
                // creation before a rescan of the folder replaced everything below it.
                assert!(
                    burst.total == complete || burst.total == complete + 1,
                    "every burst file is in the index exactly once, beside the burst's own \
                     folders, not {} paths",
                    burst.total
                );
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "quick open never caught up with the burst within {BURST_DEADLINE:?}: {} paths \
             indexed, {} files missing, first {:?}",
            burst.total,
            missing.len(),
            missing.first()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Every burst file quick open does not return, one query per set of `SET` files.
fn missing_burst_files(client: &mut Client, root: u64, sets: usize) -> Vec<String> {
    let mut missing = Vec::new();
    for set in 0..sets {
        let found = index(client, root, &format!("set_{set:02}/burst_"), SET as u64);
        let returned: std::collections::HashSet<&str> =
            found.hits.iter().map(|hit| hit.path.as_str()).collect();
        for file in 0..SET {
            let path = format!("burst/set_{set:02}/burst_{:05}.txt", set * SET + file);
            if !returned.contains(path.as_str()) {
                missing.push(path);
            }
        }
    }
    missing
}
