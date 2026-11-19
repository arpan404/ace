// SPDX-License-Identifier: Apache-2.0

//! stderr: machine failures earn a line, routine answers do not.
#![allow(clippy::unwrap_used, clippy::expect_used)]
// The machine failure it needs is a panicking build, which only the `test-hooks` feature provides.
#![cfg(feature = "test-hooks")]

mod common;

use std::time::{Duration, Instant};

use common::{Client, checkout};
use files_wire::{Op, Reply};

/// A window long enough for a log line the binary writes before answering to reach the test.
const SETTLE: Duration = Duration::from_millis(300);

#[test]
fn routine_failures_stay_off_the_log_and_machine_failures_earn_a_line() {
    let checkout = checkout(&[("a.txt", "one\n")]);
    // A build that panics makes indexQuery answer IO_ERROR, which is the machine-failure case.
    let mut client = Client::launch(&[("ACE_FILES_PANIC_INDEX", "1")], true);
    client.hello();
    let root = client.open_root(checkout.path());

    let missing = client.request(Op::Stat {
        root,
        path: "missing.txt".to_owned(),
    });
    assert_eq!(client.error(missing).code, "NOT_FOUND");

    let write = client.request(Op::Write {
        root,
        path: "a.txt".to_owned(),
        expected: Some("0:0:0:0:0".to_owned()),
    });
    client.send_body(write, b"two\n");
    assert_eq!(client.error(write).code, "CONFLICT");

    let lines = client.stderr_within(SETTLE);
    assert!(
        lines
            .iter()
            .all(|line| !line.contains(&format!("request {missing} failed"))),
        "a missing path is routine and stays off the log: {lines:?}"
    );
    assert!(
        lines
            .iter()
            .all(|line| !line.contains(&format!("request {write} failed"))),
        "a guarded write that lost its race is routine: {lines:?}"
    );

    // The failed build is a machine failure: it is on stderr and on the wire.
    let deadline = Instant::now() + Duration::from_secs(10);
    let failed = loop {
        assert!(
            Instant::now() < deadline,
            "indexQuery never reported the failure"
        );
        let id = client.request(Op::IndexQuery {
            root,
            query: "a".to_owned(),
            limit: 10,
        });
        match client.answer(id) {
            Ok(Reply::Index(_)) => std::thread::sleep(Duration::from_millis(20)),
            Ok(other) => panic!("indexQuery answered {other:?}"),
            Err(error) => break (id, error),
        }
    };
    assert_eq!(failed.1.code, "IO_ERROR");
    let lines = client.await_stderr(&format!("request {} failed", failed.0));
    assert!(
        lines
            .iter()
            .any(|line| line.contains("IO_ERROR") && line.contains("index")),
        "the machine failure names its code: {lines:?}"
    );
}
