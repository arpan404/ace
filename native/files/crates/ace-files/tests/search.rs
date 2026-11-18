// SPDX-License-Identifier: Apache-2.0

//! Content search: the stream of matches, and giving up on one.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

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

#[test]
fn streams_matches_then_search_done() {
    let checkout = checkout(&[
        ("a.txt", "one cache\ntwo\n"),
        ("b.txt", "nothing here\n"),
        ("deep/c.txt", "three\ncache again\n"),
    ]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Search {
        root,
        query: query("cache"),
    });
    let subscription = match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("search answered {other:?}"),
    };

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
fn cancel_of_a_long_search_answers_aborted() {
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
    match client.reply(id) {
        Reply::Subscription { .. } => {}
        other => panic!("search answered {other:?}"),
    }
    client.send(&Message::Cancel { id });
    let error = client.error(id);
    assert_eq!(error.code, "ABORTED");
}

#[test]
fn unwatch_stops_a_search_without_a_result() {
    let checkout = checkout(&[("a.txt", "cache\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Search {
        root,
        query: query("cache"),
    });
    let subscription = match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("search answered {other:?}"),
    };
    let unwatched = client.request(Op::Unwatch { subscription });
    assert_eq!(client.reply(unwatched), Reply::Done);
}
