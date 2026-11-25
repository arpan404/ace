// SPDX-License-Identifier: Apache-2.0
//! A peer that drops TCP without a close frame. The socket must see the end,
//! report it as `1006` (what `ws` emits for an abrupt close) and drop the
//! connection, whether it dropped while idle, mid-message or while the reader
//! was paused for lack of credit. Bytes already buffered when the end arrived
//! are still parsed and delivered first, as `ws` feeds its receiver what it
//! holds before it reports the close.

use std::time::Duration;

use futures_util::SinkExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio_tungstenite::tungstenite::Message;

use super::{
    DELIVERY_MESSAGES, MESSAGE_OVERHEAD, SocketEvent, SocketEvents, masked_frame, masked_part,
    next, pair,
};
use crate::frame::assemble::MAX_FRAGMENTS;
use crate::socket::CLOSED;

/// Reads the raw client side until the server closes its half, failing rather
/// than hanging.
async fn assert_dropped<R: tokio::io::AsyncRead + Unpin>(client: &mut R) {
    let mut byte = [0u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(2), client.read(&mut byte))
        .await
        .expect("the server drops its half of the connection")
        .expect("a read");
    assert_eq!(read, 0, "the server closed its half of the connection");
}

/// The one `Close` event, asserting its code.
async fn assert_close_1006(events: &mut SocketEvents) {
    match next(events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006, "an abrupt close is 1006"),
        other => panic!("expected Close 1006, got {other:?}"),
    }
}

/// Spends the reader's whole inbound credit with empty messages, so it holds
/// nothing more for JavaScript and stops reading the connection.
async fn spent_credit(events: &mut SocketEvents, client: &mut DuplexStream) {
    let empty = masked_frame(0x2, b"");
    for _ in 0..DELIVERY_MESSAGES {
        client.write_all(&empty).await.expect("the client writes");
    }
    for _ in 0..DELIVERY_MESSAGES {
        assert!(matches!(next(events).await, SocketEvent::Message { .. }));
    }
    // Let the reader settle into its paused wait before the peer speaks again.
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[tokio::test]
async fn a_peer_that_drops_while_idle_ends_the_socket_with_1006() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    client
        .send(Message::text("hello"))
        .await
        .expect("the client writes");
    assert!(matches!(
        next(&mut events).await,
        SocketEvent::Message { .. }
    ));

    client
        .get_mut()
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    assert_close_1006(&mut events).await;
    assert_eq!(handle.ready_state(), CLOSED);
    assert_dropped(client.get_mut()).await;
}

