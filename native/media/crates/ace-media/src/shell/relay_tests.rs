// SPDX-License-Identifier: Apache-2.0
//! A relay stream's close, against a real local socket: once the stream's tasks have ended (the
//! moment a `revoked` may go out), not one more byte reaches the relay.
use super::relay::{RelayEvent, RelaySockets};
use crate::engine::relay::{FRAME_CAPACITY, Pool};
use std::os::fd::AsRawFd;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// Bytes the kernel has received for `socket` and not yet handed to a read.
#[allow(unsafe_code)]
fn unread(socket: &TcpStream) -> usize {
    let mut n: libc::c_int = 0;
    // SAFETY: FIONREAD writes one c_int.
    let ok = unsafe { libc::ioctl(socket.as_raw_fd(), libc::FIONREAD, &mut n) } == 0;
    assert!(ok, "FIONREAD");
    usize::try_from(n).unwrap_or(0)
}

/// A relay that answers the upgrade and then reads nothing: ace-media's writes back up.
async fn stalled_relay(listener: TcpListener) -> TcpStream {
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

#[tokio::test]
async fn once_a_closed_streams_tasks_have_ended_nothing_more_reaches_the_relay() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|_| panic!("bind"));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let relay = tokio::spawn(stalled_relay(listener));
    let (events, mut rx) = mpsc::channel(16);
    let pool = Pool::default();
    let mut sockets = RelaySockets::new(events, pool.clone());
    sockets.dial("st".into(), format!("ws://127.0.0.1:{port}/join?ticket=t"));
    let Some(RelayEvent::Dialed { stream, socket }) = rx.recv().await else {
        panic!("not dialed")
    };
    sockets.adopt(&stream, socket);
    let mut relay = relay.await.unwrap_or_else(|_| panic!("relay"));

    // Far more than the kernel buffers hold, so the writer has data waiting when it is closed.
    let mut queued = 0;
    for _ in 0..200 {
        let mut frame = pool.take();
        frame.resize(FRAME_CAPACITY - 16, 7);
        queued += frame.len();
        assert!(sockets.send("st", frame));
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The close, and the wait the priority gate does before answering.
    for task in sockets.close("st") {
        let _ = task.await;
    }
    // Loopback delivers anything already sent at once.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let at_answer = unread(&relay);
    assert!(at_answer < queued, "the writer still had data queued");

    // The relay now reads everything it is sent, until the stream ends or goes quiet: nothing
    // beyond what had arrived by the answer. (Before the fix the writer's queued frames, and the
    // kernel's, kept coming once the relay read again.)
    let mut received = 0;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match tokio::time::timeout(Duration::from_millis(300), relay.read(&mut buffer)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(n)) => received += n,
        }
    }
    assert!(
        received <= at_answer,
        "{} bytes reached the relay after the answer",
        received - at_answer
    );
}
