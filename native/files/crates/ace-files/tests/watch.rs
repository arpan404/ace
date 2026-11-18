// SPDX-License-Identifier: Apache-2.0

//! Watching: one watcher per root, shared by every subscription on it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use common::{Client, await_created, checkout, watch, write_file};

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
