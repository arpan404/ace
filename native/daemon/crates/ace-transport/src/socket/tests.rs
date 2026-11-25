// SPDX-License-Identifier: Apache-2.0
//! The socket's bookkeeping over an in-memory duplex: a real WebSocket client on
//! one end, the socket on the other, and both sides' events asserted. The close
//! and error paths live in `close`.

use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::Role;

use super::{
    CONTROL_BYTES, CONTROL_ENTRY_BYTES, DELIVERY_MESSAGES, MAX_MESSAGE_BYTES, MESSAGE_OVERHEAD,
    OPEN, OUTBOUND_MESSAGES, SendResult, SocketEvent, SocketEvents, SocketHandle, open,
};
use crate::deflate::{Deflater, negotiate};
use crate::frame::assemble::MAX_FRAGMENTS;

mod close;
mod eof;
mod protocol;

type Client = WebSocketStream<DuplexStream>;

/// A socket and a client talking to it over a duplex of `buffer` bytes.
async fn pair(buffer: usize) -> (SocketHandle, SocketEvents, Client) {
    let (server, client) = tokio::io::duplex(buffer);
    let (handle, events) = open(Box::new(server), None, None);
    let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
    (handle, events, client)
}

/// The next event, failing the test rather than hanging.
async fn next(events: &mut SocketEvents) -> SocketEvent {
    next_within(events, Duration::from_secs(2)).await
}

/// The next event, after at most `wait`.
async fn next_within(events: &mut SocketEvents, wait: Duration) -> SocketEvent {
    tokio::time::timeout(wait, events.recv())
        .await
        .expect("an event arrives")
        .expect("the last event closes the queue")
}

/// The next frame the client receives.
async fn read(client: &mut Client) -> Message {
    tokio::time::timeout(Duration::from_secs(2), client.next())
        .await
        .expect("a frame arrives")
        .expect("the connection is open")
        .expect("the frame is valid")
}

/// Asserts the socket produced nothing in a short window.
async fn quiet(events: &mut SocketEvents) {
    assert!(
        tokio::time::timeout(Duration::from_millis(100), events.recv())
            .await
            .is_err(),
        "no event was produced"
    );
}

/// One masked client frame, as a client sends it (RFC 6455 §5.3), so a test can
/// put bytes on the wire that a WebSocket client would refuse to write.
fn masked_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mask = [0x11u8, 0x22, 0x33, 0x44];
    let mut frame = vec![0x80 | opcode, 0x80 | payload.len() as u8];
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    frame
}

fn masked_text(payload: &[u8]) -> Vec<u8> {
    masked_frame(0x1, payload)
}

/// A masked client frame whose FIN bit is chosen, for fragmented messages.
fn masked_part(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
    let mut frame = masked_frame(opcode, payload);
    if !fin {
        frame[0] &= 0x7f;
    }
    frame
}

#[tokio::test]
async fn a_send_is_charged_once_and_completes_exactly_once() {
    // A 64-byte duplex: a 4 KiB frame cannot reach the client until it reads, so
    // the buffered amount is observable between `send` and its completion.
    let (handle, mut events, mut client) = pair(64).await;
    assert_eq!(handle.ready_state(), OPEN);
    assert_eq!(handle.buffered_amount(), 0);

    let payload = Bytes::from(vec![7u8; 4096]);
    assert_eq!(
        handle.send(payload.clone(), true, true, 41),
        SendResult::Queued
    );
    assert_eq!(
        handle.buffered_amount(),
        4096 + MESSAGE_OVERHEAD,
        "a queued send is charged its bytes plus the per-message overhead"
    );

    assert_eq!(read(&mut client).await, Message::Binary(payload));
    match next(&mut events).await {
        SocketEvent::Sent { id, error } => assert_eq!((id, error), (41, None)),
        other => panic!("expected exactly one Sent, got {other:?}"),
    }
    assert_eq!(
        handle.buffered_amount(),
        0,
        "a flushed frame leaves no phantom charge behind"
    );
}

/// A socket that negotiated `permessage-deflate`, over a duplex of `buffer` bytes.
async fn compressed_pair(buffer: usize) -> (SocketHandle, SocketEvents, DuplexStream) {
    let (server, client) = tokio::io::duplex(buffer);
    let deflate = negotiate(Some(b"permessage-deflate"))
        .expect("a valid offer")
        .expect("deflate");
    let (handle, events) = open(Box::new(server), Some(deflate), None);
    (handle, events, client)
}

