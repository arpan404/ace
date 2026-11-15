// SPDX-License-Identifier: Apache-2.0
//! Relay closes already in progress, against a real local socket: a forced close escalates a
//! graceful one and answers only once the socket is gone; a second close joins the first; a
//! graceful close that runs out of time resets; shutdown waits for closes; and the end-of-stream
//! check refuses a socket whose tasks still run.
use super::relay::RelayEvent;
use super::relay_sockets::RelaySockets;
use super::relay_tests::{END, Ended, frame, listen, read_to_end, relay, unread};
use crate::engine::relay::{CloseMode, FRAME_CAPACITY, Pool};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpSocket};
use tokio::sync::mpsc;

/// A dialed stream on a relay that reads nothing (yet).
async fn stalled(
    listener: TcpListener,
    url: String,
) -> (RelaySockets, tokio::net::TcpStream, Pool) {
    let accepted = tokio::spawn(relay(listener));
    let (events, mut rx) = mpsc::channel(16);
    let pool = Pool::default();
    let mut sockets = RelaySockets::new(events, pool.clone());
    sockets.dial("st".into(), url);
    assert!(matches!(rx.recv().await, Some(RelayEvent::Dialed { .. })));
    // Keep the rest of the stream's events flowing nowhere.
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let relay = accepted.await.unwrap_or_else(|_| panic!("relay"));
    (sockets, relay, pool)
}

/// A listener whose accepted sockets take little at a time: what a stream sends waits in the
/// sender's kernel buffer, not the relay's.
async fn small_window() -> (TcpListener, String) {
    let socket = TcpSocket::new_v4().unwrap_or_else(|_| panic!("socket"));
    let _ = socket.set_recv_buffer_size(4096);
    socket
        .bind("127.0.0.1:0".parse().unwrap_or_else(|_| panic!("address")))
        .unwrap_or_else(|_| panic!("bind"));
    let listener = socket.listen(8).unwrap_or_else(|_| panic!("listen"));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    (listener, format!("ws://127.0.0.1:{port}/join?ticket=t"))
}

