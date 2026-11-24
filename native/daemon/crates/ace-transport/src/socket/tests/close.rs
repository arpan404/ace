// SPDX-License-Identifier: Apache-2.0
//! The close and error paths: a local close, a peer's close, the close timeout,
//! `terminate`, the owner going away, and the code each violation reports.

use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::{masked_text, next, pair, read};
use crate::socket::{
    CLOSE_TIMEOUT, CLOSED, CLOSING, CloseError, MAX_MESSAGE_BYTES, OPEN, SendResult, SocketEvent,
    open,
};

/// One masked client frame, as a client sends it.
fn masked(opcode: u8, payload: &[u8]) -> Vec<u8> {
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

#[tokio::test]
async fn a_close_is_idempotent_and_a_send_after_it_is_refused() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    handle
        .close(Some(4008), "Idle timeout".to_owned())
        .expect("a valid close");
    assert_eq!(handle.ready_state(), CLOSING);
    handle
        .close(Some(1000), "a second close keeps the first code".to_owned())
        .expect("a later close is ignored, not refused");

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
        handle.send(Bytes::from_static(b"late"), false, true, 9),
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

#[tokio::test(start_paused = true)]
async fn a_local_close_the_peer_never_answers_ends_with_1006() {
    // The client never reads, so it never answers the close frame: only `ws`'s
    // close timeout can end the socket, and the test advances the clock to it.
    let (server, _client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = open(Box::new(server), None, None);
    handle
        .close(Some(1001), "bye".to_owned())
        .expect("a valid close");
    tokio::time::advance(CLOSE_TIMEOUT).await;

    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close 1006 after the close timeout, got {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn a_queued_write_does_not_postpone_the_close_deadline() {
    // A four-byte duplex: the write cannot flush, so it is still in flight when
    // `close()` starts the deadline. The deadline still ends the socket at 30 s,
    // and the abandoned send is failed before the one `Close`.
    let (handle, mut events, _client) = pair(4).await;
    assert_eq!(
        handle.send(Bytes::from(vec![0u8; 4096]), true, true, 1),
        SendResult::Queued
    );
    handle
        .close(Some(1001), "bye".to_owned())
        .expect("a valid close");
    tokio::time::advance(CLOSE_TIMEOUT).await;

    match next(&mut events).await {
        SocketEvent::Sent { id, error } => {
            assert_eq!(id, 1);
            assert!(error.is_some(), "the abandoned send is reported failed");
        }
        other => panic!("expected the owed Sent first, got {other:?}"),
    }
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close 1006 at the deadline, got {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn close_from_a_thread_without_a_runtime_ends_the_socket() {
    // napi calls arrive on the JS thread, which has no runtime of its own: the
    // socket hands `close` its own handle, so the timer still starts.
    let (handle, mut events, _client) = pair(1 << 16).await;
    let closer = handle.clone();
    std::thread::spawn(move || {
        closer
            .close(Some(1001), "bye".to_owned())
            .expect("a valid close")
    })
    .join()
    .expect("the closing thread ends without panicking");
    tokio::time::advance(CLOSE_TIMEOUT).await;

    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close 1006 from the deadline, got {other:?}"),
    }
}

#[tokio::test]
async fn dropping_the_handle_ends_the_socket() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    drop(handle);

    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close 1006 after the owner went away, got {other:?}"),
    }
    let outcome = tokio::time::timeout(Duration::from_secs(2), client.next())
        .await
        .expect("the connection ends");
    assert!(
        outcome.is_none() || outcome.is_some_and(|frame| frame.is_err()),
        "the stream is closed, not left open"
    );
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
async fn an_oversized_message_sends_1009_and_reports_1006() {
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
        SocketEvent::Close { code, .. } => {
            assert_eq!(
                code, 1006,
                "no peer close was received, so the socket ends 1006"
            );
        }
        other => panic!("expected Close after the error, got {other:?}"),
    }
    match read(&mut client).await {
        Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 1009),
        other => panic!("expected the close frame 1009, got {other:?}"),
    }
}

#[tokio::test]
async fn invalid_utf8_in_a_text_frame_closes_with_1007() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (_handle, mut events) = open(Box::new(server), None, None);
    client
        .write_all(&masked_text(&[0xff, 0xfe]))
        .await
        .expect("the frame is written");

    match next(&mut events).await {
        SocketEvent::Error { code, .. } => assert_eq!(code, "protocol"),
        other => panic!("expected an error, got {other:?}"),
    }
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected Close 1006, got {other:?}"),
    }
    let mut answer = [0u8; 4];
    let _ = tokio::time::timeout(Duration::from_secs(2), client.read_exact(&mut answer)).await;
    assert_eq!(
        answer,
        [0x88, 0x02, 0x03, 0xef],
        "the close frame carries 1007"
    );
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
        handle.send(Bytes::from_static(b"late"), false, true, 3),
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
        handle.send(Bytes::from(vec![9u8; 4096]), true, true, 11),
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

#[tokio::test]
async fn a_local_close_refuses_an_invalid_code_or_a_reason_over_123_bytes() {
    let (handle, mut events, mut client) = pair(1 << 16).await;
    for code in [0u16, 999, 1004, 1005, 1006, 1015, 2999, 5000, 65535] {
        assert_eq!(
            handle.close(Some(code), String::new()),
            Err(CloseError::InvalidCode),
            "{code} is not a valid status code"
        );
    }
    assert_eq!(
        handle.ready_state(),
        OPEN,
        "a refused close changes nothing"
    );
    assert!(events.try_recv().is_err(), "a refused close emits nothing");

    assert_eq!(
        handle.close(Some(1000), "x".repeat(124)),
        Err(CloseError::ReasonTooLong),
        "ws refuses one byte over 123"
    );
    assert_eq!(handle.ready_state(), OPEN);

    handle
        .close(Some(1000), "x".repeat(123))
        .expect("123 bytes is the largest reason ws sends");
    match read(&mut client).await {
        Message::Close(Some(frame)) => {
            assert_eq!(u16::from(frame.code), 1000);
            assert_eq!(frame.reason.len(), 123);
        }
        other => panic!("expected the close, got {other:?}"),
    }
}

#[tokio::test]
async fn a_peer_close_mid_write_finishes_that_frame_before_answering() {
    // One byte of duplex: the 4 KiB frame cannot flush, so a peer close arrives
    // while the writer is mid-frame. The frame must finish intact and only then
    // the close go out; appending the close to the pending buffer would corrupt
    // the stream.
    let (server, mut client) = tokio::io::duplex(1);
    let (handle, _events) = open(Box::new(server), None, None);
    assert_eq!(
        handle.send(Bytes::from(vec![7u8; 4096]), true, true, 1),
        SendResult::Queued
    );
    tokio::time::sleep(Duration::from_millis(50)).await;

    client
        .write_all(&masked(0x8, &[0x03, 0xe8]))
        .await
        .expect("the peer closes");
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut bytes))
        .await
        .expect("the socket ends")
        .expect("the bytes are read");

    assert_eq!(&bytes[..4], &[0x82, 126, 0x10, 0x00]);
    assert!(
        bytes[4..4100].iter().all(|byte| *byte == 7),
        "the payload is intact"
    );
    assert_eq!(
        &bytes[4100..],
        &[0x88, 0x02, 0x03, 0xe8],
        "the close answers 1000"
    );
}

