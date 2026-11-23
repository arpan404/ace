// SPDX-License-Identifier: Apache-2.0
//! The listener's end-to-end tests: a real loopback listener in front of a real
//! internal server, driven by raw clients, so the hop's bytes are what a client
//! and the daemon's own HTTP server actually see.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http::{Request, Response};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use crate::driver::RefuseUpgrades;
use crate::head;
use crate::hop::HopSecret;
use crate::proxy::ProxyTarget;

use super::LoopbackListener;

/// One request the internal server received.
struct Seen {
    target: String,
    headers: Vec<(String, Vec<u8>)>,
    body: Vec<u8>,
}

/// The daemon's own HTTP server, standing in for the TypeScript handlers: it
/// records what it received and answers `ok`.
async fn internal_server() -> (SocketAddr, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback listener");
    let addr = listener.local_addr().expect("its address");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let record = Arc::clone(&record);
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let record = Arc::clone(&record);
                    async move {
                        let target = req.uri().to_string();
                        let headers = req
                            .headers()
                            .iter()
                            .map(|(name, value)| {
                                (name.as_str().to_owned(), value.as_bytes().to_vec())
                            })
                            .collect();
                        let body = req
                            .into_body()
                            .collect()
                            .await
                            .expect("the body arrives")
                            .to_bytes()
                            .to_vec();
                        record.lock().expect("no poison").push(Seen {
                            target,
                            headers,
                            body,
                        });
                        Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    (addr, seen)
}

/// A raw internal server: it hands back the request head it read, byte for
/// byte, and answers an empty 200. The only way to see the request line the hop
/// actually wrote, since hyper's `Uri` normalizes it on the way back in.
async fn raw_internal_server() -> (SocketAddr, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback listener");
    let addr = listener.local_addr().expect("its address");
    let (sent, received) = oneshot::channel();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let mut buf = [0u8; 4096];
        let Ok(read) = stream.read(&mut buf).await else {
            return;
        };
        let _ = sent.send(String::from_utf8_lossy(&buf[..read]).into_owned());
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
    });
    (addr, received)
}

async fn listener_with(
    upstream: SocketAddr,
    secret_hex: &str,
    max_connections: usize,
) -> LoopbackListener {
    let secret = Arc::new(HopSecret::from_hex(secret_hex).expect("a test secret"));
    let target = ProxyTarget::new(upstream, secret).expect("a loopback target");
    let addr: SocketAddr = "127.0.0.1:0".parse().expect("a test address");
    LoopbackListener::bind(addr, target, Arc::new(RefuseUpgrades), max_connections)
        .await
        .expect("the listener binds")
}

async fn listener(upstream: SocketAddr, secret_hex: &str) -> LoopbackListener {
    listener_with(upstream, secret_hex, 64).await
}

async fn client(addr: SocketAddr) -> TcpStream {
    TcpStream::connect(addr).await.expect("a loopback client")
}

/// Every byte the connection answers with, up to the moment it ends. A refused
/// head closes with the bytes already written and then a reset, as Node does
/// when the client is still sending, so the reset ends the read.
async fn answer(stream: &mut TcpStream) -> Vec<u8> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => return out,
            Ok(read) => out.extend_from_slice(&chunk[..read]),
            Err(_) => return out,
        }
    }
}

