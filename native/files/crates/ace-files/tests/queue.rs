// SPDX-License-Identifier: Apache-2.0

//! The stdout queue: a daemon that stops reading slows the binary instead of growing its memory.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::Duration;

use common::{Client, checkout};
use files_wire::{Op, Reply};

#[test]
fn a_daemon_that_stops_reading_loses_no_reply() {
    let checkout = checkout(&[("a.txt", "")]);
    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());

    // Enough answers that the pipe and the binary's queue fill while nobody reads them.
    client.pause();
    let mut requests = Vec::new();
    for _ in 0..600 {
        requests.push(client.request(Op::Stat {
            root,
            path: "a.txt".to_owned(),
        }));
    }
    std::thread::sleep(Duration::from_millis(300));
    client.resume();

    // Waiting for a reader never drops an answer: every request still gets its entry, in order.
    for id in requests {
        assert!(
            matches!(client.reply(id), Reply::Entry(_)),
            "request {id} answered after the reader resumed"
        );
    }
}