#[tokio::test]
async fn a_peer_reply_after_the_local_close_writes_no_second_close() {
    let (server, mut client) = tokio::io::duplex(1 << 16);
    let (handle, mut events) = open(Box::new(server), None, None);
    handle
        .close(Some(4008), "bye".to_owned())
        .expect("a valid close");

    // The local close reaches the wire first: 0x88, length 5, 4008, "bye".
    let mut local = [0u8; 7];
    client
        .read_exact(&mut local)
        .await
        .expect("the local close arrives");
    assert_eq!(local, [0x88, 0x05, 0x0f, 0xa8, b'b', b'y', b'e']);

    client
        .write_all(&masked(0x8, &[0x03, 0xe8]))
        .await
        .expect("the peer answers with 1000");
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1000, "the peer's code is reported"),
        other => panic!("expected Close, got {other:?}"),
    }

    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut rest))
        .await
        .expect("the connection ends")
        .expect("the end is read");
    assert!(
        rest.is_empty(),
        "no second close frame follows the peer's answer, got {rest:?}"
    );
}

#[tokio::test]
async fn a_peer_close_before_the_local_close_flushes_keeps_the_local_code() {
    // A one-byte duplex keeps the data frame in flight, so `close()` queues
    // behind it. The peer's close must not replace the local code ws would send.
    let (server, mut client) = tokio::io::duplex(1);
    let (handle, _events) = open(Box::new(server), None, None);
    assert_eq!(
        handle.send(Bytes::from(vec![7u8; 4096]), true, true, 1),
        SendResult::Queued
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    handle
        .close(Some(4008), "local".to_owned())
        .expect("a valid close");

    client
        .write_all(&masked(0x8, &[0x03, 0xe8]))
        .await
        .expect("the peer closes");
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut bytes))
        .await
        .expect("the socket ends")
        .expect("the bytes are read");

    assert_eq!(&bytes[..4], &[0x82, 126, 0x10, 0x00]);
    assert!(bytes[4..4100].iter().all(|byte| *byte == 7));
    assert_eq!(
        &bytes[4100..],
        &[0x88, 0x07, 0x0f, 0xa8, b'l', b'o', b'c', b'a', b'l'],
        "the local 4008 close was already queued and is what goes out"
    );
}

