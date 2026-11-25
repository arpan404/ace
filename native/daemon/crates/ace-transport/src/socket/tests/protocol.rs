// SPDX-License-Identifier: Apache-2.0
//! A failure that arrives behind a valid message. `ws` runs the consumer's
//! handler synchronously, so a reply to that message is queued before the error
//! closes the socket; the socket must deliver the message first, let the reply
//! reach the wire, and only then report the error and close.

use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::timeout;

use super::{
    MESSAGE_OVERHEAD, SendResult, SocketEvent, SocketEvents, masked_frame, next, server_frame,
};
use crate::socket::{CLOSE_TIMEOUT, CLOSED, open};

/// The events through a failure once the handler has answered: the reply's
/// `Sent`, the error, the close.
async fn assert_answered_then_refused(events: &mut SocketEvents) {
    match next(events).await {
        SocketEvent::Sent { id, error } => assert_eq!((id, error), (1, None)),
        other => panic!("expected the reply's Sent, got {other:?}"),
    }
    match next(events).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "protocol", "the bad frame's error"),
        other => panic!("expected the protocol error, got {other:?}"),
    }
    match next(events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006, "the failure's close"),
        other => panic!("expected Close 1006, got {other:?}"),
    }
}

/// Reads the reply and then the 1002 close frame, and the drop behind them.
async fn assert_reply_then_close(client: &mut tokio::io::DuplexStream) {
    let (opcode, payload) = server_frame(client).await;
    assert_eq!(
        (opcode, payload.as_slice()),
        (0x2, b"echo".as_slice()),
        "the reply the handler sent reaches the peer before the close"
    );
    let (opcode, payload) = server_frame(client).await;
    assert_eq!(
        (opcode, payload.as_slice()),
        (0x8, [0x03, 0xea].as_slice()),
        "the close frame carries 1002"
    );
    super::eof::assert_dropped(client).await;
}

/// A valid message, one bad frame, then a ping: the shape the suite sends.
async fn answered(bad: Vec<u8>) {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = open(Box::new(server), None, None);
    let mut bytes = masked_frame(0x1, b"hello");
    bytes.extend(bad);
    bytes.extend(masked_frame(0x9, b"ping"));
    client
        .write_all(&bytes)
        .await
        .expect("the frames are written");

    match next(&mut events).await {
        SocketEvent::Message { data, .. } => assert_eq!(data, b"hello"),
        other => panic!("expected the message, got {other:?}"),
    }
    // What a handler does: reply, then hand the delivery back.
    assert_eq!(
        handle.send(Bytes::from_static(b"echo"), true, true, 1),
        SendResult::Queued,
        "the socket is still open while the handler runs"
    );
    handle.delivered(b"hello".len() as u64 + MESSAGE_OVERHEAD);

    assert_answered_then_refused(&mut events).await;
    assert_eq!(handle.ready_state(), CLOSED);
    assert_reply_then_close(&mut client).await;
}

#[tokio::test]
async fn a_message_before_a_reserved_bit_is_answered_before_the_close() {
    // RSV1 without `permessage-deflate`: the first byte's reserved bit.
    answered(vec![0xc1, 0x80 | 1, 0x11, 0x22, 0x33, 0x44, 0x5a]).await;
}

#[tokio::test]
async fn a_message_before_a_reserved_opcode_is_answered_before_the_close() {
    answered(masked_frame(0x3, b"")).await;
}

#[tokio::test]
async fn a_message_before_a_stray_continuation_is_answered_before_the_close() {
    answered(masked_frame(0x0, b"")).await;
}

#[tokio::test(start_paused = true)]
async fn a_consumer_that_never_returns_credit_gets_the_close_at_the_timeout() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (_handle, mut events) = open(Box::new(server), None, None);
    let mut bytes = masked_frame(0x1, b"hello");
    bytes.extend(masked_frame(0x3, b""));
    client
        .write_all(&bytes)
        .await
        .expect("the frames are written");

    let start = tokio::time::Instant::now();
    match events.recv().await {
        Some(SocketEvent::Message { .. }) => {}
        other => panic!("expected the message, got {other:?}"),
    }
    // The delivery is never handed back, so the error and the close wait for the
    // close timeout, and no reply can be expected.
    match events.recv().await {
        Some(SocketEvent::Error { code, .. }) => assert_eq!(code, "protocol"),
        other => panic!("expected the protocol error, got {other:?}"),
    }
    match events.recv().await {
        Some(SocketEvent::Close { code, .. }) => assert_eq!(code, 1006),
        other => panic!("expected Close 1006, got {other:?}"),
    }
    assert!(
        start.elapsed() >= CLOSE_TIMEOUT,
        "the close waited for the credit until the timeout, got {:?}",
        start.elapsed()
    );
    drop(events);
    let (opcode, payload) = server_frame(&mut client).await;
    assert_eq!(
        (opcode, payload.as_slice()),
        (0x8, [0x03, 0xea].as_slice()),
        "the close frame carries 1002"
    );
    let mut byte = [0u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(2), client.read(&mut byte))
        .await
        .expect("the server drops its half")
        .expect("a read");
    assert_eq!(read, 0);
}