/// Waits until the writer has re-charged the send, letting the socket's tasks run.
async fn recharged(handle: &SocketHandle, from: u64) -> u64 {
    for _ in 0..1000 {
        let charge = handle.buffered_amount();
        if charge != from {
            return charge;
        }
        tokio::task::yield_now().await;
    }
    panic!("the writer never re-charged the send");
}

#[tokio::test]
async fn a_compressed_send_is_charged_its_frames_wire_bytes_once_deflate_finishes() {
    // ws charges a message's uncompressed length while it deflates, then drops
    // that and leaves exactly the compressed frame's bytes pending
    // (sender.js:511-527 with websocket.js:133-136). A 64-byte duplex keeps the
    // writer mid-frame, so the re-charge is observable before the flush.
    let (handle, mut events, mut client) = compressed_pair(64).await;
    // Incompressible on purpose: the frame has to be bigger than the duplex, or
    // the flush would hide the charge.
    let payload = Bytes::from(
        (0..4096u32)
            .map(|value| (value.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect::<Vec<u8>>(),
    );
    assert_eq!(
        handle.send(payload.clone(), true, true, 1),
        SendResult::Queued
    );
    assert_eq!(
        handle.buffered_amount(),
        4096 + MESSAGE_OVERHEAD,
        "a queued send is charged its original bytes plus the per-message overhead"
    );

    let mut reference = Deflater::new(15);
    let compressed = reference.deflate(&payload).expect("the same deflate");
    let header = if compressed.len() <= 125 {
        2
    } else if compressed.len() <= u16::MAX as usize {
        4
    } else {
        10
    };
    let frame_bytes = (header + compressed.len()) as u64;
    assert!(frame_bytes > 64, "the frame must not fit the duplex");
    assert_eq!(
        recharged(&handle, 4096 + MESSAGE_OVERHEAD).await,
        frame_bytes,
        "ws reports the pending compressed frame's bytes once deflate finished"
    );

    let mut head = vec![0u8; header];
    client
        .read_exact(&mut head)
        .await
        .expect("the frame header");
    assert_eq!(head[0] & 0x40, 0x40, "RSV1 marks the frame compressed");
    let declared = match header {
        2 => usize::from(head[1] & 0x7f),
        4 => usize::from(u16::from_be_bytes([head[2], head[3]])),
        _ => usize::try_from(u64::from_be_bytes(
            head[2..].try_into().expect("eight bytes"),
        ))
        .expect("a length"),
    };
    assert_eq!(
        declared,
        compressed.len(),
        "the charge names the frame's bytes"
    );
    let mut wire = vec![0u8; compressed.len()];
    client.read_exact(&mut wire).await.expect("the payload");
    assert_eq!(
        wire, compressed,
        "the frame is the deflate the charge named"
    );
    match next(&mut events).await {
        SocketEvent::Sent { id, error } => assert_eq!((id, error), (1, None)),
        other => panic!("expected exactly one Sent, got {other:?}"),
    }
    assert_eq!(handle.buffered_amount(), 0, "the flush releases the charge");
}

#[tokio::test]
async fn a_hundred_empty_sends_leave_no_charge_behind() {
    // The overhead is what bounds an empty-send flood, and every debit must pair
    // with its charge: nothing may be left on a drained socket.
    let (handle, mut events, _client) = pair(1 << 16).await;
    for id in 0..100 {
        assert_eq!(
            handle.send(Bytes::new(), true, true, id),
            SendResult::Queued
        );
    }
    for _ in 0..100 {
        match next(&mut events).await {
            SocketEvent::Sent { error, .. } => assert_eq!(error, None),
            other => panic!("expected Sent, got {other:?}"),
        }
    }
    assert_eq!(handle.buffered_amount(), 0);
}

#[tokio::test]
async fn a_send_is_refused_once_the_outbound_queue_is_full() {
    // A four-byte duplex: nothing flushes, so every send stays undelivered.
    let (handle, _events, _client) = pair(4).await;
    let tiny = Bytes::from_static(b"x");
    for _ in 0..OUTBOUND_MESSAGES {
        assert_eq!(handle.send(tiny.clone(), true, true, 0), SendResult::Queued);
    }
    assert_eq!(
        handle.send(tiny, true, true, 0),
        SendResult::Full,
        "an undrained queue refuses more, as backpressure"
    );
}

#[tokio::test]
async fn unread_sent_events_hold_the_outbound_queue_full() {
    // The frames themselves flush long before this, but their `Sent`s have not
    // been taken, so it is the undelivered events the cap counts, not the writes.
    let (handle, mut events, _client) = pair(1 << 18).await;
    let tiny = Bytes::from_static(b"x");
    for _ in 0..OUTBOUND_MESSAGES {
        assert_eq!(handle.send(tiny.clone(), true, true, 0), SendResult::Queued);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        handle.send(tiny.clone(), true, true, 0),
        SendResult::Full,
        "unread Sent events keep the queue full"
    );
    assert!(matches!(next(&mut events).await, SocketEvent::Sent { .. }));
    assert_eq!(
        handle.send(tiny, true, true, 0),
        SendResult::Queued,
        "taking one Sent frees one place"
    );
}

#[tokio::test]
async fn a_text_send_that_is_not_utf8_is_refused_without_charging() {
    let (handle, mut events, _client) = pair(1 << 16).await;
    assert_eq!(
        handle.send(Bytes::from_static(&[0xff, 0xfe]), false, true, 7),
        SendResult::InvalidUtf8,
        "a text frame must be UTF-8; the shell fails that send's callback"
    );
    assert_eq!(handle.buffered_amount(), 0, "a refusal charges nothing");
    assert!(
        events.try_recv().is_err(),
        "a refused send owes no Sent and emits nothing"
    );
}

#[tokio::test]
async fn messages_arrive_with_their_binary_flag_and_bytes() {
    let (_handle, mut events, mut client) = pair(1 << 16).await;
    client
        .send(Message::text("hello"))
        .await
        .expect("the client writes");
    client
        .send(Message::binary(vec![0, 1, 255]))
        .await
        .expect("the client writes");

    match next(&mut events).await {
        SocketEvent::Message { data, binary } => {
            assert_eq!(data, b"hello");
            assert!(!binary, "a text frame stays text");
        }
        other => panic!("expected a text message, got {other:?}"),
    }
    match next(&mut events).await {
        SocketEvent::Message { data, binary } => {
            assert_eq!(data, vec![0, 1, 255]);
            assert!(binary, "a binary frame stays binary");
        }
        other => panic!("expected a binary message, got {other:?}"),
    }
}

#[tokio::test]
async fn the_reader_stops_at_sixty_four_waiting_messages() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    for _ in 0..DELIVERY_MESSAGES + 4 {
        client
            .send(Message::binary(Vec::new()))
            .await
            .expect("the client writes");
    }
    for _ in 0..DELIVERY_MESSAGES {
        match next(&mut events).await {
            SocketEvent::Message { data, .. } => assert!(data.is_empty()),
            other => panic!("expected a message, got {other:?}"),
        }
    }
    // Empty messages charge 256 bytes each, so the message count is the bound.
    quiet(&mut events).await;

    handle.delivered(MESSAGE_OVERHEAD);
    assert!(
        matches!(next(&mut events).await, SocketEvent::Message { .. }),
        "a delivered message lets the reader read one more"
    );
}

#[tokio::test]
async fn the_reader_stops_at_a_mebibyte_of_charged_input() {
    let (handle, mut events, mut client) = pair(2 << 20).await;
    let big = vec![1u8; MAX_MESSAGE_BYTES * 2 / 3];
    for _ in 0..3 {
        client
            .send(Message::binary(big.clone()))
            .await
            .expect("the client writes");
    }
    for _ in 0..2 {
        assert!(matches!(
            next(&mut events).await,
            SocketEvent::Message { .. }
        ));
    }
    quiet(&mut events).await;

    handle.delivered(big.len() as u64 + MESSAGE_OVERHEAD);
    assert!(
        matches!(next(&mut events).await, SocketEvent::Message { .. }),
        "a delivered message lets the reader read one more"
    );
}

#[tokio::test]
async fn pause_stops_reading_until_resume() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    handle.pause();
    assert!(handle.is_paused());
    client
        .send(Message::text("while paused"))
        .await
        .expect("the client writes");
    quiet(&mut events).await;

    handle.resume();
    assert!(!handle.is_paused());
    match next(&mut events).await {
        SocketEvent::Message { data, .. } => assert_eq!(data, b"while paused"),
        other => panic!("expected the held message, got {other:?}"),
    }
}

