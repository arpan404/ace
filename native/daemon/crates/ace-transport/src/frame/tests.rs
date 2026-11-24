// SPDX-License-Identifier: Apache-2.0
//! The frame rules as input/output tables. Every case is bytes on a real duplex
//! and the frames (or the refusal) that come off them, so a rule is checked at
//! the same edge the socket uses.

use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::assemble::{Assembler, Message, MessageBody, Plain, conclude};
use super::header::{parse_first, payload_length};
use super::read::FrameReader;
use super::write::FrameWriter;
use super::{Frame, FrameError, MAX_MESSAGE_BYTES, Opcode, Outbound};

const MASK: [u8; 4] = [0x11, 0x22, 0x33, 0x44];

fn masked(fin: bool, opcode: Opcode, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![(if fin { 0x80 } else { 0 }) | opcode.code()];
    let length = payload.len();
    if length < 126 {
        bytes.push(0x80 | length as u8);
    } else if length <= u16::MAX as usize {
        bytes.push(0x80 | 126);
        bytes.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        bytes.push(0x80 | 127);
        bytes.extend_from_slice(&(length as u64).to_be_bytes());
    }
    bytes.extend_from_slice(&MASK);
    bytes.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ MASK[index & 3]),
    );
    bytes
}

/// A masked frame's header for a declared length, without its payload or mask.
fn declared(opcode: Opcode, short: u8, extended: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0x80 | opcode.code(), 0x80 | short];
    bytes.extend_from_slice(extended);
    bytes
}

async fn collect(bytes: &[u8]) -> Vec<Result<Frame, FrameError>> {
    let (mut client, server) = tokio::io::duplex(2 << 20);
    client
        .write_all(bytes)
        .await
        .expect("the test writes its frames");
    client.shutdown().await.expect("the test's write side ends");
    let mut reader = FrameReader::new(server);
    let mut out = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(2), reader.next()).await {
            Ok(Some(item)) => {
                let refused = item.is_err();
                out.push(item);
                if refused {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => panic!("the reader answered neither a frame nor the end"),
        }
    }
    out
}

async fn frames(bytes: &[u8]) -> Vec<Frame> {
    collect(bytes)
        .await
        .into_iter()
        .map(|item| item.expect("a valid frame"))
        .collect()
}

async fn refusal(bytes: &[u8]) -> FrameError {
    let mut items = collect(bytes).await;
    assert_eq!(items.len(), 1, "one refused frame, then nothing");
    items.remove(0).expect_err("the frame is refused")
}

fn text(fin: bool, payload: &[u8]) -> Frame {
    Frame {
        fin,
        rsv1: false,
        opcode: Opcode::Text,
        payload: payload.to_vec(),
    }
}

fn continuation(fin: bool, payload: &[u8]) -> Frame {
    Frame {
        fin,
        rsv1: false,
        opcode: Opcode::Continuation,
        payload: payload.to_vec(),
    }
}

fn ping(payload: &[u8]) -> Frame {
    Frame {
        fin: true,
        rsv1: false,
        opcode: Opcode::Ping,
        payload: payload.to_vec(),
    }
}

#[tokio::test]
async fn frames_come_off_the_wire_in_order_and_unmasked() {
    let mut bytes = Vec::new();
    bytes.extend(masked(true, Opcode::Text, b"hello"));
    bytes.extend(masked(true, Opcode::Binary, &[0, 1, 255]));
    bytes.extend(masked(true, Opcode::Ping, b"hb"));
    bytes.extend(masked(true, Opcode::Pong, b""));
    assert_eq!(
        frames(&bytes).await,
        vec![
            text(true, b"hello"),
            Frame {
                fin: true,
                rsv1: false,
                opcode: Opcode::Binary,
                payload: vec![0, 1, 255],
            },
            ping(b"hb"),
            Frame {
                fin: true,
                rsv1: false,
                opcode: Opcode::Pong,
                payload: Vec::new(),
            },
        ]
    );
}

