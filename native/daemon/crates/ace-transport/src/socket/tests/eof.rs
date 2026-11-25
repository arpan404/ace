// SPDX-License-Identifier: Apache-2.0
//! A peer that drops TCP without a close frame. The socket must see the end,
//! report it as `1006` (what `ws` emits for an abrupt close) and drop the
//! connection, whether it dropped while idle, mid-message or while the reader
//! was paused for lack of credit.

use std::time::Duration;

use futures_util::SinkExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

use super::{
    DELIVERY_MESSAGES, MESSAGE_OVERHEAD, SocketEvent, masked_frame, masked_part, next, pair,
};
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
async fn assert_close_1006(events: &mut super::SocketEvents) {
    match next(events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006, "an abrupt close is 1006"),
        other => panic!("expected Close 1006, got {other:?}"),
    }
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
    let empty = masked_frame(0x2, b"");
    for _ in 0..DELIVERY_MESSAGES {
        client.write_all(&empty).await.expect("the client writes");
    }
    // Every message is still waiting: the reader has no credit left, so it is
    // not reading the socket at all.
    for _ in 0..DELIVERY_MESSAGES {
        assert!(matches!(
            next(&mut events).await,
            SocketEvent::Message { .. }
        ));
    }
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