#[tokio::test]
async fn a_close_on_a_closing_or_closed_socket_returns_before_validating() {
    let (closing, _events, _client) = pair(1 << 16).await;
    closing
        .close(Some(4008), "bye".to_owned())
        .expect("a valid close");
    assert_eq!(
        closing.close(Some(1005), "x".repeat(200)),
        Ok(()),
        "ws returns for CLOSING before the sender validates"
    );
    assert_eq!(closing.ready_state(), CLOSING);

    let (closed, _events, _client) = pair(1 << 16).await;
    closed.terminate();
    assert_eq!(
        closed.close(Some(1005), "x".repeat(200)),
        Ok(()),
        "ws returns for CLOSED before the sender validates"
    );
    assert_eq!(closed.ready_state(), CLOSED);
}

#[tokio::test]
async fn a_peer_close_interrupting_a_local_close_does_not_send_it_twice() {
    // A one-byte duplex leaves the local close mid-frame. The peer's close then
    // arrives: teardown must finish that frame and stop, not write it again.
    let (server, mut client) = tokio::io::duplex(1);
    let (handle, mut events) = open(Box::new(server), None, None);
    handle
        .close(Some(4008), "bye".to_owned())
        .expect("a valid close");

    // One byte of the close is on the wire, so the frame is in flight.
    let mut first = [0u8; 1];
    client
        .read_exact(&mut first)
        .await
        .expect("the close begins");
    assert_eq!(first[0], 0x88);

    client
        .write_all(&masked(0x8, &[0x03, 0xe8]))
        .await
        .expect("the peer closes");
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut rest))
        .await
        .expect("the socket ends")
        .expect("the bytes are read");

    let mut whole = vec![first[0]];
    whole.extend_from_slice(&rest);
    assert_eq!(
        whole,
        vec![0x88, 0x05, 0x0f, 0xa8, b'b', b'y', b'e'],
        "one local close, completed, never a second"
    );
    match next(&mut events).await {
        SocketEvent::Close { code, .. } => assert_eq!(code, 1000, "the peer's code is reported"),
        other => panic!("expected Close, got {other:?}"),
    }
}