#[tokio::test]
async fn a_control_reply_keeps_its_place_behind_queued_data() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    assert_eq!(
        handle.send(Bytes::from_static(b"first"), true, true, 1),
        SendResult::Queued
    );
    client
        .send(Message::Ping(Bytes::from_static(b"p")))
        .await
        .expect("the client pings");
    assert_eq!(
        read(&mut client).await,
        Message::Binary(Bytes::from_static(b"first")),
        "the queued data frame goes first"
    );
    assert_eq!(
        read(&mut client).await,
        Message::Pong(Bytes::from_static(b"p")),
        "the pong follows it"
    );
    assert!(matches!(
        next(&mut events).await,
        SocketEvent::Sent { id: 1, .. }
    ));
}

/// The next unmasked server frame: opcode and payload.
async fn server_frame<R: tokio::io::AsyncRead + Unpin>(read: &mut R) -> (u8, Vec<u8>) {
    let mut head = [0u8; 2];
    read.read_exact(&mut head)
        .await
        .expect("a frame header is read");
    let opcode = head[0] & 0x0f;
    let length = match head[1] & 0x7f {
        126 => {
            let mut bytes = [0u8; 2];
            read.read_exact(&mut bytes)
                .await
                .expect("the 16-bit length is read");
            usize::from(u16::from_be_bytes(bytes))
        }
        127 => {
            let mut bytes = [0u8; 8];
            read.read_exact(&mut bytes)
                .await
                .expect("the 64-bit length is read");
            u64::from_be_bytes(bytes) as usize
        }
        length => usize::from(length),
    };
    let mut payload = vec![0u8; length];
    read.read_exact(&mut payload)
        .await
        .expect("the payload is read");
    (opcode, payload)
}
/// One message split into `count` empty fragments: a text start, continuations
/// and a final one.
fn fragmented_message(count: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(count * 6);
    for index in 0..count {
        let opcode = if index == 0 { 0x1 } else { 0x0 };
        bytes.extend(masked_part(opcode, index + 1 == count, b""));
    }
    bytes
}

