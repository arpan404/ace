// SPDX-License-Identifier: Apache-2.0
//! The socket's bookkeeping over an in-memory duplex: a real WebSocket client on
//! one end, the socket on the other, and both sides' events asserted. The close
//! and error paths live in `close`.

use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::DuplexStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::Role;

use super::{
    DELIVERY_MESSAGES, MAX_MESSAGE_BYTES, MESSAGE_OVERHEAD, OPEN, OUTBOUND_MESSAGES, SendResult,
    SocketEvent, SocketEvents, SocketHandle, open,
};

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
    tokio::time::timeout(Duration::from_secs(2), events.recv())
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

/// One masked text frame, as a client sends it (RFC 6455 §5.3), so a test can put
/// bytes on the wire that a WebSocket client would refuse to write.
fn masked_text(payload: &[u8]) -> Vec<u8> {
    let mask = [0x11u8, 0x22, 0x33, 0x44];
    let mut frame = vec![0x81, 0x80 | payload.len() as u8];
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
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
        SendResult::NotOpen,
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
        SendResult::NotOpen,
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
