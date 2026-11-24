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
    CONTROL_BYTES, DELIVERY_MESSAGES, MAX_MESSAGE_BYTES, MESSAGE_OVERHEAD, OPEN, OUTBOUND_MESSAGES,
    SendResult, SocketEvent, SocketEvents, SocketHandle, open,
};
use crate::frame::assemble::MAX_FRAGMENTS;

mod close;

type Client = WebSocketStream<DuplexStream>;

/// A socket and a client talking to it over a duplex of `buffer` bytes.
async fn pair(buffer: usize) -> (SocketHandle, SocketEvents, Client) {
    let (server, client) = tokio::io::duplex(buffer);
    let (handle, events) = open(Box::new(server));
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
    assert_eq!(handle.send(payload.clone(), true, 41), SendResult::Queued);
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

#[tokio::test]
async fn a_hundred_empty_sends_leave_no_charge_behind() {
    // The overhead is what bounds an empty-send flood, and every debit must pair
    // with its charge: nothing may be left on a drained socket.
    let (handle, mut events, _client) = pair(1 << 16).await;
    for id in 0..100 {
        assert_eq!(handle.send(Bytes::new(), true, id), SendResult::Queued);
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
        assert_eq!(handle.send(tiny.clone(), true, 0), SendResult::Queued);
    }
    assert_eq!(
        handle.send(tiny, true, 0),
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
        assert_eq!(handle.send(tiny.clone(), true, 0), SendResult::Queued);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        handle.send(tiny.clone(), true, 0),
        SendResult::Full,
        "unread Sent events keep the queue full"
    );
    assert!(matches!(next(&mut events).await, SocketEvent::Sent { .. }));
    assert_eq!(
        handle.send(tiny, true, 0),
        SendResult::Queued,
        "taking one Sent frees one place"
    );
}

#[tokio::test]
async fn a_text_send_that_is_not_utf8_is_refused_without_charging() {
    let (handle, mut events, _client) = pair(1 << 16).await;
    assert_eq!(
        handle.send(Bytes::from_static(&[0xff, 0xfe]), false, 7),
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
        handle.send(Bytes::from_static(b"first"), true, 1),
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

#[tokio::test]
async fn more_than_16384_fragments_closes_with_1008() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (_handle, mut events) = open(Box::new(server));
    let mut bytes = masked_part(0x1, false, b"");
    for _ in 0..MAX_FRAGMENTS {
        bytes.extend(masked_part(0x0, false, b""));
    }
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

#[tokio::test]
async fn a_ping_flood_keeps_reading_data_and_close_and_loses_no_pong() {
    // More queued pongs than the old 16,384 cap, with a 4 KiB writer: the reader
    // must keep reading the data frame and the close behind the flood.
    let (server, client) = tokio::io::duplex(4 * 1024);
    let (handle, mut events) = open(Box::new(server));
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
    let (_handle, mut events) = open(Box::new(server));
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