#[tokio::test]
async fn the_fragment_bound_accepts_exactly_what_ws_accepts() {
    // ws counts every data frame - the first, the last and empty ones alike -
    // and refuses only once the count passes the bound (`receiver.js:504`,
    // reset on the final frame at `:589`). N fragments are accepted; the test
    // below refuses N+1.
    for count in [MAX_FRAGMENTS - 1, MAX_FRAGMENTS] {
        let (server, client) = tokio::io::duplex(1 << 18);
        let (_handle, mut events) = open(Box::new(server), None, None);
        let (mut read, mut write) = tokio::io::split(client);
        let bytes = fragmented_message(count);
        write
            .write_all(&bytes)
            .await
            .expect("the fragments are written");

        match next(&mut events).await {
            SocketEvent::Message { data, .. } => assert!(
                data.is_empty(),
                "{count} fragments complete one empty message"
            ),
            other => panic!("{count} fragments are within the bound, got {other:?}"),
        }
        // A ping behind the message proves the reader took every fragment and
        // did not close: frames are handled in order.
        write
            .write_all(&masked_frame(0x9, b""))
            .await
            .expect("the ping is written");
        let (opcode, _) = server_frame(&mut read).await;
        assert_eq!(opcode, 0xa, "the socket stays open after {count} fragments");
    }
}

#[tokio::test]
async fn a_message_one_fragment_past_the_bound_closes_with_1008() {
    let (server, mut client) = tokio::io::duplex(1 << 18);
    let (_handle, mut events) = open(Box::new(server), None, None);
    let bytes = fragmented_message(MAX_FRAGMENTS + 1);
    client
        .write_all(&bytes)
        .await
        .expect("the fragments are written");

    match next(&mut events).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "protocol"),
        other => panic!("expected a fragment-limit error, got {other:?}"),
    }
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close 1006, got {other:?}"),
    }
    let mut answer = [0u8; 4];
    client
        .read_exact(&mut answer)
        .await
        .expect("the close frame arrives");
    assert_eq!(
        answer,
        [0x88, 0x02, 0x03, 0xf0],
        "the close frame carries 1008"
    );
}