fn values(headers: &[(String, Vec<u8>)], name: &str) -> Vec<Vec<u8>> {
    headers
        .iter()
        .filter(|(field, _)| field.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
        .collect()
}

#[tokio::test]
async fn a_request_reaches_the_internal_server_with_the_hops_own_fields() {
    let (upstream, seen) = internal_server().await;
    let secret_hex = "0f".repeat(32);
    let bound = listener(upstream, &secret_hex).await;
    let bound_addr = bound.local_addr();

    let mut client = client(bound_addr).await;
    let client_port = client.local_addr().expect("the client's address").port();
    client
        .write_all(
            b"POST /a?b HTTP/1.1\r\n\
              Host: localhost\r\n\
              Connection: close\r\n\
              x-ace-hop-secret: client\r\n\
              x-ace-hop-peer-address: 10.0.0.9\r\n\
              x-ace-sha256: 00ff\r\n\
              Content-Length: 3\r\n\
              \r\n\
              hey",
        )
        .await
        .expect("the request is written");
    let response = answer(&mut client).await;
    let response = String::from_utf8_lossy(&response);
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    assert!(response.ends_with("ok"), "{response}");

    let seen = seen.lock().expect("no poison");
    assert_eq!(seen.len(), 1, "one request reached the internal server");
    let request = &seen[0];
    assert_eq!(request.target, "/a?b", "the raw target is forwarded");
    assert_eq!(request.body, b"hey", "the body is streamed through");

    let hop_secret = values(&request.headers, "x-ace-hop-secret");
    assert_eq!(hop_secret.len(), 1, "exactly one secret reaches the target");
    assert_eq!(
        hop_secret[0],
        secret_hex.as_bytes(),
        "the client's value is replaced"
    );
    assert_eq!(
        values(&request.headers, "x-ace-hop-peer-address"),
        vec![b"127.0.0.1".to_vec()],
        "the peer address is the accepted socket's, never the header's"
    );
    assert_eq!(
        values(&request.headers, "x-ace-hop-peer-port"),
        vec![client_port.to_string().into_bytes()],
        "the peer port is the client's own"
    );
    assert_eq!(
        values(&request.headers, "x-ace-hop-local-port"),
        vec![bound_addr.port().to_string().into_bytes()],
        "the local port is the one the client connected to"
    );
    assert_eq!(
        values(&request.headers, "x-ace-sha256"),
        vec![b"00ff".to_vec()],
        "every other x-ace-* field passes as sent"
    );
    assert!(
        values(&request.headers, "connection").is_empty(),
        "hop-by-hop fields are not forwarded"
    );
}

#[tokio::test]
async fn a_chunked_get_keeps_its_body() {
    let (upstream, seen) = internal_server().await;
    let bound = listener(upstream, &"ab".repeat(32)).await;

    let mut client = client(bound.local_addr()).await;
    client
        .write_all(
            b"GET /chunked HTTP/1.1\r\n\
              Host: localhost\r\n\
              Connection: close\r\n\
              Transfer-Encoding: chunked\r\n\
              \r\n\
              3\r\nhey\r\n0\r\n\r\n",
        )
        .await
        .expect("the request is written");
    let response = answer(&mut client).await;
    assert!(
        String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200 OK\r\n"),
        "the chunked GET is answered"
    );

    let seen = seen.lock().expect("no poison");
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].target, "/chunked");
    assert_eq!(
        seen[0].body, b"hey",
        "a chunked GET's payload reaches the internal server"
    );
}

#[tokio::test]
async fn an_absolute_form_target_is_forwarded_as_received() {
    let (upstream, head) = raw_internal_server().await;
    let bound = listener(upstream, &"ab".repeat(32)).await;

    let mut client = client(bound.local_addr()).await;
    client
        .write_all(
            b"GET http://internal.invalid/a?b HTTP/1.1\r\nHost: internal.invalid\r\nConnection: close\r\n\r\n",
        )
        .await
        .expect("the request is written");
    drop(answer(&mut client).await);

    let received = head.await.expect("the internal server read the head");
    assert!(
        received.starts_with("GET http://internal.invalid/a?b HTTP/1.1\r\n"),
        "{received}"
    );
}

#[tokio::test]
async fn an_upgrade_first_on_a_connection_never_reaches_the_internal_server() {
    let (upstream, seen) = internal_server().await;
    let bound = listener(upstream, &"ab".repeat(32)).await;

    let mut client = client(bound.local_addr()).await;
    client
        .write_all(
            b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        )
        .await
        .expect("the upgrade is written");

    assert!(
        answer(&mut client).await.is_empty(),
        "a refused upgrade is closed with no bytes"
    );
    assert!(
        seen.lock().expect("no poison").is_empty(),
        "an upgrade candidate first on a connection never reaches HTTP"
    );
}

