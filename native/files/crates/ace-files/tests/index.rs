// SPDX-License-Identifier: Apache-2.0

//! Quick open: the answer before the walk lands, and the answer after.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::{Duration, Instant};

use common::{Client, checkout, write_file};
use files_wire::{Op, Reply};

/// How long the build may take before the test calls it hung.
const DEADLINE: Duration = Duration::from_secs(10);

/// Enough files that the walk outlasts the round trip of the first query.
const FILES: usize = 3_000;

#[test]
fn answers_an_index_query_before_and_after_the_build() {
    let checkout = checkout(&[("src/server_main.rs", "")]);
    for index in 0..FILES {
        write_file(checkout.path(), &format!("bulk/file{index:04}.txt"), "");
    }

    let mut client = Client::greeted();
    let root = client.open_root(checkout.path());
    let deadline = Instant::now() + DEADLINE;

    // The first query races the walk by design: it must say it is not ready rather than block.
    let first = client.request(Op::IndexQuery {
        root,
        query: "srvmain".to_owned(),
        limit: 10,
    });
    let index = match client.reply(first) {
        Reply::Index(index) => index,
        other => panic!("indexQuery answered {other:?}"),
    };
    assert!(
        !index.ready,
        "a freshly opened root reports its index as still building"
    );
    assert!(index.hits.is_empty(), "nothing to answer before the walk");
    assert_eq!(index.total, 0);

    let mut ready = false;
    while Instant::now() < deadline {
        let id = client.request(Op::IndexQuery {
            root,
            query: "srvmain".to_owned(),
            limit: 10,
        });
        let index = match client.reply(id) {
            Reply::Index(index) => index,
            other => panic!("indexQuery answered {other:?}"),
        };
        if index.ready {
            assert!(
                index
                    .hits
                    .iter()
                    .any(|hit| hit.path == "src/server_main.rs"),
                "the built index finds the file: {:?}",
                index.hits
            );
            assert!(index.total >= FILES as u64);
            assert!(!index.truncated);
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(ready, "the index finished within {DEADLINE:?}");
}
