// SPDX-License-Identifier: Apache-2.0

//! Watching: one watcher per root, shared by every subscription on it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::{Duration, Instant};

use common::{Client, checkout, write_file};
use files_wire::{ChangeKind, EventPayload, Op, Reply};

/// How long a watcher may take to report one small change.
const DEADLINE: Duration = Duration::from_secs(10);

/// Subscribe to the root and hand back the subscription.
fn watch(client: &mut Client, root: u64) -> u64 {
    let id = client.request(Op::Watch { root });
    match client.reply(id) {
        Reply::Subscription { subscription } => subscription,
        other => panic!("watch answered {other:?}"),
    }
}

/// Wait until the subscription reports `path` as created.
fn await_created(client: &mut Client, subscription: u64, path: &str) {
    let deadline = Instant::now() + DEADLINE;
    loop {
        assert!(
            Instant::now() < deadline,
            "no change batch named {path} within {DEADLINE:?}"
        );
        match client.event(subscription) {
            EventPayload::Changes { changes } => {
                if changes
                    .iter()
                    .any(|change| change.path == path && change.kind == ChangeKind::Created)
                {
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
fn reports_a_created_file_to_the_watch() {
    let checkout = checkout(&[("existing.txt", "before\n")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let subscription = watch(&mut client, root);

    write_file(checkout.path(), "created.txt", "hello\n");
    await_created(&mut client, subscription, "created.txt");
}

#[test]
fn every_watch_on_a_root_reports_the_same_batch() {
    let checkout = checkout(&[("existing.txt", "")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let first = watch(&mut client, root);
    let second = watch(&mut client, root);

    write_file(checkout.path(), "created.txt", "hello\n");
    await_created(&mut client, first, "created.txt");
    await_created(&mut client, second, "created.txt");
}
