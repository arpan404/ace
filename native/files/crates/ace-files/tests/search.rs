// SPDX-License-Identifier: Apache-2.0

//! Content search: the stream of matches, and giving up on one.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::Duration;

use common::{Client, checkout};
use files_wire::{Case, EventPayload, Message, Op, Reply, SearchQuery};

fn query(pattern: &str) -> SearchQuery {
    SearchQuery {
        pattern: pattern.to_owned(),
        regex: false,
        case: Case::Smart,
        whole_word: false,
        include: Vec::new(),
        exclude: Vec::new(),
        include_ignored: false,
        max_matches: 100,
        max_file_bytes: 1 << 20,
    }
}

fn regex(pattern: &str) -> SearchQuery {
    SearchQuery {
        regex: true,
        ..query(pattern)
    }
}

/// Start a search and hand back its subscription.
fn subscribe(client: &mut Client, root: u64, query: SearchQuery) -> u64 {
    let id = client.request(Op::Search { root, query });
    match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("search answered {other:?}"),
    }
}

/// Wait for the search to fail and hand back its code.
fn await_failure(client: &mut Client, subscription: u64) -> String {
    match client.event(subscription) {
        EventPayload::SearchFailed { code, .. } => code,
        other => panic!("expected a searchFailed event, got {other:?}"),
    }
}

#[test]
fn streams_matches_then_search_done() {
    let checkout = checkout(&[
        ("a.txt", "one cache\ntwo\n"),
        ("b.txt", "nothing here\n"),
        ("deep/c.txt", "three\ncache again\n"),
    ]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let subscription = subscribe(&mut client, root, query("cache"));

    let mut files = Vec::new();
    let summary = loop {
        match client.event(subscription) {
            EventPayload::Matches { file } => files.push(file),
            EventPayload::SearchDone { summary } => break summary,
            other => panic!("unexpected search event {other:?}"),
        }
    };

    files.sort_by(|left, right| left.path.cmp(&right.path));
    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["a.txt", "deep/c.txt"],
        "only files with a match are reported"
    );
    assert_eq!(files[0].lines.len(), 1);
    assert_eq!(files[0].lines[0].line, 1);
    assert!(files[0].lines[0].preview.contains("cache"));
    assert_eq!(files[0].lines[0].ranges, [(4, 9)]);
    assert_eq!(summary.files, 2);
    assert_eq!(summary.matches, 2);
    assert!(!summary.limit_hit);
}

#[test]
fn cancel_of_a_long_search_fails_the_subscription() {
    // A file large enough that scanning it outlasts the round trip of the cancel that follows the
    // subscription, so the search is still walking when it is told to stop.
    let line = "the quick brown fox jumps over the lazy dog\n";
    let checkout = checkout(&[("big.txt", &line.repeat(600_000))]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Search {
        root,
        query: query("wombat"),
    });
    let subscription = match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("search answered {other:?}"),
    };
    client.send(&Message::Cancel { id });
    assert_eq!(await_failure(&mut client, subscription), "ABORTED");
    // The request id was answered once, by the subscription: no second reply follows it.
    client.expect_no_reply(id, Duration::from_millis(300));
}

#[test]
fn unwatch_stops_a_long_search() {
    // The same large file as the cancel test: the search cannot finish before the unsubscribe
    // reaches it, so the request must stop. The subscription is already gone, so the stop is not
    // reported anywhere, and the request it belonged to is not answered twice.
    let line = "the quick brown fox jumps over the lazy dog\n";
    let checkout = checkout(&[("big.txt", &line.repeat(600_000))]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Search {
        root,
        query: query("wombat"),
    });
    let subscription = match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("search answered {other:?}"),
    };
    let unwatched = client.request(Op::Unwatch { subscription });
    assert_eq!(client.reply(unwatched), Reply::Done);
    client.expect_no_reply(id, Duration::from_millis(500));
}

#[test]
fn a_panicking_search_worker_fails_the_subscription() {
    let checkout = checkout(&[("a.txt", "cache\n")]);
    let mut client = Client::launch(&[("ACE_FILES_PANIC_SEARCH", "boom")], false);
    client.hello();
    let root = client.open_root(checkout.path());

    let subscription = subscribe(&mut client, root, query("boom"));
    // A worker that panicked never walks, so the search can only end as a failure. It must end.
    assert_eq!(await_failure(&mut client, subscription), "IO_ERROR");
}

#[test]
fn an_invalid_regex_answers_one_error_reply() {
    let checkout = checkout(&[("a.txt", "cache\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Search {
        root,
        query: regex("cache("),
    });
    let error = client.error(id);
    assert_eq!(error.code, "INVALID_ARGUMENT");
    assert!(
        error.message.contains("regex") || error.message.contains("group"),
        "the message says what is wrong with the pattern: {}",
        error.message
    );
    // No subscription was ever handed out, so nothing may follow: the request got its one answer.
    client.expect_silence(Duration::from_millis(300));
}
