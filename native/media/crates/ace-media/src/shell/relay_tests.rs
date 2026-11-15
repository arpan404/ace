// SPDX-License-Identifier: Apache-2.0
//! Relay stream closes against a real local socket. Each test needs the relay to observe the
//! stream's end (EOF or a reset) and fails on a timeout. A forced close lets nothing more reach
//! the relay once its handle has ended (the moment `revoked` may go out), and a close finds the
//! socket wherever its dial left it. Closes in progress are `relay_close_tests.rs`.
use super::relay::RelayEvent;
use super::relay_sockets::RelaySockets;
use crate::engine::relay::{CloseMode, FRAME_CAPACITY, Pool};
use media_wire::control::Id;
use std::os::fd::AsRawFd;
use std::sync::Weak;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

pub(super) const END: Duration = Duration::from_secs(3);

/// Bytes the kernel has received for `socket` and not yet handed to a read.
#[allow(unsafe_code)]
pub(super) fn unread(socket: &TcpStream) -> usize {
    let mut n: libc::c_int = 0;
    // SAFETY: FIONREAD writes one c_int.
    let ok = unsafe { libc::ioctl(socket.as_raw_fd(), libc::FIONREAD, &mut n) } == 0;
    assert!(ok, "FIONREAD");
    usize::try_from(n).unwrap_or(0)
}

/// A relay that answers the upgrade, then does what the test says.
pub(super) async fn relay(listener: TcpListener) -> TcpStream {
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
pub(super) enum Ended {
    Eof,
    Reset,
}

/// Reads everything the relay is sent until the stream ends, which it must within `END`.
///
/// Refused while any task that owned the socket is alive (`alive` has holders): only then can the
/// probe below not cause the end it is checking for. Once nothing is left to read the relay
/// writes a byte, as its keepalive ping would; a socket that is gone answers it with a reset.
pub(super) async fn read_to_end(
    socket: &mut TcpStream,
    alive: &Weak<()>,
) -> Result<(Vec<u8>, Ended), &'static str> {
    if alive.strong_count() > 0 {
        return Err("a task still owns the socket");
    }
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
            Ok(Ok(0)) => return Ok((received, Ended::Eof)),
            Ok(Err(_)) => return Ok((received, Ended::Reset)),
            Ok(Ok(n)) => received.extend_from_slice(&buffer[..n]),
            Err(_) => assert!(
                tokio::time::Instant::now() < deadline,
                "the relay never saw the stream end"
            ),
        }
    }
}

pub(super) async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|_| panic!("bind"));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    (listener, format!("ws://127.0.0.1:{port}/join?ticket=t"))
}

pub(super) fn frame(pool: &Pool, len: usize) -> Vec<u8> {
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
    let alive = sockets.alive("st").unwrap_or_default();
    if let Some(close) = sockets.close("st", CloseMode::Forced) {
        let _ = close.await;
    }
    // The moment a `revoked` may go out: measured at once.
    let at_answer = unread(&relay);
    assert!(at_answer < queued, "the writer still had data queued");
    let (received, ended) = read_to_end(&mut relay, &alive)
        .await
        .unwrap_or_else(|why| panic!("{why}"));
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
    let alive = sockets.alive("st").unwrap_or_default();
    if let Some(close) = sockets.close("st", CloseMode::Forced) {
        let _ = close.await;
    }
    let (received, ended) = read_to_end(&mut relay, &alive)
        .await
        .unwrap_or_else(|why| panic!("{why}"));
    assert!(received.is_empty());
    assert_eq!(ended, Ended::Reset);
    // The queued event is all that is left; the dial's own never came.
    assert!(matches!(rx.recv().await, Some(RelayEvent::Ended { .. })));
    assert!(rx.try_recv().is_err());
}
