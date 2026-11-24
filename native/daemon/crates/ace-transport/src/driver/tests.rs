// SPDX-License-Identifier: Apache-2.0
//! The connection's timers as the driver applies them (T1b.1a): a later head is
//! bounded by the listener's own deadline, never by hyper's 30 s default, and a
//! `101` that cannot be written ends the connection within `upgrade_write`
//! instead of holding a close deadline the armed upgrade has made wait.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::{Request, Response};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::driver::{self, Grace, RefuseUpgrades, UpgradeIo};
use crate::hop::HopSecret;
use crate::limits::ConnectionLimits;
use crate::peer::Peer;
use crate::proxy::ProxyTarget;
use crate::stats::Stats;
use crate::upgrade::{
    AdmissionDecision, AdmissionOutcome, SocketSink, UpgradeAdmission, UpgradeRequest,
    WebSocketUpgrades,
};

/// The daemon's own HTTP server, answering `ok` to everything.
async fn target() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback listener");
    let addr = listener.local_addr().expect("its address");
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let service = service_fn(|_req: Request<Incoming>| async {
                    Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    addr
}

fn hop_target(upstream: SocketAddr) -> ProxyTarget {
    let secret = Arc::new(HopSecret::from_hex(&"ab".repeat(32)).expect("a test secret"));
    ProxyTarget::new(upstream, secret).expect("a loopback target")
}

/// A listener's timers with the later-head deadline deliberately absent (the
/// SNI listener's shape) and a long idle window.
fn sni_limits(upgrade_write: Duration) -> ConnectionLimits {
    ConnectionLimits {
        handshake: None,
        first_head: Duration::from_secs(10),
        head: None,
        keep_alive: Duration::from_secs(60),
        trusted_keep_alive: None,
        exchange: None,
        upgrade_write,
    }
}

/// Reads one answer: it ends with the target's `ok`.
async fn answer<S: tokio::io::AsyncRead + Unpin>(client: &mut S) -> Vec<u8> {
    let mut answer = Vec::new();
    while !answer.ends_with(b"ok") {
        let mut chunk = [0u8; 256];
        let read = client.read(&mut chunk).await.expect("the answer arrives");
        assert_ne!(read, 0, "the answer arrives before the connection ends");
        answer.extend_from_slice(&chunk[..read]);
    }
    answer
}

#[tokio::test]
async fn a_later_head_after_thirty_seconds_is_still_served() {
    // hyper's own header-read default is 30 s; a listener with no later-head
    // deadline (`head: None`) must not inherit it, or the SNI listener's longer
    // trusted idle window would be cut short. Time is paused, never
    // auto-advanced: a real socket's I/O wait must not jump the clock.
    tokio::time::pause();
    let upstream = target().await;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback listener");
    let addr = listener.local_addr().expect("its address");
    let limits = sni_limits(Duration::from_secs(5));
    let serving = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("a connection");
        let peer = Peer::of(&stream).expect("the socket's addresses");
        driver::serve(
            Box::new(stream),
            peer,
            hop_target(upstream),
            Arc::new(RefuseUpgrades),
            CancellationToken::new(),
            Grace::new(),
            limits,
            None,
            Stats::new(),
        )
        .await;
    });

    let mut client = TcpStream::connect(addr).await.expect("a client");
    client
        .write_all(b"GET /one HTTP/1.1\r\nHost: ace\r\n\r\n")
        .await
        .expect("the first request");
    assert!(answer(&mut client).await.ends_with(b"ok"));

    tokio::time::advance(Duration::from_secs(35)).await;

    client
        .write_all(b"GET /two HTTP/1.1\r\nHost: ace\r\n\r\n")
        .await
        .expect("the second request");
    assert!(
        answer(&mut client).await.ends_with(b"ok"),
        "a head after 35 s idle is served: the idle timer, not hyper's 30 s, bounds it"
    );
    drop(client);
    serving.await.expect("the connection task");
}

#[tokio::test]
async fn a_stalled_101_ends_the_connection_within_the_upgrade_write_bound() {
    // An upgrade on a keep-alive connection (a first one is served on the raw
    // path instead): hyper writes the `101` into a duplex too small for it, and
    // the upgrade has already armed the connection's close grace, so only the
    // write bound can end the connection — the thing a `close()` waits for.
    let upstream = target().await;
    let (mut client, server) = tokio::io::duplex(16);
    let limits = sni_limits(Duration::from_millis(50));
    let peer = Peer {
        remote: "127.0.0.1:40000".parse().expect("a peer address"),
        local: "127.0.0.1:443".parse().expect("a local address"),
    };
    let upgrades = Arc::new(WebSocketUpgrades::new(
        Arc::new(Accepting),
        Arc::new(Dropping),
    ));
    let serving = tokio::spawn(driver::serve(
        Box::new(server),
        peer,
        hop_target(upstream),
        upgrades,
        CancellationToken::new(),
        Grace::new(),
        limits,
        None,
        Stats::new(),
    ));

    client
        .write_all(b"GET /one HTTP/1.1\r\nHost: ace\r\n\r\n")
        .await
        .expect("an ordinary request first");
    assert!(answer(&mut client).await.ends_with(b"ok"));

    client
        .write_all(
            b"GET / HTTP/1.1\r\nHost: ace\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
              Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        )
        .await
        .expect("the upgrade request");
    // Nothing reads the `101`, so it cannot be written.

    // Real time: the bound is 50 ms, far inside the test's own 5 s guard.
    tokio::time::timeout(Duration::from_secs(5), serving)
        .await
        .expect("the stalled `101` ended the connection within its write bound")
        .expect("the connection task");
}

/// Admission that accepts every candidate.
struct Accepting;

impl UpgradeAdmission for Accepting {
    fn admit(
        &self,
        _request: UpgradeRequest,
    ) -> Pin<Box<dyn Future<Output = AdmissionOutcome> + Send>> {
        Box::pin(async { AdmissionOutcome::Decided(AdmissionDecision::Accept { reservation: 1 }) })
    }

    fn writing(&self, _reservation: u64) -> bool {
        true
    }

    fn release(&self, _reservation: u64) {}
}

/// A sink that drops the socket it is handed.
struct Dropping;

impl SocketSink for Dropping {
    fn opened(&self, _reservation: u64, stream: Box<dyn UpgradeIo>, _user_agent: Option<String>) {
        drop(stream);
    }
}
