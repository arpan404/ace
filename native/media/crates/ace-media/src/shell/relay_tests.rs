// SPDX-License-Identifier: Apache-2.0
//! Relay stream closes against a real local socket. Each test needs the relay to observe the
//! stream's end (EOF or a reset) and fails on a timeout. A forced close lets nothing more reach
//! the relay once its handle has ended (the moment `revoked` may go out); a graceful one delivers
//! every byte written and the WebSocket close; and a close finds the socket wherever its dial left
//! it.
use super::relay::RelayEvent;
use super::relay_sockets::RelaySockets;
use crate::engine::relay::{CloseMode, FRAME_CAPACITY, Pool};
use media_wire::control::Id;
use std::os::fd::AsRawFd;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

const END: Duration = Duration::from_secs(3);

/// Bytes the kernel has received for `socket` and not yet handed to a read.
#[allow(unsafe_code)]
fn unread(socket: &TcpStream) -> usize {
    let mut n: libc::c_int = 0;
    // SAFETY: FIONREAD writes one c_int.
    let ok = unsafe { libc::ioctl(socket.as_raw_fd(), libc::FIONREAD, &mut n) } == 0;
    assert!(ok, "FIONREAD");
    usize::try_from(n).unwrap_or(0)
}

/// A relay that answers the upgrade, then does what the test says.
async fn relay(listener: TcpListener) -> TcpStream {
    let (mut socket, _) = listener.accept().await.unwrap_or_else(|_| panic!("accept"));
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        socket
            .read_exact(&mut byte)
            .await
            .unwrap_or_else(|_| panic!("upgrade"));
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head);
    let key = text
        .lines()
        .find_map(|line| line.strip_prefix("Sec-WebSocket-Key: "))
        .unwrap_or_else(|| panic!("no key"));
    let accept = tungstenite::handshake::derive_accept_key(key.trim().as_bytes());
    let answer = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    socket
        .write_all(answer.as_bytes())
        .await
        .unwrap_or_else(|_| panic!("answer"));
    socket
}

/// How the relay saw the stream end.
#[derive(Debug, PartialEq)]
enum Ended {
    Eof,
    Reset,
}

/// Reads everything the relay is sent until the stream ends, which it must within `END`. Once
/// nothing is left to read the relay writes a byte, as its keepalive ping would: a socket that
/// is gone answers that with a reset. Returns what was read and how it ended.
async fn read_to_end(socket: &mut TcpStream) -> (Vec<u8>, Ended) {
    let mut received = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let deadline = tokio::time::Instant::now() + END;
    let mut poked = false;
    loop {
        if !poked && unread(socket) == 0 {
            poked = socket.try_write(&[0x89, 0]).is_ok();
        }
        let step = tokio::time::timeout(Duration::from_millis(50), socket.read(&mut buffer)).await;
        match step {
            Ok(Ok(0)) => return (received, Ended::Eof),
            Ok(Err(_)) => return (received, Ended::Reset),
            Ok(Ok(n)) => received.extend_from_slice(&buffer[..n]),
            Err(_) => assert!(
                tokio::time::Instant::now() < deadline,
                "the relay never saw the stream end"
            ),
        }
    }
}

async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|_| panic!("bind"));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    (listener, format!("ws://127.0.0.1:{port}/join?ticket=t"))
}

fn frame(pool: &Pool, len: usize) -> Vec<u8> {
    let mut frame = pool.take();
    frame.resize(len, 7);
    frame
}

