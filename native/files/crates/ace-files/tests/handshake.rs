// SPDX-License-Identifier: Apache-2.0

//! The handshake, the two ways the process ends, and what a frame the binary cannot read becomes.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use common::Client;
use files_wire::Op;

#[test]
fn answers_hello_with_the_protocol_and_the_build_version() {
    let mut client = Client::start();
    // `hello` asserts the answer's protocol and version.
    client.hello();
}

#[test]
fn refuses_a_request_that_arrives_before_hello() {
    let mut client = Client::start();
    let refused = client.request(Op::Stat {
        root: 1,
        path: "any.txt".to_owned(),
    });
    assert_eq!(client.error(refused).code, "UNSUPPORTED");

    // After the handshake the same request is answered on its merits, so the refusal was the
    // handshake gate and not the root number.
    client.hello();
    let answered = client.request(Op::Stat {
        root: 1,
        path: "any.txt".to_owned(),
    });
    assert_eq!(client.error(answered).code, "INVALID_ARGUMENT");
}

#[test]
fn answers_an_unknown_op_with_the_same_id() {
    let mut client = Client::greeted();
    client.send_text(r#"{"type":"request","id":42,"op":{"op":"launch","root":1}}"#);
    let error = client.error(42);
    assert_eq!(error.code, "UNSUPPORTED");
    assert_eq!(error.id, 42);
}

#[test]
fn exits_zero_when_stdin_closes() {
    let mut client = Client::greeted();
    client.close_stdin();
    let status = client.wait();
    assert_eq!(status.code(), Some(0));
}

#[test]
fn exits_two_on_an_oversize_frame() {
    let mut client = Client::greeted();
    client.send_header(files_wire::MAX_FRAME_LEN + 1);
    let status = client.wait();
    assert_eq!(status.code(), Some(2));
}