#[tokio::test]
async fn a_revocation_during_a_graceful_close_forces_it_and_nothing_leaves_after_its_answer() {
    let (listener, url) = listen().await;
    let (mut sockets, mut relay, pool) = stalled(listener, url).await;
    for _ in 0..200 {
        assert!(sockets.send("st", frame(&pool, FRAME_CAPACITY - 16)));
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let alive = sockets.alive("st").unwrap_or_default();
    // The daemon's close starts, and cannot finish: the relay reads nothing.
    let graceful = sockets.close("st", CloseMode::Graceful);
    // The revocation: it joins that close, forces it, and is answered once the socket is gone.
    let started = Instant::now();
    if let Some(revoked) = sockets.close("st", CloseMode::Forced) {
        let _ = revoked.await;
    }
    assert!(
        started.elapsed() < Duration::from_millis(80),
        "the revocation waited out the graceful close"
    );
    let at_answer = unread(&relay);
    let (received, ended) = read_to_end(&mut relay, &alive)
        .await
        .unwrap_or_else(|why| panic!("{why}"));
    assert!(
        received.len() <= at_answer,
        "{} bytes reached the relay after the answer",
        received.len() - at_answer
    );
    assert_eq!(ended, Ended::Reset);
    if let Some(graceful) = graceful {
        let _ = graceful.await;
    }
}

#[tokio::test]
async fn a_second_close_is_answered_only_when_the_first_has_finished() {
    let (listener, url) = listen().await;
    let (mut sockets, _relay, pool) = stalled(listener, url).await;
    for _ in 0..200 {
        assert!(sockets.send("st", frame(&pool, FRAME_CAPACITY - 16)));
    }
    let alive = sockets.alive("st").unwrap_or_default();
    let first = sockets.close("st", CloseMode::Graceful);
    let Some(mut second) = sockets.close("st", CloseMode::Graceful) else {
        panic!("a close in progress was not found")
    };
    let early = tokio::time::timeout(Duration::from_millis(30), &mut second).await;
    assert!(
        early.is_err(),
        "the second close was answered while the first ran"
    );
    let _ = second.await;
    assert_eq!(
        alive.strong_count(),
        0,
        "answered before the socket was gone"
    );
    if let Some(first) = first {
        let _ = first.await;
    }
}

#[tokio::test]
async fn a_graceful_close_that_runs_out_of_time_resets_what_the_kernel_still_holds() {
    let (listener, url) = small_window().await;
    let (mut sockets, mut relay, pool) = stalled(listener, url).await;
    // More than the relay's small window, less than our send buffer: the writer finishes (close
    // frame, linger off, FIN), with most of it still waiting in our kernel for a slow relay.
    for _ in 0..4 {
        assert!(sockets.send("st", frame(&pool, 16_000)));
    }
    let alive = sockets.alive("st").unwrap_or_default();
    // The relay never closes its side, so the close runs out of time and must reset.
    if let Some(close) = sockets.close("st", CloseMode::Graceful) {
        let _ = close.await;
    }
    let at_answer = unread(&relay);
    let (received, ended) = read_to_end(&mut relay, &alive)
        .await
        .unwrap_or_else(|why| panic!("{why}"));
    assert!(
        received.len() <= at_answer,
        "{} bytes reached the relay after the close had finished",
        received.len() - at_answer
    );
    assert_eq!(ended, Ended::Reset);
}

#[tokio::test]
async fn shutdown_waits_for_every_close_in_progress() {
    let (listener, url) = listen().await;
    let (mut sockets, _relay, pool) = stalled(listener, url).await;
    for _ in 0..200 {
        assert!(sockets.send("st", frame(&pool, FRAME_CAPACITY - 16)));
    }
    let alive = sockets.alive("st").unwrap_or_default();
    let _close = sockets.close("st", CloseMode::Graceful);
    tokio::time::timeout(END, sockets.settled())
        .await
        .unwrap_or_else(|_| panic!("closes never settled"));
    assert_eq!(alive.strong_count(), 0, "settled while a socket task ran");
}

#[tokio::test]
async fn the_end_check_refuses_a_socket_whose_reader_still_runs() {
    let (listener, url) = listen().await;
    let (sockets, mut relay, _pool) = stalled(listener, url).await;
    let alive = sockets.alive("st").unwrap_or_default();
    // A close that finished too early: the writer is gone, the reader isn't. A probe would make
    // that reader fail its pong and drop the socket, passing for a close that never happened.
    sockets.abort_writer("st");
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(read_to_end(&mut relay, &alive).await.is_err());
}

#[tokio::test]
async fn a_graceful_close_delivers_every_byte_and_the_websocket_close_to_a_slow_relay() {
    let (listener, url) = small_window().await;
    let (mut sockets, mut relay, pool) = stalled(listener, url).await;
    // A slow relay, reading a little at a time, that closes its side once it sees our end.
    let reading = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut received = Vec::new();
        let mut buffer = vec![0u8; 4096];
        loop {
            match tokio::time::timeout(END, relay.read(&mut buffer)).await {
                Ok(Ok(0)) => return (received, Ended::Eof),
                Ok(Err(_)) => return (received, Ended::Reset),
                Ok(Ok(n)) => received.extend_from_slice(&buffer[..n]),
                Err(_) => panic!("the relay never saw the stream end"),
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
    // The last frame stands for a refusal the daemon sent just before its close: most of it is
    // still in our kernel, behind the relay's small window, when the close starts.
    let mut wire = 0;
    for _ in 0..4 {
        assert!(sockets.send("st", frame(&pool, 4_000)));
        // Header: 2 bytes, a 16-bit length, the 4-byte mask.
        wire += 8 + 4_000;
    }
    let alive = sockets.alive("st").unwrap_or_default();
    if let Some(close) = sockets.close("st", CloseMode::Graceful) {
        let _ = close.await;
    }
    assert_eq!(alive.strong_count(), 0, "a task outlived the close");
    let (received, ended) = reading.await.unwrap_or_else(|_| panic!("reader"));
    assert_eq!(
        ended,
        Ended::Eof,
        "a graceful close that finished never resets"
    );
    // Every frame, then the masked, empty close frame.
    assert_eq!(received.len(), wire + 6);
    assert_eq!(&received[wire..wire + 2], &[0x88, 0x80]);
}