#[tokio::test]
async fn after_a_forced_close_nothing_more_reaches_the_relay() {
    let (listener, url) = listen().await;
    let accepted = tokio::spawn(relay(listener));
    let (events, mut rx) = mpsc::channel(16);
    let pool = Pool::default();
    let mut sockets = RelaySockets::new(events, pool.clone());
    sockets.dial("st".into(), url);
    assert!(matches!(rx.recv().await, Some(RelayEvent::Dialed { .. })));
    // The relay reads nothing: far more than the kernel buffers hold waits in the writer.
    let mut relay = accepted.await.unwrap_or_else(|_| panic!("relay"));
    let mut queued = 0;
    for _ in 0..200 {
        let next = frame(&pool, FRAME_CAPACITY - 16);
        queued += next.len();
        assert!(sockets.send("st", next));
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    if let Some(close) = sockets.close("st", CloseMode::Forced) {
        let _ = close.await;
    }
    // The moment a `revoked` may go out: measured at once.
    let at_answer = unread(&relay);
    assert!(at_answer < queued, "the writer still had data queued");
    let (received, ended) = read_to_end(&mut relay).await;
    assert!(
        received.len() <= at_answer,
        "{} bytes reached the relay after the answer",
        received.len() - at_answer
    );
    assert_eq!(ended, Ended::Reset);
}

#[tokio::test]
async fn a_close_finds_a_socket_whose_dial_is_still_waiting_to_hand_it_over() {
    let (listener, url) = listen().await;
    let accepted = tokio::spawn(relay(listener));
    // The event queue is full: the dial, with its socket's tasks running, waits to hand it over.
    let (events, mut rx) = mpsc::channel(1);
    let Ok(stuck) = Id::new("other".to_owned()) else {
        panic!("id")
    };
    assert!(
        events
            .try_send(RelayEvent::Ended {
                stream: stuck,
                reason: "x"
            })
            .is_ok()
    );
    let pool = Pool::default();
    let mut sockets = RelaySockets::new(events, pool.clone());
    sockets.dial("st".into(), url);
    let mut relay = accepted.await.unwrap_or_else(|_| panic!("relay"));
    // The socket is live: a frame reaches the relay.
    let deadline = tokio::time::Instant::now() + END;
    while !sockets.send("st", frame(&pool, 100)) {
        assert!(tokio::time::Instant::now() < deadline, "never dialed");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // A 100-byte frame: a 2-byte header and the 4-byte mask ahead of it.
    let mut first = [0u8; 106];
    let read = tokio::time::timeout(END, relay.read_exact(&mut first)).await;
    assert!(matches!(read, Ok(Ok(_))), "the first frame never arrived");
    // Closed before the main loop ever took it.
    if let Some(close) = sockets.close("st", CloseMode::Forced) {
        let _ = close.await;
    }
    let (received, ended) = read_to_end(&mut relay).await;
    assert!(received.is_empty());
    assert_eq!(ended, Ended::Reset);
    // The queued event is all that is left; the dial's own never came.
    assert!(matches!(rx.recv().await, Some(RelayEvent::Ended { .. })));
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn a_graceful_close_delivers_every_byte_written_and_the_websocket_close() {
    let (listener, url) = listen().await;
    let accepted = tokio::spawn(relay(listener));
    let (events, mut rx) = mpsc::channel(16);
    let pool = Pool::default();
    let mut sockets = RelaySockets::new(events, pool.clone());
    sockets.dial("st".into(), url);
    assert!(matches!(rx.recv().await, Some(RelayEvent::Dialed { .. })));
    let mut relay = accepted.await.unwrap_or_else(|_| panic!("relay"));
    let mut wire = 0;
    for _ in 0..10 {
        assert!(sockets.send("st", frame(&pool, 16_000)));
        // Header: 2 bytes, a 16-bit length, the 4-byte mask.
        wire += 8 + 16_000;
    }
    if let Some(close) = sockets.close("st", CloseMode::Graceful) {
        let _ = close.await;
    }
    // The relay reads only now, so the last frames (a refusal the daemon sent just before its
    // close, say) and the close were still in the kernel when the socket closed: a reset would
    // have dropped them.
    let mut received = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let ended = loop {
        match tokio::time::timeout(END, relay.read(&mut buffer)).await {
            Ok(Ok(0)) => break Ended::Eof,
            Ok(Err(_)) => break Ended::Reset,
            Ok(Ok(n)) => received.extend_from_slice(&buffer[..n]),
            Err(_) => panic!("the relay never saw the stream end"),
        }
    };
    assert_eq!(ended, Ended::Eof, "a graceful close never resets");
    // Every frame, then the masked, empty close frame.
    assert_eq!(received.len(), wire + 6);
    assert_eq!(&received[wire..wire + 2], &[0x88, 0x80]);
}
