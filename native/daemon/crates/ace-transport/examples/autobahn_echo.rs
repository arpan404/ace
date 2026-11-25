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

// The suite sends messages up to 16 MiB and up to 65,536 fragments, so the
// defaults the daemon's listeners use would refuse its largest cases. The
// fragment bound is `ws`'s; only the payload bound moves, and only here.
const LIMITS: FrameLimits = FrameLimits {
    max_payload: 16 * 1024 * 1024,
    max_fragments: 65_536,
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
    loop {
        match head::parse(&buffer) {
            Parsed::Head(request, used) => {
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
                return;
            }
            Parsed::Incomplete => {
                let mut chunk = [0_u8; 8 * 1024];
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                }
            }
            Parsed::TooLarge | Parsed::Malformed => {
                let _ = stream.write_all(BAD_REQUEST).await;
                return;
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
    loop {
        let (stream, _) = listener.accept().await?;
        let handler = Arc::clone(&handler);
        tokio::spawn(serve(handler, stream));
    }
}

#[cfg(test)]
#[path = "autobahn_echo/tests.rs"]
mod tests;
