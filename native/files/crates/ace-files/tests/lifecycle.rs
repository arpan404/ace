// SPDX-License-Identifier: Apache-2.0

//! Closing a root: its watcher, its subscriptions and the memory behind them go with it.
#![allow(clippy::unwrap_used, clippy::expect_used)]
// The live-root count it waits on is only reported with the `test-hooks` feature.
#![cfg(feature = "test-hooks")]

mod common;

use std::time::Duration;

use common::{Client, await_reported, checkout, watch, write_file};
use files_wire::{Op, Reply};

#[test]
fn closing_a_root_stops_its_watcher_and_releases_the_root() {
    let checkout = checkout(&[("existing.txt", "before\n")]);
    let mut client = Client::with_live_roots();
    client.hello();
    let root = client.open_root(checkout.path());
    let subscription = watch(&mut client, root);

    // The watcher is running and reports this checkout before the close.
    write_file(checkout.path(), "before.txt", "hello\n");
    await_reported(&mut client, checkout.path(), subscription, "before.txt");

    let closed = client.request(Op::CloseRoot { root });
    assert_eq!(client.reply(closed), Reply::Done);

    write_file(checkout.path(), "after.txt", "hello\n");
    client.expect_no_event(subscription, Duration::from_millis(600));

    // A leaked watcher keeps the entry, its lister and its index alive, so a live-root count that
    // never reaches zero is exactly what a closeRoot that only drops its own handle leaves behind.
    client.await_live_roots(0);
}