#[tokio::test]
async fn an_upgrade_on_a_keep_alive_connection_gets_no_answer() {
    let (upstream, seen) = internal_server().await;
    let bound = listener(upstream, &"ab".repeat(32)).await;

    let mut client = client(bound.local_addr()).await;
    client
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .expect("the first request is written");
    let mut first = Vec::new();
    while !first.ends_with(b"ok") {
        let mut chunk = [0u8; 256];
        let read = client
            .read(&mut chunk)
            .await
            .expect("the first answer arrives");
        assert_ne!(
            read, 0,
            "the first answer arrives before the connection ends"
        );
        first.extend_from_slice(&chunk[..read]);
    }
    assert_eq!(
        seen.lock().expect("no poison").len(),
        1,
        "the ordinary request went through"
    );

    client
        .write_all(
            b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        )
        .await
        .expect("the upgrade is written");

    assert!(
        answer(&mut client).await.is_empty(),
        "a drop through hyper ends the connection with no bytes"
    );
    assert_eq!(
        seen.lock().expect("no poison").len(),
        1,
        "the upgrade candidate never reached the internal server"
    );
}

#[tokio::test]
async fn a_head_that_cannot_be_read_gets_nodes_refusal_bytes() {
    let (upstream, _) = internal_server().await;
    let bound = listener(upstream, &"ab".repeat(32)).await;

    let mut malformed = client(bound.local_addr()).await;
    malformed
        .write_all(b"this is not a request\r\n\r\n")
        .await
        .expect("the bytes are written");
    assert_eq!(answer(&mut malformed).await, head::BAD_REQUEST);

    let mut oversized = client(bound.local_addr()).await;
    let mut raw = String::from("GET / HTTP/1.1\r\n");
    while raw.len() < head::MAX_HEAD_BYTES {
        raw.push_str("x-pad: 0123456789abcdef0123456789abcdef\r\n");
    }
    oversized
        .write_all(raw.as_bytes())
        .await
        .expect("the head is written");
    assert_eq!(answer(&mut oversized).await, head::TOO_LARGE);
}

#[tokio::test]
async fn a_connection_over_the_cap_is_accepted_and_closed_at_once() {
    let (upstream, _) = internal_server().await;
    let bound = listener_with(upstream, &"ab".repeat(32), 1).await;

    // The first connection completes a request and keeps its slot.
    let mut first = client(bound.local_addr()).await;
    first
        .write_all(b"GET /one HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .expect("the first request is written");
    let mut seen_ok = Vec::new();
    while !seen_ok.ends_with(b"ok") {
        let mut chunk = [0u8; 256];
        let read = first
            .read(&mut chunk)
            .await
            .expect("the first answer arrives");
        assert_ne!(read, 0);
        seen_ok.extend_from_slice(&chunk[..read]);
    }

    let mut second = client(bound.local_addr()).await;
    let closed = tokio::time::timeout(Duration::from_secs(2), answer(&mut second))
        .await
        .expect("a connection over the cap is closed at once, not served");
    assert!(closed.is_empty(), "a connection over the cap gets no bytes");
}

#[tokio::test]
async fn close_stops_accepting_and_drops_a_connection_that_sent_nothing() {
    let (upstream, _) = internal_server().await;
    let bound = listener(upstream, &"ab".repeat(32)).await;
    let addr = bound.local_addr();

    let mut idle = client(addr).await;
    bound.close(Duration::from_secs(1)).await;

    let closed = tokio::time::timeout(Duration::from_secs(2), answer(&mut idle))
        .await
        .expect("a connection that sent nothing is dropped at the deadline");
    assert!(
        closed.is_empty(),
        "the connection that sent nothing is closed with no bytes"
    );
    assert!(
        TcpStream::connect(addr).await.is_err(),
        "the listener no longer accepts"
    );
}
