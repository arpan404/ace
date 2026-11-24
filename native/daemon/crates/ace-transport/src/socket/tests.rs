// SPDX-License-Identifier: Apache-2.0
//! The socket's bookkeeping over an in-memory duplex: a real WebSocket client on
//! one end, the socket on the other, and both sides' events asserted.

use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::DuplexStream;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::{
    CLOSED, CLOSING, DELIVERY_MESSAGES, MAX_MESSAGE_BYTES, MESSAGE_OVERHEAD, OPEN, SendResult,
    SocketEvent, SocketHandle, open,
};

type Client = WebSocketStream<DuplexStream>;

/// A socket and a client talking to it over a duplex of `buffer` bytes.
async fn pair(buffer: usize) -> (SocketHandle, mpsc::UnboundedReceiver<SocketEvent>, Client) {
    let (server, client) = tokio::io::duplex(buffer);
    let (handle, events) = open(Box::new(server));
    let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
    (handle, events, client)
}

/// The next event, failing the test rather than hanging.
async fn next(events: &mut mpsc::UnboundedReceiver<SocketEvent>) -> SocketEvent {
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
async fn quiet(events: &mut mpsc::UnboundedReceiver<SocketEvent>) {
    assert!(
        tokio::time::timeout(Duration::from_millis(100), events.recv())
            .await
            .is_err(),
        "no event was produced"
    );
}

#[tokio::test]
async fn a_send_is_queued_once_and_completes_exactly_once() {
    // A 64-byte duplex: a 4 KiB frame cannot reach the client until it reads, so
    // the buffered amount is observable between `send` and its completion.
    let (handle, mut events, mut client) = pair(64).await;
    assert_eq!(handle.ready_state(), OPEN);
    assert_eq!(handle.buffered_amount(), 0);

    let payload = Bytes::from(vec![7u8; 4096]);
    assert_eq!(handle.send(payload.clone(), true, 41), SendResult::Queued);
    assert_eq!(
        handle.buffered_amount(),
        4096,
        "accepted bytes are buffered until flushed"
    );

    assert_eq!(read(&mut client).await, Message::Binary(payload));
    match next(&mut events).await {
        SocketEvent::Sent { id, error } => assert_eq!((id, error), (41, None)),
        other => panic!("expected exactly one Sent, got {other:?}"),
    }
    assert_eq!(
        handle.buffered_amount(),
        0,
        "a flushed frame is no longer buffered"
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
async fn a_close_is_idempotent_and_a_send_after_it_is_refused() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    handle.close(Some(4008), "Idle timeout".to_owned());
    assert_eq!(handle.ready_state(), CLOSING);
    handle.close(Some(1000), "a second close keeps the first code".to_owned());

    match read(&mut client).await {
        Message::Close(Some(frame)) => {
            assert_eq!(u16::from(frame.code), 4008);
            assert_eq!(frame.reason.as_str(), "Idle timeout");
        }
        other => panic!("expected one close frame, got {other:?}"),
    }
    client.flush().await.expect("the client answers the close");

    match next(&mut events).await {
        SocketEvent::Close { code, reason } => {
            assert_eq!((code, reason), (4008, b"Idle timeout".to_vec()));
        }
        other => panic!("expected Close, got {other:?}"),
    }
    assert_eq!(handle.ready_state(), CLOSED);
    assert_eq!(handle.buffered_amount(), 0);
    assert_eq!(
        handle.send(Bytes::from_static(b"late"), false, 9),
        SendResult::NotOpen
    );
    let after = tokio::time::timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("the queue ends");
    assert!(
        after.is_none(),
        "nothing follows Close, and a refused send emits nothing"
    );
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
    let big = vec![1u8; 700 * 1024];
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

#[tokio::test]
async fn a_peer_close_is_answered_and_reported_with_its_code_and_reason() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    let close = CloseFrame {
        code: CloseCode::Away,
        reason: "gone".into(),
    };
    client
        .send(Message::Close(Some(close)))
        .await
        .expect("the client closes");

    match next(&mut events).await {
        SocketEvent::Close { code, reason } => {
            assert_eq!(code, 1001, "the peer's code is reported");
            assert_eq!(reason, b"gone");
        }
        other => panic!("expected Close, got {other:?}"),
    }
    assert_eq!(handle.ready_state(), CLOSED);
    match read(&mut client).await {
        Message::Close(Some(frame)) => assert_eq!(frame.code, CloseCode::Away),
        other => panic!("expected the close to be answered, got {other:?}"),
    }
}

#[tokio::test]
async fn an_oversized_message_reports_too_big_and_closes_with_1009() {
    let (_handle, mut events, mut client) = pair(4 << 20).await;
    client
        .send(Message::binary(vec![0u8; MAX_MESSAGE_BYTES + 1]))
        .await
        .expect("the client writes");

    match next(&mut events).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "too_big"),
        other => panic!("expected a too_big error, got {other:?}"),
    }
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1009),
        other => panic!("expected Close after the error, got {other:?}"),
    }
    match read(&mut client).await {
        Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 1009),
        other => panic!("expected the close frame 1009, got {other:?}"),
    }
}

#[tokio::test]
async fn terminate_reports_close_1006_and_drops_the_connection() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    handle.terminate();
    assert_eq!(handle.ready_state(), CLOSED);
    match next(&mut events).await {
        SocketEvent::Close { code, reason } => {
            assert_eq!((code, reason), (1006, Vec::new()));
        }
        other => panic!("expected Close 1006, got {other:?}"),
    }
    assert_eq!(
        handle.send(Bytes::from_static(b"late"), false, 3),
        SendResult::NotOpen
    );
    let outcome = tokio::time::timeout(Duration::from_secs(2), client.next())
        .await
        .expect("the connection ends");
    assert!(
        outcome.is_none() || outcome.is_some_and(|frame| frame.is_err()),
        "the client's connection drops without a close frame"
    );
}

#[tokio::test]
async fn a_frame_that_cannot_be_flushed_is_failed_before_close() {
    // A four-byte duplex: the frame cannot be flushed, so `terminate` finds it
    // still owed and it must be reported as failed, before `Close`.
    let (handle, mut events, _client) = pair(4).await;
    assert_eq!(
        handle.send(Bytes::from(vec![9u8; 4096]), true, 11),
        SendResult::Queued
    );
    handle.terminate();

    match next(&mut events).await {
        SocketEvent::Sent { id, error } => {
            assert_eq!(id, 11);
            assert_eq!(
                error.as_deref(),
                Some("WebSocket is not open: readyState 3 (CLOSED)")
            );
        }
        other => panic!("expected the owed Sent first, got {other:?}"),
    }
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close second, got {other:?}"),
    }
}
