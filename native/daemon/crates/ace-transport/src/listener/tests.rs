// SPDX-License-Identifier: Apache-2.0
//! The listener's end-to-end tests: a real loopback listener in front of a real
//! internal server, driven by raw clients, so the hop's bytes are what a client
//! and the daemon's own HTTP server actually see.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http::{Request, Response, Version};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::driver::{Grace, RefuseUpgrades, UpgradeHandler, UpgradeIo, UpgradeReply};
use crate::head::{self, RequestHead};
use crate::hop::HopSecret;
use crate::peer::Peer;
use crate::prefixed::Prefixed;
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
    LoopbackListener::bind_with(addr, target, Arc::new(RefuseUpgrades), max_connections)
        .await
        .expect("the listener binds")
}

async fn listener(upstream: SocketAddr, secret_hex: &str) -> LoopbackListener {
    listener_with(upstream, secret_hex, 64).await
}

/// A listener whose upgrades go to `upgrades`.
async fn listener_with_upgrades(
    upstream: SocketAddr,
    secret_hex: &str,
    upgrades: Arc<AcceptingUpgrades>,
) -> LoopbackListener {
    let secret = Arc::new(HopSecret::from_hex(secret_hex).expect("a test secret"));
    let target = ProxyTarget::new(upstream, secret).expect("a loopback target");
    let addr: SocketAddr = "127.0.0.1:0".parse().expect("a test address");
    LoopbackListener::bind_with(addr, target, upgrades, 64)
        .await
        .expect("the listener binds")
}

/// An upgrade handler that answers like `ws` and reports what it was given: the
/// head on the raw path, the bytes that came after it, and whether hyper was
/// asked to switch at all.
#[derive(Default)]
struct AcceptingUpgrades {
    heads: Mutex<Vec<RequestHead>>,
    frames: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    hyper: AtomicUsize,
    opened: AtomicUsize,
}

impl AcceptingUpgrades {
    fn with_frames() -> (Arc<Self>, mpsc::UnboundedReceiver<Vec<u8>>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let upgrades = Arc::new(Self::default());
        *upgrades.frames.lock().expect("no poison") = Some(sender);
        (upgrades, receiver)
    }

    fn heads(&self) -> Vec<RequestHead> {
        self.heads.lock().expect("no poison").clone()
    }

    fn hyper_calls(&self) -> usize {
        self.hyper.load(Ordering::SeqCst)
    }

    fn opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }
}

impl UpgradeHandler for AcceptingUpgrades {
    fn upgrade_raw(
        &self,
        head: RequestHead,
        mut stream: Prefixed<TcpStream>,
        _peer: Peer,
        _shutdown: CancellationToken,
        _grace: Grace,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        self.heads.lock().expect("no poison").push(head);
        let frames = self.frames.lock().expect("no poison").take();
        Box::pin(async move {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
                )
                .await;
            let mut first = vec![0u8; 64];
            let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut first))
                .await
                .unwrap_or(Ok(0))
                .unwrap_or(0);
            let first = first[..read].to_vec();
            if let Some(frames) = frames {
                let _ = frames.send(first.clone());
            }
            let mut echo = b"echo:".to_vec();
            echo.extend_from_slice(&first);
            let _ = stream.write_all(&echo).await;
            let _ = stream.flush().await;
        })
    }

    /// The `101` a `Switch` answer carries. For an HTTP/1.0 request hyper writes
    /// it on an `HTTP/1.0` status line and has no socket to hand on, which is the
    /// divergence the raw path exists for.
    fn upgrade_hyper(
        &self,
        _head: RequestHead,
        _peer: Peer,
        _shutdown: CancellationToken,
        _grace: Grace,
    ) -> Pin<Box<dyn Future<Output = UpgradeReply> + Send>> {
        self.hyper.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            let mut answer = Response::new(Full::new(Bytes::new()));
            *answer.status_mut() = http::StatusCode::SWITCHING_PROTOCOLS;
            answer.headers_mut().insert(
                http::header::UPGRADE,
                http::HeaderValue::from_static("websocket"),
            );
            answer.headers_mut().insert(
                http::header::CONNECTION,
                http::HeaderValue::from_static("Upgrade"),
            );
            UpgradeReply::Switch(answer, 0)
        })
    }

    fn switched(&self, _reservation: u64, stream: Option<Box<dyn UpgradeIo>>) {
        let Some(mut stream) = stream else {
            return;
        };
        self.opened.fetch_add(1, Ordering::SeqCst);
        let frames = self.frames.lock().expect("no poison").take();
        tokio::spawn(async move {
            let mut first = vec![0u8; 64];
            let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut first))
                .await
                .unwrap_or(Ok(0))
                .unwrap_or(0);
            if let Some(frames) = frames {
                let _ = frames.send(first[..read].to_vec());
            }
            let _ = stream.write_all(b"echo:hyper").await;
            let _ = stream.flush().await;
        });
    }
}