#[tokio::test]
async fn a_peer_that_drops_inside_a_fragmented_message_ends_the_socket_with_1006() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = crate::socket::open(Box::new(server), None, None);
    client
        .write_all(&masked_part(0x1, false, b"first half"))
        .await
        .expect("the first fragment");

    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    assert_close_1006(&mut events).await;
    assert_eq!(handle.ready_state(), CLOSED);
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_peer_that_drops_while_the_reader_is_paused_for_credit_ends_the_socket_with_1006() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = crate::socket::open(Box::new(server), None, None);
    spent_credit(&mut events, &mut client).await;
    assert_eq!(handle.buffered_amount(), 0);

    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    assert_close_1006(&mut events).await;
    assert_eq!(handle.ready_state(), CLOSED);
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_message_buffered_while_paused_is_delivered_after_the_peers_fin() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = crate::socket::open(Box::new(server), None, None);
    spent_credit(&mut events, &mut client).await;

    // A complete message and then the FIN, both while the reader has no credit.
    client
        .write_all(&masked_frame(0x1, b"kept"))
        .await
        .expect("the message is written");
    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    // ws feeds what it buffered to its receiver before it reports the close, so
    // the message arrives first and the end is reported after it.
    handle.delivered(MESSAGE_OVERHEAD);
    match next(&mut events).await {
        SocketEvent::Message { data, binary } => {
            assert_eq!(data, b"kept", "the buffered message survives the end");
            assert!(!binary);
        }
        other => panic!("expected the buffered message, got {other:?}"),
    }
    assert_close_1006(&mut events).await;
    assert_eq!(handle.ready_state(), CLOSED);
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_close_buffered_while_paused_keeps_its_code_after_the_peers_fin() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = crate::socket::open(Box::new(server), None, None);
    spent_credit(&mut events, &mut client).await;

    // A valid close frame, then the FIN: the close frame is what ended the
    // conversation, so its code and reason are reported, not 1006.
    let bye = [0x03, 0xe8, b'b', b'y', b'e'];
    let close = masked_frame(0x8, &bye);
    client
        .write_all(&close)
        .await
        .expect("the close frame is written");
    client.shutdown().await.expect("the peer drops its half");

    handle.delivered(MESSAGE_OVERHEAD);
    match next(&mut events).await {
        SocketEvent::Close { code, reason } => {
            assert_eq!(code, 1000, "the buffered close frame decides the code");
            assert_eq!(reason, b"bye");
        }
        other => panic!("expected the peer's close, got {other:?}"),
    }
    assert_eq!(handle.ready_state(), CLOSED);
    // The peer's close is answered, then the connection is dropped.
    let (opcode, reply) = super::server_frame(&mut client).await;
    assert_eq!(
        (opcode, reply.as_slice()),
        (0x8, bye.as_slice()),
        "the peer's close is answered with the same code and reason"
    );
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_peer_that_drops_inside_a_frame_reports_no_error_before_1006() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = crate::socket::open(Box::new(server), None, None);
    let frame = masked_frame(0x1, b"truncated");
    client
        .write_all(&frame[..8])
        .await
        .expect("a partial frame is written");
    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    // Nothing precedes the close, as `ws` ends its receiver and emits 1006.
    assert_close_1006(&mut events).await;
    assert_eq!(handle.ready_state(), CLOSED);
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_header_past_the_payload_bounds_ends_with_its_own_1009() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (_handle, mut events) = crate::socket::open(Box::new(server), None, None);
    spent_credit(&mut events, &mut client).await;

    // A text frame declaring 2 MiB, past the 1 MiB bound, with only a few of
    // its bytes sent: the header alone is what the rules refuse.
    let mut frame = vec![0x81, 0x80 | 127];
    frame.extend_from_slice(&(2 * 1024 * 1024u64).to_be_bytes());
    frame.extend_from_slice(&[0x11, 0x22, 0x33, 0x44]);
    frame.extend_from_slice(&[0x41; 8]);
    client
        .write_all(&frame)
        .await
        .expect("the header and a few bytes are written");
    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    match next(&mut events).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "too_big", "the size is refused"),
        other => panic!("expected the payload bound's error, got {other:?}"),
    }
    assert_close_1006(&mut events).await;
    let (opcode, payload) = super::server_frame(&mut client).await;
    assert_eq!(
        (opcode, payload.as_slice()),
        (0x8, [0x03, 0xf1].as_slice()),
        "the refused frame closes with 1009"
    );
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_continuation_with_no_message_in_flight_ends_with_its_own_1002() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (_handle, mut events) = crate::socket::open(Box::new(server), None, None);
    spent_credit(&mut events, &mut client).await;

    // A continuation with nothing to continue, its payload cut short.
    let frame = masked_frame(0x0, &[9u8; 64]);
    client
        .write_all(&frame[..20])
        .await
        .expect("a partial continuation is written");
    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    match next(&mut events).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "protocol", "the frame has no message"),
        other => panic!("expected the protocol error, got {other:?}"),
    }
    assert_close_1006(&mut events).await;
    let (opcode, payload) = super::server_frame(&mut client).await;
    assert_eq!(
        (opcode, payload.as_slice()),
        (0x8, [0x03, 0xea].as_slice()),
        "the stray continuation closes with 1002"
    );
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_fragment_past_the_limit_ends_with_its_own_1008() {
    let (server, mut client) = tokio::io::duplex(1 << 18);
    let (handle, mut events) = crate::socket::open(Box::new(server), None, None);
    spent_credit(&mut events, &mut client).await;

    // One message split into every fragment `ws` allows, none of them final,
    // so nothing is delivered, then the fragment past the limit cut short by
    // the peer's end.
    let mut bytes = masked_part(0x1, false, b"");
    for _ in 0..MAX_FRAGMENTS - 1 {
        bytes.extend(masked_part(0x0, false, b""));
    }
    let over = masked_part(0x0, true, &[7u8; 64]);
    bytes.extend_from_slice(&over[..20]);
    client
        .write_all(&bytes)
        .await
        .expect("the fragments are written");
    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    // The credit bought the fragments, which deliver nothing, and then the
    // header past the limit is refused before its tail can be missed.
    handle.delivered(MESSAGE_OVERHEAD);
    match next(&mut events).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "protocol", "the limit is refused"),
        other => panic!("expected the fragment limit's error, got {other:?}"),
    }
    assert_close_1006(&mut events).await;
    let (opcode, payload) = super::server_frame(&mut client).await;
    assert_eq!(
        (opcode, payload.as_slice()),
        (0x8, [0x03, 0xf0].as_slice()),
        "the fragment past the limit closes with 1008"
    );
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_partial_frame_buffered_while_paused_still_ends_with_1006() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = crate::socket::open(Box::new(server), None, None);
    spent_credit(&mut events, &mut client).await;

    // A header, its mask and two payload bytes, then the FIN: the frame can
    // never complete, so the socket must end without waiting for credit that
    // would let it parse a frame that is missing its tail.
    let frame = masked_frame(0x1, b"truncated");
    client
        .write_all(&frame[..8])
        .await
        .expect("a partial frame is written");
    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    // ws reports a tail that never arrived as a bare close: nothing on `error`.
    assert_close_1006(&mut events).await;
    assert_eq!(handle.ready_state(), CLOSED);
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_message_before_a_partial_frame_is_delivered_then_the_socket_ends() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = crate::socket::open(Box::new(server), None, None);
    spent_credit(&mut events, &mut client).await;

    // A complete message and the head of a second one, then the FIN: the
    // message waits for credit, the tail never arrives.
    client
        .write_all(&masked_frame(0x1, b"kept"))
        .await
        .expect("the message is written");
    let frame = masked_frame(0x2, b"truncated");
    client
        .write_all(&frame[..8])
        .await
        .expect("a partial frame is written");
    client
        .shutdown()
        .await
        .expect("the peer drops without a close frame");

    // One delivery's credit buys the buffered message and nothing else: the
    // partial frame behind it ends the socket without a second delivery.
    handle.delivered(MESSAGE_OVERHEAD);
    match next(&mut events).await {
        SocketEvent::Message { data, binary } => {
            assert_eq!(data, b"kept", "the buffered message survives the end");
            assert!(!binary);
        }
        other => panic!("expected the buffered message, got {other:?}"),
    }
    assert_close_1006(&mut events).await;
    assert_eq!(handle.ready_state(), CLOSED);
    assert_dropped(&mut client).await;
}

#[tokio::test]
async fn a_consumer_that_never_calls_delivered_stops_reading_until_it_does() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    let payload = vec![7u8; 16 * 1024];
    for _ in 0..DELIVERY_MESSAGES + 4 {
        client
            .send(Message::binary(payload.clone()))
            .await
            .expect("the client writes");
    }
    for _ in 0..DELIVERY_MESSAGES {
        assert!(matches!(
            next(&mut events).await,
            SocketEvent::Message { .. }
        ));
    }

    // The credit is spent: more messages than the bound allows are on the wire,
    // yet the reader delivers none of them, and the socket stays open.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        events.try_recv().is_err(),
        "a consumer that never calls delivered stops delivery"
    );
    assert_eq!(handle.ready_state(), crate::socket::OPEN);

    // One delivered message buys exactly one more.
    handle.delivered(payload.len() as u64 + MESSAGE_OVERHEAD);
    match next(&mut events).await {
        SocketEvent::Message { data, .. } => assert_eq!(data, payload),
        other => panic!("expected the waiting message, got {other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        events.try_recv().is_err(),
        "the credit is spent again after one more message"
    );
}