#[tokio::test]
async fn fragments_and_interleaved_control_frames_keep_their_order() {
    let mut bytes = Vec::new();
    bytes.extend(masked(false, Opcode::Text, b"Hel"));
    bytes.extend(masked(true, Opcode::Ping, b"p"));
    bytes.extend(masked(false, Opcode::Continuation, b"lo "));
    bytes.extend(masked(true, Opcode::Continuation, b"world"));
    assert_eq!(
        frames(&bytes).await,
        vec![
            text(false, b"Hel"),
            ping(b"p"),
            continuation(false, b"lo "),
            continuation(true, b"world"),
        ]
    );
}

#[tokio::test]
async fn a_mask_is_applied_to_every_payload_and_a_zero_mask_changes_nothing() {
    let masked_bytes = masked(true, Opcode::Binary, &[7, 8, 9, 10, 11]);
    assert_eq!(masked_bytes[2..6], MASK);
    assert_eq!(
        frames(&masked_bytes).await,
        vec![Frame {
            fin: true,
            rsv1: false,
            opcode: Opcode::Binary,
            payload: vec![7, 8, 9, 10, 11],
        }]
    );

    let mut zero = vec![0x82, 0x85];
    zero.extend_from_slice(&[0, 0, 0, 0]);
    zero.extend_from_slice(&[7, 8, 9, 10, 11]);
    assert_eq!(
        frames(&zero).await,
        vec![Frame {
            fin: true,
            rsv1: false,
            opcode: Opcode::Binary,
            payload: vec![7, 8, 9, 10, 11],
        }]
    );
}

#[tokio::test]
async fn an_unmasked_client_frame_is_refused() {
    let error = refusal(&[0x81, 0x02, b'h', b'i']).await;
    assert!(matches!(error, FrameError::Protocol(_)));
}

#[tokio::test]
async fn every_reserved_bit_is_refused() {
    for first in [0xc1, 0xa1, 0x91] {
        let error = refusal(&[first, 0x80, 0, 0, 0, 0]).await;
        assert!(matches!(error, FrameError::Protocol(_)), "{first:#x}");
    }
    // RSV1 is refused on a continuation even when an extension is allowed.
    let error = refusal(&masked_first(0xc0, 0x80)).await;
    assert!(matches!(error, FrameError::Protocol(_)));
}

/// A masked frame header whose payload is empty.
fn masked_first(first: u8, second: u8) -> Vec<u8> {
    vec![first, second, 0, 0, 0, 0]
}

#[tokio::test]
async fn the_three_length_encodings_round_trip() {
    for length in [0usize, 125, 126, 65_535, 65_536] {
        let payload = vec![0x5a; length];
        let bytes = masked(true, Opcode::Binary, &payload);
        let got = frames(&bytes).await;
        assert_eq!(got.len(), 1, "{length}");
        assert_eq!(got[0].payload, payload, "{length}");
    }
}

#[tokio::test]
async fn a_declared_length_over_the_limit_fails_from_the_header_alone() {
    let mut bytes = declared(
        Opcode::Binary,
        127,
        &(MAX_MESSAGE_BYTES as u64 + 1).to_be_bytes(),
    );
    bytes.extend_from_slice(&MASK);
    let error = refusal(&bytes).await;
    assert!(matches!(error, FrameError::TooBig(_)));
}

#[tokio::test]
async fn a_64_bit_length_over_the_safe_integer_is_refused() {
    let mut bytes = declared(Opcode::Binary, 127, &u64::MAX.to_be_bytes());
    bytes.extend_from_slice(&MASK);
    let error = refusal(&bytes).await;
    assert!(matches!(error, FrameError::TooBig(_)));
}

#[tokio::test]
async fn reserved_and_misplaced_opcodes_are_refused() {
    for first in [0x83, 0x87, 0x8b, 0x8f] {
        let error = refusal(&masked_first(first, 0x80)).await;
        assert!(matches!(error, FrameError::Protocol(_)), "{first:#x}");
    }
    // A continuation with nothing to continue.
    let error = refusal(&masked_first(0x80, 0x80)).await;
    assert!(matches!(error, FrameError::Protocol(_)));
}