/// Read the internal server's answer to one request: `ok` ends it.
async fn internal_answer(client: &mut TcpStream) -> Vec<u8> {
    let mut answer = Vec::new();
    while !answer.ends_with(b"ok") {
        let mut chunk = [0u8; 256];
        let read = client.read(&mut chunk).await.expect("the answer arrives");
        assert_ne!(read, 0, "the answer arrives before the connection ends");
        answer.extend_from_slice(&chunk[..read]);
    }
    answer
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
async fn a_client_that_half_closes_after_its_body_still_gets_the_answer() {
    let (upstream, seen) = internal_server().await;
    let bound = listener(upstream, &"ab".repeat(32)).await;

    let mut client = client(bound.local_addr()).await;
    client
        .write_all(b"POST /half HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nhey")
        .await
        .expect("the request is written");
    // The client shuts its write side down, as a client waiting for the answer may.
    client.shutdown().await.expect("the write side shuts down");

    let response = answer(&mut client).await;
    let response = String::from_utf8_lossy(&response);
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    assert!(
        response.ends_with("ok"),
        "a half-closed client still reads the whole answer: {response}"
    );
    assert_eq!(
        seen.lock().expect("no poison")[0].body,
        b"hey",
        "the whole body reached the internal server"
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
async fn pipelined_requests_are_answered_in_order() {
    let (upstream, seen) = internal_server().await;
    let bound = listener(upstream, &"ab".repeat(32)).await;

    // Both heads in one write: the driver's peek reads the second one with the
    // first, and the wrapper holds it until it is framed as a head, not as the
    // first one's body.
    let mut client = client(bound.local_addr()).await;
    client
        .write_all(
            b"GET /one HTTP/1.1\r\nHost: localhost\r\n\r\n\
              POST /two HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nhey",
        )
        .await
        .expect("both requests are written");

    let mut answers = Vec::new();
    while answers.windows(2).filter(|pair| *pair == b"ok").count() < 2 {
        let mut chunk = [0u8; 256];
        let read = client.read(&mut chunk).await.expect("the answers arrive");
        assert_ne!(read, 0, "both answers arrive before the connection ends");
        answers.extend_from_slice(&chunk[..read]);
    }

    let seen = seen.lock().expect("no poison");
    assert_eq!(
        seen.iter()
            .map(|request| (request.target.as_str(), request.body.as_slice()))
            .collect::<Vec<_>>(),
        vec![("/one", b"".as_slice()), ("/two", b"hey".as_slice())],
        "both requests reached HTTP, in order, with the body the second framed"
    );
}

#[tokio::test]
async fn an_http_1_0_upgrade_on_a_keep_alive_connection_takes_the_raw_path() {
    let (upstream, seen) = internal_server().await;
    let (upgrades, mut frames) = AcceptingUpgrades::with_frames();
    let bound = listener_with_upgrades(upstream, &"ab".repeat(32), upgrades.clone()).await;

    let mut client = client(bound.local_addr()).await;
    client
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .expect("the first request is written");
    internal_answer(&mut client).await;

    // The 1.0 upgrade and its first frame in one write: Node fires `upgrade` for
    // any version, and the bytes past the head are the socket's first frames.
    client
        .write_all(
            b"GET / HTTP/1.0\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nfirst-frame",
        )
        .await
        .expect("the upgrade is written");

    let response = answer(&mut client).await;
    assert!(
        response.starts_with(
            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
        ),
        "ws's own 101 and handoff, not hyper's HTTP/1.0 answer: {:?}",
        String::from_utf8_lossy(&response)
    );
    assert!(
        response.ends_with(b"echo:first-frame"),
        "the frames past the head reached the socket: {:?}",
        String::from_utf8_lossy(&response)
    );
    assert_eq!(
        frames.recv().await,
        Some(b"first-frame".to_vec()),
        "the connection went to the raw path with the bytes past its head"
    );

    assert_eq!(
        upgrades.hyper_calls(),
        0,
        "hyper never sees a head it cannot upgrade"
    );
    assert_eq!(
        upgrades.opened(),
        0,
        "no 101 was written without a socket behind it"
    );
    let heads = upgrades.heads();
    assert_eq!(heads.len(), 1);
    assert_eq!(heads[0].version, Version::HTTP_10);
    assert_eq!(
        seen.lock().expect("no poison").len(),
        1,
        "only the first request reached HTTP"
    );
}

#[tokio::test]
async fn an_upgrade_header_without_a_value_is_plain_http() {
    let (upstream, seen) = internal_server().await;
    let (upgrades, mut frames) = AcceptingUpgrades::with_frames();
    let bound = listener_with_upgrades(upstream, &"ab".repeat(32), upgrades.clone()).await;

    // First on a connection: Node's parser leaves it to the `request` event, so
    // it never becomes an upgrade candidate at all.
    let mut first = client(bound.local_addr()).await;
    first
        .write_all(
            b"GET /one HTTP/1.1\r\nHost: localhost\r\nUpgrade:\r\nConnection: Upgrade, close\r\n\r\n",
        )
        .await
        .expect("the request is written");
    assert!(
        String::from_utf8_lossy(&answer(&mut first).await).starts_with("HTTP/1.1 200 OK\r\n"),
        "an empty Upgrade is served as plain HTTP"
    );

    // And later on a keep-alive connection.
    let mut later = client(bound.local_addr()).await;
    later
        .write_all(b"GET /two HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .expect("the first request is written");
    internal_answer(&mut later).await;
    later
        .write_all(
            b"GET /three HTTP/1.1\r\nHost: localhost\r\nUpgrade:   \r\nConnection: Upgrade\r\n\r\n",
        )
        .await
        .expect("the request is written");
    assert!(
        String::from_utf8_lossy(&internal_answer(&mut later).await)
            .starts_with("HTTP/1.1 200 OK\r\n"),
        "a whitespace-only Upgrade is served as plain HTTP"
    );

    assert!(upgrades.heads().is_empty(), "no upgrade was handed on");
    assert_eq!(upgrades.hyper_calls(), 0, "hyper was never asked to switch");
    assert!(frames.try_recv().is_err(), "nothing became a socket");
    let seen = seen.lock().expect("no poison");
    assert_eq!(
        seen.iter()
            .map(|request| request.target.as_str())
            .collect::<Vec<_>>(),
        vec!["/one", "/two", "/three"],
        "every one of them reached the internal server"
    );
}

#[tokio::test]
async fn an_http_1_1_upgrade_on_a_keep_alive_connection_switches_through_hyper() {
    let (upstream, _) = internal_server().await;
    let (upgrades, mut frames) = AcceptingUpgrades::with_frames();
    let bound = listener_with_upgrades(upstream, &"ab".repeat(32), upgrades.clone()).await;

    let mut client = client(bound.local_addr()).await;
    client
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .expect("the first request is written");
    internal_answer(&mut client).await;

    // The frame in the same write as the head: hyper reads it ahead, and it is
    // the socket's once the `101` is out — never a request head.
    client
        .write_all(
            b"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nlater-frame",
        )
        .await
        .expect("the upgrade is written");

    let response = answer(&mut client).await;
    let response = String::from_utf8_lossy(&response);
    assert!(
        response.starts_with("HTTP/1.1 101 Switching Protocols\r\n"),
        "{response}"
    );
    assert!(
        response.ends_with("echo:hyper"),
        "the socket's own bytes went through: {response}"
    );
    assert_eq!(
        frames.recv().await,
        Some(b"later-frame".to_vec()),
        "the frames past the head reached the socket hyper handed on"
    );
    assert_eq!(upgrades.hyper_calls(), 1, "hyper answered the upgrade");
    assert_eq!(upgrades.opened(), 1, "hyper handed on the switched socket");
    assert!(
        upgrades.heads().is_empty(),
        "an HTTP/1.1 upgrade never takes the raw path"
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

mod deadline;