#[tokio::test]
async fn a_ping_flood_keeps_reading_data_and_close_and_loses_no_pong() {
    // More queued pongs than the old 16,384 cap, with a 4 KiB writer: the reader
    // must keep reading the data frame and the close behind the flood.
    let (server, client) = tokio::io::duplex(4 * 1024);
    let (handle, mut events) = open(Box::new(server), None, None);
    let total = 20_000usize;
    let ping = masked_frame(0x9, b"p");
    let mut bytes = Vec::with_capacity(total * ping.len() + 8);
    for _ in 0..total {
        bytes.extend_from_slice(&ping);
    }
    bytes.extend_from_slice(&masked_frame(0x2, b"data"));

    let (mut read, mut write) = tokio::io::split(client);
    tokio::time::timeout(Duration::from_secs(5), write.write_all(&bytes))
        .await
        .expect("the flood is read, not stalled at a pong cap")
        .expect("the pings and data are written");

    // The reader read past the backlog and delivered the data frame.
    match next(&mut events).await {
        SocketEvent::Message { data, binary } => {
            assert_eq!(data, b"data");
            assert!(binary);
        }
        other => panic!("expected the data frame, got {other:?}"),
    }
    assert!(
        handle.buffered_amount() > 0,
        "the writer still has a pong backlog to drain"
    );

    let mut received = 0usize;
    while received < total {
        let (opcode, payload) = server_frame(&mut read).await;
        assert_eq!((opcode, payload.as_slice()), (0xa, b"p".as_slice()));
        received += 1;
    }

    // The close behind the flood is still read and answered.
    write
        .write_all(&masked_frame(0x8, &[0x03, 0xe8]))
        .await
        .expect("the peer closes");
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1000),
        other => panic!("expected Close, got {other:?}"),
    }
    let (opcode, payload) = server_frame(&mut read).await;
    assert_eq!((opcode, payload.as_slice()), (0x8, [0x03, 0xe8].as_slice()));
}

#[tokio::test]
async fn a_pong_backlog_past_the_memory_ceiling_closes_with_1008() {
    // ws has no bound here; ours is a memory ceiling, four times the outbox's
    // resync threshold, and passing it is a policy close.
    let (server, client) = tokio::io::duplex(64 * 1024);
    let (_handle, mut events) = open(Box::new(server), None, None);
    let payload = vec![0x5a; 125];
    let ping = masked_frame(0x9, &payload);
    // Past the ceiling plus the writer's 64 KiB pipe, which settles that many.
    let total = usize::try_from(CONTROL_BYTES / 125).expect("the ceiling fits") + 2_000;
    let mut bytes = Vec::with_capacity(total * ping.len());
    for _ in 0..total {
        bytes.extend_from_slice(&ping);
    }

    let (mut read, mut write) = tokio::io::split(client);
    let writer = tokio::spawn(async move {
        // The server closes mid-flood; the rest cannot be written.
        let _ = write.write_all(&bytes).await;
    });

    // Nothing drains the writer, so the queue reaches the ceiling. Its error is
    // emitted before the close frame, while that frame still waits for the pipe.
    match next_within(&mut events, Duration::from_secs(20)).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "protocol"),
        other => panic!("expected the too-many-pongs error, got {other:?}"),
    }

    let mut close = None;
    while close.is_none() {
        let (opcode, payload) = server_frame(&mut read).await;
        if opcode == 0x8 {
            close = Some(payload);
        } else {
            assert_eq!(opcode, 0xa, "an unmasked pong comes first");
        }
    }
    assert_eq!(close.expect("a close frame"), [0x03, 0xf0], "1008");
    let _ = writer.await;

    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close 1006, got {other:?}"),
    }
}

/// Queues `total` pings of `payload_len` bytes behind a writer of `buffer` and
/// returns `bufferedAmount`, waiting on the scheduler (not a sleep) until the
/// reader has accounted for the last one.
async fn queued_pong_bytes(payload_len: usize, total: usize, buffer: usize) -> u64 {
    let (server, client) = tokio::io::duplex(buffer);
    let (handle, _events) = open(Box::new(server), None, None);
    let ping = masked_frame(0x9, &vec![0x5a; payload_len]);
    let mut bytes = Vec::with_capacity(total * ping.len());
    for _ in 0..total {
        bytes.extend_from_slice(&ping);
    }
    let (_read, mut write) = tokio::io::split(client);
    tokio::time::timeout(Duration::from_secs(5), write.write_all(&bytes))
        .await
        .expect("the pings are read")
        .expect("the pings are written");

    let expected = (payload_len as u64 + 2) * total as u64;
    for _ in 0..1_000 {
        if handle.buffered_amount() == expected {
            break;
        }
        tokio::task::yield_now().await;
    }
    handle.buffered_amount()
}