#[tokio::test]
async fn a_send_after_the_handlers_return_credit_is_refused() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = open(Box::new(server), None, None);
    let mut bytes = masked_frame(0x1, b"hello");
    bytes.extend(masked_frame(0x3, b""));
    client
        .write_all(&bytes)
        .await
        .expect("the frames are written");

    match next(&mut events).await {
        SocketEvent::Message { .. } => {}
        other => panic!("expected the message, got {other:?}"),
    }
    assert_eq!(
        handle.send(Bytes::from_static(b"echo"), true, true, 1),
        SendResult::Queued
    );
    handle.delivered(b"hello".len() as u64 + MESSAGE_OVERHEAD);
    assert_eq!(
        handle.ready_state(),
        crate::socket::CLOSING,
        "a failure closes the socket as soon as it is parsed, as ws does"
    );
    assert_eq!(
        handle.send(Bytes::from_static(b"late"), true, true, 2),
        SendResult::NotOpen,
        "a send after the handler returned is refused, as ws refuses it"
    );
}

/// A server that opens a socket per connection and echoes, holding each
/// delivery's credit until the test hands it back, as a stalled consumer would.
async fn stalling_server() -> (
    std::net::SocketAddr,
    tokio::sync::mpsc::UnboundedReceiver<crate::socket::SocketHandle>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("an address");
    let (held, handles) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let (handle, mut events) = open(Box::new(stream), None, None);
            let held = held.clone();
            tokio::spawn(async move {
                let mut id = 0;
                while let Some(event) = events.recv().await {
                    match event {
                        SocketEvent::Message { data, .. } => {
                            id += 1;
                            let _ = handle.send(Bytes::from(data), true, true, id);
                            // The credit is never returned here: the socket
                            // waits for it before its error's close.
                            let _ = held.send(handle.clone());
                        }
                        SocketEvent::Close { .. } => return,
                        _ => {}
                    }
                }
            });
        }
    });
    (address, handles)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sockets_waiting_to_close_still_serve_a_new_connection() {
    let (address, mut held) = stalling_server().await;
    // More sockets than workers, each waiting for credit before its close.
    let mut clients = Vec::new();
    for _ in 0..4 {
        let mut client = tokio::net::TcpStream::connect(address)
            .await
            .expect("a connection");
        let mut bytes = masked_frame(0x1, b"hello");
        bytes.extend(masked_frame(0x3, b""));
        client
            .write_all(&bytes)
            .await
            .expect("the frames are written");
        clients.push(client);
    }
    let mut handles = Vec::new();
    for _ in 0..4 {
        handles.push(
            timeout(Duration::from_secs(2), held.recv())
                .await
                .expect("a stalled socket")
                .expect("its handle"),
        );
    }

    // None of that may hold a worker: a new connection is served at once.
    let mut next = timeout(
        Duration::from_secs(1),
        tokio::net::TcpStream::connect(address),
    )
    .await
    .expect("a new connection is accepted")
    .expect("connected");
    next.write_all(&masked_frame(0x1, b"next"))
        .await
        .expect("the message is written");
    let (opcode, payload) = timeout(Duration::from_secs(1), server_frame(&mut next))
        .await
        .expect("the echo arrives");
    assert_eq!((opcode, payload.as_slice()), (0x2, b"next".as_slice()));

    // The credit returning late still ends each stalled socket at once.
    for handle in &handles {
        handle.delivered(b"hello".len() as u64 + MESSAGE_OVERHEAD);
    }
    for client in &mut clients {
        let (opcode, payload) = timeout(Duration::from_secs(1), server_frame(client))
            .await
            .expect("the held socket's echo");
        assert_eq!((opcode, payload.as_slice()), (0x2, b"hello".as_slice()));
        let (opcode, payload) = timeout(Duration::from_secs(1), server_frame(client))
            .await
            .expect("its close frame");
        assert_eq!(
            (opcode, payload.as_slice()),
            (0x8, [0x03, 0xea].as_slice()),
            "the close follows the reply once the credit is back"
        );
    }
}
