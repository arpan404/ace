// SPDX-License-Identifier: Apache-2.0

//! Watching: one watcher per root, shared by every subscription on it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::fs;
use std::time::{Duration, Instant};

use files_wire::{EventPayload, Op, Reply};

use common::{Client, await_reported, checkout, watch, write_file};

/// Files one burst creates: more than the watcher's 5,000-change window, so it turns into a
/// rescan instead of a batch.
const BURST: usize = 20_000;

/// Files per folder in the burst.
const SET: usize = 1_000;

/// How long the burst's rescan and its walk may take before the test calls it hung.
const BURST_DEADLINE: Duration = Duration::from_secs(60);

/// One quick-open query.
fn index(client: &mut Client, root: u64, query: &str) -> files_wire::IndexResult {
    let id = client.request(Op::IndexQuery {
        root,
        query: query.to_owned(),
        limit: 10,
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

#[test]
fn a_burst_of_twenty_thousand_files_ends_up_in_quick_open() {
    let checkout = checkout(&[]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let subscription = watch(&mut client, root);

    // The burst is a change on top of a finished walk, not part of the first one.
    let deadline = Instant::now() + BURST_DEADLINE;
    while !index(&mut client, root, "a").ready {
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
    for file in 0..BURST - 1 {
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

    // The watcher cannot describe the burst change by change: it reports a rescan of the folder.
    let deadline = Instant::now() + BURST_DEADLINE;
    loop {
        match client.try_event(subscription, Duration::from_millis(500)) {
            Some(EventPayload::Rescan { .. }) => break,
            Some(_) => {}
            None => assert!(
                Instant::now() < deadline,
                "the watcher never reported the burst within {BURST_DEADLINE:?}"
            ),
        }
    }

    // The rescan's walk runs after the burst goes quiet, so quick open ends up with every file,
    // not the prefix a walk started mid-burst would have seen.
    let deadline = Instant::now() + BURST_DEADLINE;
    loop {
        let burst = index(&mut client, root, "final_burst_marker");
        if burst.ready
            && burst
                .hits
                .iter()
                .any(|hit| hit.path.ends_with("final_burst_marker.txt"))
        {
            assert_eq!(
                burst.total,
                (BURST + 1 + BURST.div_ceil(SET)) as u64,
                "every burst file is in the index exactly once, beside the burst's own folders"
            );
            return;
        }
        assert!(
            Instant::now() < deadline,
            "quick open never found the burst within {BURST_DEADLINE:?}; {} paths indexed, hits {:?}",
            burst.total,
            burst.hits
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
