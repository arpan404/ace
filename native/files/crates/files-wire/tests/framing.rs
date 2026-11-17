// SPDX-License-Identifier: Apache-2.0

// Test-only code: panicking on a broken fixture or frame is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Framing behaviour: what goes in comes out, however the bytes are chopped up.

use files_wire::{
    Decoder, Error, EventPayload, Frame, MAX_BODY_LEN, MAX_FRAME_LEN, Message, Op, Reply, encode,
    encode_body,
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

/// The length a frame declares, which is everything after the four length bytes.
fn declared_length(frame: &[u8]) -> u32 {
    let mut header = [0u8; 4];
    header.copy_from_slice(&frame[..4]);
    u32::from_le_bytes(header)
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
fn decoder_rejects_oversize_frame_and_stays_dead() {
    let mut decoder = Decoder::new();
    decoder.push(&(MAX_FRAME_LEN + 1).to_le_bytes());

    let error = decoder.poll().expect_err("an oversize frame is refused");
    assert!(matches!(error, Error::FrameTooLarge { .. }));
    assert_eq!(error.code(), "TOO_LARGE");

    decoder.push(&vec![0u8; 1024 * 1024]);
    assert_eq!(decoder.buffered_bytes(), 0, "a dead decoder holds nothing");
    let error = decoder.poll().expect_err("a dead decoder keeps failing");
    assert!(matches!(error, Error::FrameTooLarge { .. }));
    assert_eq!(error.code(), "TOO_LARGE");

    decoder.push(&encode(&request()).expect("fits"));
    assert!(decoder.poll().is_err(), "not even a valid frame revives it");
    assert_eq!(decoder.buffered_bytes(), 0);
}

#[test]
fn decoder_reads_on_after_a_zero_length_frame() {
    let mut decoder = Decoder::new();
    decoder.push(&0u32.to_le_bytes());
    assert!(matches!(decoder.poll(), Err(Error::EmptyFrame)));
    assert_eq!(decoder.poll().expect("no frame error"), None);

    decoder.push(&encode(&request()).expect("fits"));
    assert_eq!(
        decoder.poll().expect("no frame error"),
        Some(Frame::Message(request()))
    );
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
fn frames_of_exactly_the_limit_are_accepted() {
    let body = vec![7u8; MAX_BODY_LEN as usize];
    let bytes = encode_body(9, &body).expect("the limit is inclusive");
    assert_eq!(declared_length(&bytes), MAX_FRAME_LEN);

    let mut decoder = Decoder::new();
    decoder.push(&bytes);
    assert_eq!(
        decoder.poll().expect("no frame error"),
        Some(Frame::Body { id: 9, bytes: body })
    );
}

#[test]
fn one_byte_past_the_limit_is_refused() {
    let body = vec![7u8; MAX_BODY_LEN as usize + 1];
    let error = encode_body(9, &body).expect_err("one byte past the limit is refused");
    assert!(matches!(
        error,
        Error::FrameTooLarge { length } if length == u64::from(MAX_FRAME_LEN) + 1
    ));

    let mut decoder = Decoder::new();
    decoder.push(&(MAX_FRAME_LEN + 1).to_le_bytes());
    assert!(matches!(
        decoder.poll(),
        Err(Error::FrameTooLarge { length }) if length == u64::from(MAX_FRAME_LEN) + 1
    ));
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
    assert!(matches!(decoder.poll(), Err(Error::Message { .. })));
    assert_eq!(
        decoder.poll().expect("no frame error"),
        Some(Frame::Message(event()))
    );
}

#[test]
fn a_fixed_pseudo_random_stream_never_panics() {
    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    let mut decoder = Decoder::new();
    for _ in 0..64 {
        let mut chunk = Vec::with_capacity(64);
        for _ in 0..64 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            chunk.push((state >> 33) as u8);
        }
        decoder.push(&chunk);
        loop {
            match decoder.poll() {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(error) => {
                    assert!(!error.to_string().is_empty());
                    break;
                }
            }
        }
    }
    assert!(decoder.buffered_bytes() <= MAX_FRAME_LEN as usize);
}
