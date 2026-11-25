// SPDX-License-Identifier: Apache-2.0
//! A dev-only echo server for the Autobahn fuzzingclient (T1b.5): ace's own HTTP/1.1 head parse,
//! WebSocket handshake, framing and `permessage-deflate` over plain TCP on `127.0.0.1:9001`, with
//! the options the remote listener uses. Never built into the addon: this is an example target
//! (`cargo build --example autobahn_echo`), and the suite's run is offline and never in CI.
//!
//! TLS is rustls', already fuzzed upstream, so the suite talks to the framing and the codec here,
//! as `t1b-brief.md` says. Every message is echoed with the same binary flag and with compression
//! left to the codec's 1,024-byte threshold, which is `ws`'s default and ace's.
//!
//!   cargo build --example autobahn_echo
//!   ./target/debug/examples/autobahn_echo
//!
//! Then `scripts/transport-autobahn.ts`, which runs the suite against this server and against a
//! scratch `ws` echo server with `remoteDeflate`, and compares the two reports.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ace_transport::conn_io::ConnIo;
use ace_transport::deflate::Deflate;
use ace_transport::driver::{Grace, UpgradeHandler, UpgradeIo};
use ace_transport::frame::FrameLimits;
use ace_transport::head::{self, BAD_REQUEST, Parsed};
use ace_transport::limits::ConnectionLimits;
use ace_transport::peer::Peer;
use ace_transport::prefixed::Prefixed;
use ace_transport::socket::{self, MESSAGE_OVERHEAD, SocketEvent};
use ace_transport::upgrade::{
    AdmissionDecision, AdmissionOutcome, SocketSink, UpgradeAdmission, UpgradeRequest,
    WebSocketUpgrades,
};
use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

/// Every admission is accepted: this server is the suite's testee, not a daemon.
struct AcceptAll {
    next: AtomicU64,
}

impl UpgradeAdmission for AcceptAll {
    fn admit(
        &self,
        _request: UpgradeRequest,
    ) -> Pin<Box<dyn Future<Output = AdmissionOutcome> + Send>> {
        let reservation = self.next.fetch_add(1, Ordering::Relaxed);
        Box::pin(
            async move { AdmissionOutcome::Decided(AdmissionDecision::Accept { reservation }) },
        )
    }

    fn writing(&self, _reservation: u64) -> bool {
        true
    }

    fn release(&self, _reservation: u64) {}
}

// The suite's largest cases are past the daemon's bounds: 9.1.6 sends a 16 MiB
// message and 9.3.1/9.4.1 split 4 MiB into 64-byte fragments, which is 65,536
// frames plus the suite's closing one. `ws` accepts N fragments and refuses
// N+1, so 65,536 could be exact; this scratch server keeps twice that and the
// reference server in the comparison takes the same numbers. Only this example
// moves: the daemon's listeners keep `FrameLimits::default`, 1 MiB and 16,384.
const LIMITS: FrameLimits = FrameLimits {
    max_payload: 16 * 1024 * 1024,
    max_fragments: 131_072,
};

/// Opens the socket and echoes what arrives.
struct Echo;

impl SocketSink for Echo {
    fn opened(
        &self,
        _reservation: u64,
        stream: Box<dyn UpgradeIo>,
        _user_agent: Option<String>,
        deflate: Option<Deflate>,
    ) {
        let (socket, mut events) = socket::open_with_limits(stream, deflate, None, LIMITS);
        tokio::spawn(async move {
            let mut id = 0_u64;
            while let Some(event) = events.recv().await {
                match event {
                    SocketEvent::Message { data, binary } => {
                        let charge = data.len() as u64 + MESSAGE_OVERHEAD;
                        id += 1;
                        let _ = socket.send(Bytes::from(data), binary, true, id);
                        socket.delivered(charge);
                    }
                    SocketEvent::Sent { .. } | SocketEvent::Error { .. } => {}
                    SocketEvent::Close { .. } => break,
                }
            }
        });
    }
}

/// Reads one connection's head, then hands the stream to the handshake above.
async fn serve(handler: Arc<WebSocketUpgrades>, mut stream: TcpStream) {
    let mut buffer = Vec::new();
    // The daemon's own first-head deadline: a peer that never finishes its head
    // cannot hold the connection (or a task) for longer than that.
    let deadline = ConnectionLimits::loopback().first_head;
    let read = tokio::time::timeout(deadline, async {
        loop {
            match head::parse(&buffer) {
                Parsed::Head(request, used) => return Some((request, used)),
                Parsed::Incomplete => {
                    let mut chunk = [0_u8; 8 * 1024];
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return None,
                        Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                    }
                }
                Parsed::TooLarge | Parsed::Malformed => {
                    let _ = stream.write_all(BAD_REQUEST).await;
                    return None;
                }
            }
        }
    })
    .await;
    let Ok(Some((request, used))) = read else {
        return;
    };
    let Ok(peer) = Peer::of(&stream) else {
        return;
    };
    let prefix = Bytes::copy_from_slice(&buffer[used..]);
    let prefixed = Prefixed::new(
        prefix,
        Box::new(stream) as Box<dyn ConnIo>,
        Duration::from_secs(5),
    );
    handler
        .upgrade_raw(
            request,
            prefixed,
            peer,
            CancellationToken::new(),
            Grace::new(),
        )
        .await;
}

/// Where an accepting loop takes connections from, so a test can make one
/// accept fail the way `EMFILE` does.
trait Connections {
    fn accept(
        &mut self,
    ) -> impl Future<Output = std::io::Result<(TcpStream, std::net::SocketAddr)>>;
}

impl Connections for TcpListener {
    fn accept(
        &mut self,
    ) -> impl Future<Output = std::io::Result<(TcpStream, std::net::SocketAddr)>> {
        TcpListener::accept(self)
    }
}

/// How long a failed accept waits before trying again, as the daemon's own loop
/// does (`accept.rs`'s `ACCEPT_RETRY`).
const ACCEPT_RETRY: Duration = Duration::from_millis(10);

/// Accepts for as long as the listener can, surviving a transient failure the
/// way Node's server does: report the first of a run, back off, keep accepting.
async fn accept_loop<C: Connections>(
    mut listener: C,
    handler: Arc<WebSocketUpgrades>,
    report: impl Fn(&std::io::Error),
) {
    let mut reported = false;
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                reported = false;
                tokio::spawn(serve(Arc::clone(&handler), stream));
            }
            Err(error) => {
                if !reported {
                    report(&error);
                    reported = true;
                }
                tokio::time::sleep(ACCEPT_RETRY).await;
            }
        }
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 9001)).await?;
    // The remote listener's options: `permessage-deflate` is offered (T1b.3b).
    let handler = Arc::new(WebSocketUpgrades::with_deflate(
        Arc::new(AcceptAll {
            next: AtomicU64::new(1),
        }),
        Arc::new(Echo),
    ));
    accept_loop(listener, handler, |error| {
        // The scratch server's only channel; the library itself never prints.
        eprintln!("autobahn_echo: accept failed: {error}");
    })
    .await;
    Ok(())
}

#[cfg(test)]
#[path = "autobahn_echo/tests.rs"]
mod tests;