#[tokio::test]
async fn control_frames_must_be_fin_short_and_never_a_one_byte_close() {
    let error = refusal(&masked_first(0x09, 0x80)).await; // ping, not FIN
    assert!(matches!(error, FrameError::Protocol(_)));

    let long = masked(true, Opcode::Ping, &[0; 126]);
    let error = refusal(&long).await;
    assert!(matches!(error, FrameError::Protocol(_)));

    let mut close = masked_first(0x88, 0x81);
    close.extend_from_slice(&[0, 0, 0, 0, 0]);
    let error = refusal(&close).await;
    assert!(matches!(error, FrameError::Protocol(_)));
}

#[tokio::test]
async fn a_message_is_joined_from_its_fragments_between_control_frames() {
    let mut assembler = Assembler::new();
    assert_eq!(assembler.push(text(false, b"Hel")), Ok(None));
    assert_eq!(assembler.push(ping(b"p")), Ok(None));
    assert_eq!(assembler.push(continuation(false, b"lo ")), Ok(None));
    assert_eq!(
        assembler.push(continuation(true, b"world")),
        Ok(Some(Message {
            data: b"Hello world".to_vec(),
            binary: false,
        }))
    );
}

#[tokio::test]
async fn a_new_data_frame_inside_a_fragmented_message_is_refused() {
    let assembler = Assembler::new();
    assert_eq!(
        assembler.check(Opcode::Continuation, true, false),
        Err(super::CloseCode::Protocol)
    );

    let mut assembler = Assembler::new();
    assembler
        .accept(Opcode::Text, false, 1)
        .expect("a first fragment");
    assert_eq!(
        assembler.check(Opcode::Text, true, false),
        Err(super::CloseCode::Protocol)
    );
}

#[tokio::test]
async fn utf8_is_checked_over_the_whole_message_not_its_fragments() {
    // "€" is E2 82 AC: every fragment alone is invalid, the message is not.
    let mut assembler = Assembler::new();
    assert_eq!(assembler.push(text(false, &[0xe2])), Ok(None));
    assert_eq!(assembler.push(continuation(false, &[0x82])), Ok(None));
    assert_eq!(
        assembler.push(continuation(true, &[0xac])),
        Ok(Some(Message {
            data: "€".as_bytes().to_vec(),
            binary: false,
        }))
    );
}

#[tokio::test]
async fn a_complete_text_frame_that_is_not_utf8_is_refused() {
    let mut assembler = Assembler::new();
    assert_eq!(
        assembler.push(text(true, &[0xff, 0xfe])),
        Err(super::CloseCode::InvalidUtf8)
    );

    let mut binary = Assembler::new();
    assert_eq!(
        binary.push(Frame {
            fin: true,
            rsv1: false,
            opcode: Opcode::Binary,
            payload: vec![0xff, 0xfe],
        }),
        Ok(Some(Message {
            data: vec![0xff, 0xfe],
            binary: true,
        }))
    );
}

#[tokio::test]
async fn the_wire_total_is_counted_across_fragments_before_their_payloads() {
    let mut assembler = Assembler::new();
    assert!(assembler.admits(Opcode::Text, MAX_MESSAGE_BYTES));
    assert!(!assembler.admits(Opcode::Text, MAX_MESSAGE_BYTES + 1));
    assert!(assembler.admits(Opcode::Ping, MAX_MESSAGE_BYTES + 1));

    assembler
        .accept(Opcode::Text, false, MAX_MESSAGE_BYTES / 2)
        .expect("the first half fits");
    assert!(assembler.admits(Opcode::Continuation, MAX_MESSAGE_BYTES / 2));
    assert!(!assembler.admits(Opcode::Continuation, MAX_MESSAGE_BYTES / 2 + 1));
}

