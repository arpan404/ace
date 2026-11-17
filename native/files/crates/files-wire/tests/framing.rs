// SPDX-License-Identifier: Apache-2.0

// Test-only code: panicking on a broken fixture or frame is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Framing behaviour: what goes in comes out, however the bytes are chopped up.

use files_wire::{
    Decoder, Error, EventPayload, Frame, MAX_FRAME_LEN, Message, Op, Reply, encode, encode_body,
};

fn request() -> Message {
    Message::Request {
        id: 1,
        op: Op::Stat {
            root: 1,
            path: "src/lib.rs".to_owned(),
        },
    }
}

fn response() -> Message {
    Message::Response {
        id: 2,
        result: Reply::Version {
            version: "1:2:3:4.5:6".to_owned(),
        },
    }
}

fn event() -> Message {
    Message::Event {
        subscription: 7,
        payload: EventPayload::Warning {
            message: "native watching is unavailable".to_owned(),
        },
    }
}

fn encode_all(messages: &[Message]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for message in messages {
        bytes.extend(encode(message).expect("test messages fit a frame"));
    }
    bytes
}

fn frames(messages: &[Message]) -> Vec<Frame> {
    messages.iter().cloned().map(Frame::Message).collect()
}

/// Drain the decoder until it stops producing frames.
fn drain(decoder: &mut Decoder) -> Vec<Frame> {
    let mut out = Vec::new();
    while let Some(frame) = decoder.poll().expect("frames parse") {
        out.push(frame);
    }
    out
}

#[test]
fn decoder_handles_split_and_joined_frames() {
    let messages = vec![request(), response(), event()];
    let expected = frames(&messages);
    let joined = encode_all(&messages);

    let mut whole = Decoder::new();
    whole.push(&joined);
    assert_eq!(drain(&mut whole), expected);

    let mut byte_by_byte = Decoder::new();
    let mut seen = Vec::new();
    for byte in &joined {
        byte_by_byte.push(std::slice::from_ref(byte));
        seen.extend(drain(&mut byte_by_byte));
    }
    assert_eq!(seen, expected);

    let mut uneven = Decoder::new();
    let mut seen = Vec::new();
    for chunk in joined.chunks(5) {
        uneven.push(chunk);
        seen.extend(drain(&mut uneven));
    }
    assert_eq!(seen, expected);
}

#[test]
fn decoder_rejects_oversize_frame() {
    let mut decoder = Decoder::new();
    decoder.push(&(MAX_FRAME_LEN + 1).to_le_bytes());

    let error = decoder.poll().expect_err("an oversize frame is refused");
    assert!(matches!(error, Error::FrameTooLarge { .. }));
    assert_eq!(error.code(), "TOO_LARGE");

    decoder.push(&encode(&request()).expect("fits"));
    assert_eq!(decoder.poll().expect("no frame error"), None);
}

#[test]
fn decoder_reports_a_zero_length_frame() {
    let mut decoder = Decoder::new();
    decoder.push(&0u32.to_le_bytes());
    assert!(matches!(decoder.poll(), Err(Error::EmptyFrame)));
}

#[test]
fn decoder_reports_an_unknown_kind_and_reads_on() {
    let mut frame = vec![9u8];
    frame.extend_from_slice(b"{}");
    let mut bytes = (frame.len() as u32).to_le_bytes().to_vec();
    bytes.extend(frame);
    bytes.extend(encode(&request()).expect("fits"));

    let mut decoder = Decoder::new();
    decoder.push(&bytes);
    assert!(matches!(decoder.poll(), Err(Error::UnknownKind(9))));
    assert_eq!(
        decoder.poll().expect("no frame error"),
        Some(Frame::Message(request()))
    );
}

#[test]
fn decoder_reports_a_truncated_body() {
    let mut bytes = 5u32.to_le_bytes().to_vec();
    bytes.push(2);
    bytes.extend_from_slice(&[1, 2, 3, 4]);

    let mut decoder = Decoder::new();
    decoder.push(&bytes);
    assert!(matches!(
        decoder.poll(),
        Err(Error::TruncatedBody { length: 4 })
    ));
}

#[test]
fn body_frame_carries_request_id_and_bytes() {
    let payload = b"fn main() {}\n";
    let bytes = encode_body(42, payload).expect("fits");

    let mut decoder = Decoder::new();
    decoder.push(&bytes);
    assert_eq!(
        decoder.poll().expect("no frame error"),
        Some(Frame::Body {
            id: 42,
            bytes: payload.to_vec(),
        })
    );
    assert_eq!(decoder.poll().expect("no frame error"), None);
}

#[test]
fn encoder_refuses_a_body_over_the_frame_limit() {
    let bytes = vec![0u8; MAX_FRAME_LEN as usize];
    let error = encode_body(1, &bytes).expect_err("a body that big is refused");
    assert!(matches!(error, Error::FrameTooLarge { .. }));
}

#[test]
fn a_malformed_message_does_not_lose_the_next_frame() {
    let garbage = b"not json";
    let mut bytes = (garbage.len() as u32 + 1).to_le_bytes().to_vec();
    bytes.push(1);
    bytes.extend_from_slice(garbage);
    bytes.extend(encode(&event()).expect("fits"));

    let mut decoder = Decoder::new();
    decoder.push(&bytes);
    assert!(matches!(decoder.poll(), Err(Error::Json(_))));
    assert_eq!(
        decoder.poll().expect("no frame error"),
        Some(Frame::Message(event()))
    );
}
