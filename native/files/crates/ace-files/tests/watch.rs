// SPDX-License-Identifier: Apache-2.0

//! Watching: a batch reaches the subscription after the tree changes.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::{Duration, Instant};

use common::{Client, checkout, write_file};
use files_wire::{ChangeKind, EventPayload, Op, Reply};

/// How long a watcher may take to report one small change.
const DEADLINE: Duration = Duration::from_secs(10);

#[test]
fn reports_a_created_file_to_the_watch() {
    let checkout = checkout(&[("existing.txt", "before\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Watch { root });
    let subscription = match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("watch answered {other:?}"),
    };

    write_file(checkout.path(), "created.txt", "hello\n");

    let deadline = Instant::now() + DEADLINE;
    loop {
        assert!(
            Instant::now() < deadline,
            "no change batch named created.txt within {DEADLINE:?}"
        );
        match client.event(subscription) {
            EventPayload::Changes { changes } => {
                if changes.iter().any(|change| {
                    change.path == "created.txt" && change.kind == ChangeKind::Created
                }) {
                    return;
                }
            }
            // A degraded watcher (the polling fallback) still reports batches; keep waiting.
            EventPayload::Warning { .. } | EventPayload::Rescan { .. } => {}
            other => panic!("unexpected watch event {other:?}"),
        }
    }
}

#[test]
fn unwatch_closes_the_subscription() {
    let checkout = checkout(&[("a.txt", "")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    let id = client.request(Op::Watch { root });
    let subscription = match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("watch answered {other:?}"),
    };
    let unwatched = client.request(Op::Unwatch { subscription });
    assert_eq!(client.reply(unwatched), Reply::Done);
}