#[tokio::test]
async fn the_plain_body_refuses_the_byte_past_the_limit() {
    let mut plain = Plain::new();
    plain
        .feed(&vec![0; MAX_MESSAGE_BYTES], true)
        .expect("exactly the limit");
    assert_eq!(plain.feed(&[0], false), Err(super::CloseCode::TooBig));
}

#[tokio::test]
async fn close_frames_are_read_for_their_code_and_reason() {
    assert_eq!(conclude(&[]), Ok(None));
    assert_eq!(
        conclude(&[0x03, 0xe8, b'b', b'y', b'e']),
        Ok(Some((1000, b"bye".to_vec())))
    );
    // 1005 is never on the wire, 999 and 5000 are outside the valid ranges.
    for code in [999u16, 1004, 1005, 1006, 1015, 5000] {
        assert_eq!(
            conclude(&code.to_be_bytes()),
            Err(super::CloseCode::Protocol)
        );
    }
    assert_eq!(
        conclude(&[0x03, 0xe8, 0xff]),
        Err(super::CloseCode::InvalidUtf8)
    );
}

#[tokio::test]
async fn outbound_frames_use_the_shortest_length_and_never_mask() {
    let cases: &[(usize, &[u8])] = &[
        (0, &[0x81, 0x00]),
        (125, &[0x81, 125]),
        (126, &[0x81, 126, 0x00, 126]),
        (65_535, &[0x81, 126, 0xff, 0xff]),
        (65_536, &[0x81, 127, 0, 0, 0, 0, 0, 1, 0, 0]),
    ];
    for (length, header) in cases {
        let payload = vec![0x7b; *length];
        let bytes = written(Outbound {
            opcode: Opcode::Text,
            rsv1: false,
            payload: Bytes::from(payload.clone()),
        })
        .await;
        assert_eq!(&bytes[..header.len()], *header, "{length}");
        assert_eq!(&bytes[header.len()..], &payload[..], "{length}");
    }
}

#[tokio::test]
async fn rsv1_and_every_opcode_are_written_as_the_frame_says() {
    for (opcode, first) in [
        (Opcode::Text, 0x81),
        (Opcode::Binary, 0x82),
        (Opcode::Close, 0x88),
        (Opcode::Ping, 0x89),
        (Opcode::Pong, 0x8a),
    ] {
        let bytes = written(Outbound {
            opcode,
            rsv1: false,
            payload: Bytes::from_static(b"x"),
        })
        .await;
        assert_eq!(bytes, vec![first, 0x01, b'x'], "{opcode:?}");
    }
    let bytes = written(Outbound {
        opcode: Opcode::Text,
        rsv1: true,
        payload: Bytes::from_static(b"x"),
    })
    .await;
    assert_eq!(bytes[0], 0xc1, "RSV1 is the frame's own bit");
}

#[tokio::test]
async fn the_header_rules_are_also_testable_without_io() {
    // receiver.js's decisions on the two fixed bytes.
    assert!(matches!(
        parse_first([0x81, 0x02], false),
        Err(FrameError::Protocol(_))
    ));
    let first = parse_first([0x81, 0x82], false).expect("a masked text header");
    assert!(first.fin);
    assert_eq!(first.opcode, Opcode::Text);
    assert_eq!(first.short, 2);

    assert!(matches!(payload_length(125, &[]), Ok(125)));
    assert!(matches!(payload_length(126, &[0, 126]), Ok(126)));
    assert!(matches!(
        payload_length(127, &65_535u64.to_be_bytes()),
        Ok(65_535)
    ));
    assert!(payload_length(127, &u64::MAX.to_be_bytes()).is_err());
}

/// Sends one frame and returns the bytes that reached the wire.
async fn written(item: Outbound) -> Vec<u8> {
    let (mut client, server) = tokio::io::duplex(2 << 20);
    let mut writer = FrameWriter::new(server);
    writer.send(item).await.expect("the frame is written");
    drop(writer);
    let mut bytes = Vec::new();
    client
        .read_to_end(&mut bytes)
        .await
        .expect("the wire's bytes are read");
    bytes
}
