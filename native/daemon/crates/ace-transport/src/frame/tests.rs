// SPDX-License-Identifier: Apache-2.0
//! The frame rules as input/output tables. Every case is bytes on a real duplex
//! and the frames (or the refusal) that come off them, so a rule is checked at
//! the same edge the socket uses.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{FutureExt, SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

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
        payload: Bytes::copy_from_slice(payload),
    }
}

fn continuation(fin: bool, payload: &[u8]) -> Frame {
    Frame {
        fin,
        rsv1: false,
        opcode: Opcode::Continuation,
        payload: Bytes::copy_from_slice(payload),
    }
}

fn ping(payload: &[u8]) -> Frame {
    Frame {
        fin: true,
        rsv1: false,
        opcode: Opcode::Ping,
        payload: Bytes::copy_from_slice(payload),
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
                payload: Bytes::from(vec![0, 1, 255]),
            },
            ping(b"hb"),
            Frame {
                fin: true,
                rsv1: false,
                opcode: Opcode::Pong,
                payload: Bytes::new(),
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
            payload: Bytes::from(vec![7, 8, 9, 10, 11]),
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
            payload: Bytes::from(vec![7, 8, 9, 10, 11]),
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
        assert_eq!(got[0].payload.as_ref(), payload.as_slice(), "{length}");
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
            payload: Bytes::from(vec![0xff, 0xfe]),
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

/// An `AsyncRead` that yields one byte per poll, so a frame spans every partial
/// read a socket can produce.
struct Dribble {
    bytes: Vec<u8>,
    at: usize,
}

impl Dribble {
    fn new(bytes: Vec<u8>) -> Self {
        Self { bytes, at: 0 }
    }
}

impl AsyncRead for Dribble {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.at < this.bytes.len() && buf.remaining() > 0 {
            buf.put_slice(&[this.bytes[this.at]]);
            this.at += 1;
        }
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn a_frame_read_one_byte_at_a_time_is_whole() {
    let payload = vec![0x5a; 300];
    let bytes = masked(false, Opcode::Binary, &payload);
    let mut reader = FrameReader::new(Dribble::new(bytes));
    let frame = reader
        .next()
        .await
        .expect("a frame")
        .expect("a valid frame");
    assert!(!frame.fin);
    assert_eq!(frame.opcode, Opcode::Binary);
    assert_eq!(
        frame.payload, payload,
        "header, length, mask and payload split"
    );
    assert!(reader.next().await.is_none(), "the end is still the end");
}

#[tokio::test]
async fn a_fragmented_message_read_one_byte_at_a_time_keeps_its_frames() {
    let mut bytes = masked(false, Opcode::Text, b"Hel");
    bytes.extend(masked(true, Opcode::Ping, b"p"));
    bytes.extend(masked(true, Opcode::Continuation, b"lo"));
    let mut reader = FrameReader::new(Dribble::new(bytes));
    let mut frames = Vec::new();
    while let Some(frame) = reader.next().await {
        frames.push(frame.expect("a valid frame"));
    }
    assert_eq!(
        frames,
        vec![text(false, b"Hel"), ping(b"p"), continuation(true, b"lo"),]
    );
}

#[derive(Default)]
struct Counts {
    writes: usize,
    flushes: usize,
    first_write_len: usize,
}

/// An `AsyncWrite` that accepts at most `accept` bytes per write and counts the
/// calls, so a test can see how many writes and flushes one message took.
struct Counting {
    counts: Arc<Mutex<Counts>>,
    accept: usize,
}

impl Counting {
    fn new(accept: usize) -> (Self, Arc<Mutex<Counts>>) {
        let counts = Arc::new(Mutex::new(Counts::default()));
        (
            Self {
                counts: Arc::clone(&counts),
                accept,
            },
            counts,
        )
    }
}

impl AsyncWrite for Counting {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let mut counts = this.counts.lock().expect("no poison");
        if counts.writes == 0 {
            counts.first_write_len = buf.len();
        }
        counts.writes += 1;
        Poll::Ready(Ok(buf.len().min(this.accept)))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.counts.lock().expect("no poison").flushes += 1;
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn a_message_is_one_write_and_one_flush() {
    let (io, counts) = Counting::new(7);
    let mut writer = FrameWriter::new(io);
    writer
        .send(Outbound {
            opcode: Opcode::Text,
            rsv1: false,
            payload: Bytes::from(vec![0x7b; 20]),
        })
        .await
        .expect("the frame is written");

    let counts = counts.lock().expect("no poison");
    assert_eq!(counts.flushes, 1, "one flush per message");
    assert_eq!(
        counts.first_write_len, 22,
        "header and payload in one write"
    );
    assert_eq!(counts.writes, 4, "a 7-byte writer takes four writes");
}

#[tokio::test]
async fn a_frame_in_flight_is_never_interleaved_with_the_next() {
    let (io, counts) = Counting::new(usize::MAX);
    let mut writer = FrameWriter::new(io);
    writer
        .feed(Outbound {
            opcode: Opcode::Text,
            rsv1: false,
            payload: Bytes::from_static(b"one"),
        })
        .await
        .expect("the first frame is buffered");

    let error = writer
        .send(Outbound {
            opcode: Opcode::Close,
            rsv1: false,
            payload: Bytes::from_static(b"\x03\xe8"),
        })
        .await
        .expect_err("a second frame is refused while the first is in flight");
    assert!(error.to_string().contains("still in flight"));

    writer.flush().await.expect("the first frame still flushes");
    let counts = counts.lock().expect("no poison");
    assert_eq!(counts.first_write_len, 5, "only the first frame's bytes");
    assert_eq!(counts.writes, 1);
}

#[tokio::test]
async fn more_than_16384_fragments_is_refused_with_1008() {
    let mut assembler = Assembler::new();
    assembler
        .accept(Opcode::Text, false, 0)
        .expect("the first fragment");
    for _ in 0..super::assemble::MAX_FRAGMENTS - 1 {
        assembler
            .accept(Opcode::Continuation, false, 0)
            .expect("still within the limit");
    }
    assert_eq!(
        assembler.accept(Opcode::Continuation, false, 0),
        Err(super::CloseCode::TooManyFragments)
    );
    assert_eq!(super::CloseCode::TooManyFragments.wire(), 1008);
}

/// An `AsyncWrite` that takes a fixed number of bytes and then stalls forever.
struct Stalling {
    budget: usize,
}

impl Stalling {
    fn new(budget: usize) -> Self {
        Self { budget }
    }
}

impl AsyncWrite for Stalling {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.budget == 0 {
            return Poll::Pending;
        }
        let written = buf.len().min(this.budget);
        this.budget -= written;
        Poll::Ready(Ok(written))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn a_frame_is_accepted_only_from_start_send_until_a_full_flush() {
    let mut writer = FrameWriter::new(Stalling::new(1));
    assert!(!writer.accepted(), "nothing has been handed to the sink");
    let close = || Outbound {
        opcode: Opcode::Close,
        rsv1: false,
        payload: Bytes::from_static(b"\x03\xe8"),
    };

    let send = writer.send(close());
    assert!(
        send.now_or_never().is_none(),
        "a one-byte writer stalls mid-frame"
    );
    assert!(
        writer.accepted(),
        "start_send accepted the close before the cancellation"
    );

    let (io, counts) = Counting::new(usize::MAX);
    let mut flushing = FrameWriter::new(io);
    flushing.send(close()).await.expect("a full frame writes");
    assert!(!flushing.accepted(), "a full flush clears the signal");
    drop(counts);
}

#[tokio::test]
async fn an_unstarted_frame_is_not_accepted_and_still_writes() {
    let (io, counts) = Counting::new(usize::MAX);
    let mut writer = FrameWriter::new(io);
    assert!(!writer.accepted());
    writer
        .send(Outbound {
            opcode: Opcode::Close,
            rsv1: false,
            payload: Bytes::from_static(b"\x03\xe8"),
        })
        .await
        .expect("a fresh sink writes the close");
    assert_eq!(counts.lock().expect("no poison").writes, 1);
}

#[tokio::test]
async fn a_watch_fill_never_passes_its_limit() {
    // One byte of room on the last read: a whole read there would overshoot the
    // limit, which is the bound a paused reader's buffer relies on.
    let limit = super::read::READ_CHUNK + 1;
    let (mut client, server) = tokio::io::duplex(1 << 16);
    let mut reader = FrameReader::new(server);
    client
        .write_all(&vec![0u8; limit * 2])
        .await
        .expect("more than the limit is written");

    let more = std::future::poll_fn(|cx| reader.poll_watch(cx, limit))
        .await
        .expect("the watch fill reads");
    assert!(more, "the connection is still up");
    assert_eq!(
        reader.buffered_bytes(),
        limit,
        "the fill stopped at its limit, not a read past it"
    );
}

#[tokio::test]
async fn a_buffered_frame_is_whole_only_once_its_payload_is_there() {
    // Both extended length forms: the header, its extended length and the mask
    // count towards the frame, not just the payload.
    for size in [300usize, 70_000] {
        let frame = masked(true, Opcode::Binary, &vec![7u8; size]);
        let (mut client, server) = tokio::io::duplex(1 << 17);
        client
            .write_all(&frame[..frame.len() - 1])
            .await
            .expect("all but the last byte is written");
        let mut reader = FrameReader::new(server);

        let short = frame.len() - 1;
        std::future::poll_fn(|cx| reader.poll_watch(cx, short))
            .await
            .expect("the short frame is buffered");
        assert!(
            !reader.has_buffered_frame().expect("a readable header"),
            "a {size}-byte payload one byte short is not whole"
        );

        client
            .write_all(&frame[frame.len() - 1..])
            .await
            .expect("the last byte is written");
        std::future::poll_fn(|cx| reader.poll_watch(cx, frame.len()))
            .await
            .expect("the last byte is buffered");
        assert!(
            reader.has_buffered_frame().expect("a readable header"),
            "a {size}-byte payload is whole once its last byte arrives"
        );
    }
}

#[tokio::test]
async fn an_interrupted_parse_knows_when_its_frame_is_whole() {
    let frame = masked(true, Opcode::Binary, &vec![7u8; 300]);
    let (mut client, server) = tokio::io::duplex(1 << 16);
    client
        .write_all(&frame[..frame.len() - 1])
        .await
        .expect("all but the last byte is written");
    let mut reader = FrameReader::new(server);
    // A cancelled read leaves the parser inside the payload, not at its start.
    assert!(
        tokio::time::timeout(Duration::from_millis(20), reader.next())
            .await
            .is_err(),
        "the frame waits for its tail"
    );
    assert_eq!(
        reader.buffered_bytes(),
        frame.len() - 1 - 8,
        "the 4-byte header and the mask were consumed before the interruption"
    );
    assert!(
        !reader.has_buffered_frame().expect("a readable header"),
        "the payload is one byte short"
    );

    client
        .write_all(&frame[frame.len() - 1..])
        .await
        .expect("the last byte is written");
    std::future::poll_fn(|cx| reader.poll_watch(cx, 300))
        .await
        .expect("the last byte is buffered");
    assert!(
        reader.has_buffered_frame().expect("a readable header"),
        "the frame is whole"
    );
    let parsed = reader
        .next()
        .await
        .expect("a frame")
        .expect("a valid frame");
    assert_eq!(parsed.payload.len(), 300);
}