#[tokio::test]
async fn buffered_amount_counts_each_pong_as_its_frame_bytes() {
    // ws reports the bytes in the socket write buffer: a pong's 2-byte header
    // plus payload, never the outbox's 256-byte per-message overhead.
    assert_eq!(
        queued_pong_bytes(0, 100, 1).await,
        2 * 100,
        "an empty pong still costs its 2-byte header"
    );
    assert_eq!(
        queued_pong_bytes(125, 50, 64).await,
        127 * 50,
        "a 125-byte pong is 127 frame bytes"
    );
}

#[tokio::test]
async fn an_empty_ping_flood_hits_the_memory_ceiling_and_closes_1008() {
    // An empty pong charges 2 frame bytes, so bufferedAmount alone would never
    // bound a flood; the memory ceiling counts the queue entry too.
    let (server, client) = tokio::io::duplex(64 * 1024);
    let (_handle, mut events) = open(Box::new(server), None, None);
    let per_pong = 2 + CONTROL_ENTRY_BYTES;
    let total = usize::try_from(CONTROL_BYTES / per_pong).expect("the ceiling fits") + 50_000;
    let ping = masked_frame(0x9, b"");
    let mut bytes = Vec::with_capacity(total * ping.len());
    for _ in 0..total {
        bytes.extend_from_slice(&ping);
    }

    let (mut read, mut write) = tokio::io::split(client);
    let writer = tokio::spawn(async move {
        let _ = write.write_all(&bytes).await;
    });

    match next_within(&mut events, Duration::from_secs(20)).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "protocol"),
        other => panic!("expected the too-many-pongs error, got {other:?}"),
    }
    let mut close = None;
    while close.is_none() {
        let (opcode, payload) = server_frame(&mut read).await;
        if opcode == 0x8 {
            close = Some(payload);
        } else {
            assert_eq!(opcode, 0xa, "an unmasked pong comes first");
        }
    }
    assert_eq!(close.expect("a close frame"), [0x03, 0xf0], "1008");
    let _ = writer.await;
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close 1006, got {other:?}"),
    }
}

#[tokio::test]
async fn a_local_close_queues_behind_a_pong_backlog() {
    // A one-byte writer keeps every pong queued, so the close is enqueued behind
    // all of them; it must come out last, in one piece.
    let (server, client) = tokio::io::duplex(1);
    let (handle, _events) = open(Box::new(server), None, None);
    let total = 2_000usize;
    let ping = masked_frame(0x9, b"p");
    let mut bytes = Vec::with_capacity(total * ping.len());
    for _ in 0..total {
        bytes.extend_from_slice(&ping);
    }
    let (mut read, mut write) = tokio::io::split(client);
    tokio::time::timeout(Duration::from_secs(5), write.write_all(&bytes))
        .await
        .expect("the pings are read")
        .expect("the pings are written");

    // All pongs are queued (3 frame bytes each) before the close is enqueued.
    for _ in 0..1_000 {
        if handle.buffered_amount() == 3 * total as u64 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(handle.buffered_amount(), 3 * total as u64);
    handle
        .close(Some(4008), "bye".to_owned())
        .expect("a valid close");

    let mut pongs = 0usize;
    loop {
        let (opcode, payload) = server_frame(&mut read).await;
        match opcode {
            0xa => {
                assert_eq!(payload, b"p");
                pongs += 1;
            }
            0x8 => {
                assert_eq!(
                    payload,
                    [0x0f, 0xa8, b'b', b'y', b'e'],
                    "the local close is last"
                );
                break;
            }
            other => panic!("unexpected frame {other:#x} before the close"),
        }
    }
    assert_eq!(pongs, total, "every queued pong preceded the close");
}

#[tokio::test]
async fn a_ping_is_answered_and_never_surfaced() {
    let (_handle, mut events, mut client) = pair(1 << 16).await;
    client
        .send(Message::Ping(Bytes::from_static(b"hb")))
        .await
        .expect("the client pings");
    assert_eq!(
        read(&mut client).await,
        Message::Pong(Bytes::from_static(b"hb"))
    );
    quiet(&mut events).await;
}
