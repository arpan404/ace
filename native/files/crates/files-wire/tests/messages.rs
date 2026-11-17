// SPDX-License-Identifier: Apache-2.0

// Test-only code: panicking on a broken fixture or frame is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Message parsing: what a lenient reader accepts and what it must refuse.

use files_wire::{Decoder, Error, Frame, Message, Op, PROTOCOL};

/// Decode a single JSON message the way the binary would, wrapped in a kind-1 frame.
fn decode(json: &str) -> Result<Message, Error> {
    let mut frame = (json.len() as u32 + 1).to_le_bytes().to_vec();
    frame.push(1);
    frame.extend_from_slice(json.as_bytes());
    let mut decoder = Decoder::new();
    decoder.push(&frame);
    match decoder.poll()? {
        Some(Frame::Message(message)) => Ok(message),
        other => panic!("expected one message, got {other:?}"),
    }
}

#[test]
fn unknown_fields_are_ignored() {
    let hello = decode(r#"{"type":"hello","protocol":1,"version":"9.9","pid":12}"#)
        .expect("extra fields are ignored");
    assert_eq!(
        hello,
        Message::Hello {
            protocol: PROTOCOL,
            version: Some("9.9".to_owned()),
        }
    );

    let request = decode(
        r#"{"type":"request","id":3,"op":{"op":"stat","root":1,"path":"a.txt","future":true},"trace":"abc"}"#,
    )
    .expect("extra fields are ignored inside the op too");
    match request {
        Message::Request {
            id,
            op: Op::Stat { root, path },
        } => {
            assert_eq!(id, 3);
            assert_eq!(root, 1);
            assert_eq!(path, "a.txt");
        }
        other => panic!("expected a stat request, got {other:?}"),
    }
}

#[test]
fn unknown_op_is_an_error_value() {
    let error = decode(r#"{"type":"request","id":1,"op":{"op":"frobnicate"}}"#)
        .expect_err("an unknown op is refused");
    assert!(matches!(error, Error::Json(_)));
    assert_eq!(error.code(), "INVALID_ARGUMENT");
}

#[test]
fn unknown_message_type_is_an_error_value() {
    let error = decode(r#"{"type":"telepathy","id":1}"#).expect_err("an unknown type is refused");
    assert_eq!(error.code(), "INVALID_ARGUMENT");
}

#[test]
fn ace_files_hello_carries_its_version() {
    let hello = decode(r#"{"type":"hello","protocol":1,"version":"0.1.0"}"#).expect("a hello");
    assert_eq!(
        hello,
        Message::Hello {
            protocol: PROTOCOL,
            version: Some("0.1.0".to_owned()),
        }
    );
}
