// SPDX-License-Identifier: Apache-2.0
//! The wire proof of T1b.3b's window rule: a real [`RemoteListener`] negotiating
//! `server_max_window_bits=8` with a raw client, whose every RSV1 frame's payload
//! is decoded by `window8`'s 8-bit-window decoder. Node's inflater does not
//! enforce the window, so this is the only place the promise is checked on the
//! wire.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use super::window8;
use crate::deflate::{Deflate, THRESHOLD};
use crate::driver::UpgradeIo;
use crate::hop::HopSecret;
use crate::limits::{ConnectionLimits, SniLimits};
use crate::proxy::ProxyTarget;
use crate::remote::RemoteListener;
use crate::socket::{SocketEvent, open as open_socket};
use crate::tls::identity::TlsIdentity;
use crate::tls::tests::client::{self, Options};
use crate::tls::tests::fixtures::{EC_LEAF_CERT, EC_LEAF_KEY};
use crate::upgrade::{
    AdmissionDecision, AdmissionOutcome, SocketSink, UpgradeAdmission, UpgradeRequest,
    WebSocketUpgrades,
};

const WAIT: Duration = Duration::from_secs(5);

/// A payload well over the threshold, built so its bytes repeat and a deflater
/// finds matches inside it.
fn message() -> Vec<u8> {
    let mut payload = Vec::new();
    for line in 0..700 {
        payload.extend_from_slice(
            format!("{{\"index\":{line},\"text\":\"the same tool output as the one before\"}}\n")
                .as_bytes(),
        );
    }
    assert!(payload.len() > 13 * 1024);
    payload
}

/// Accepts the one upgrade a test makes.
struct Accept;

impl UpgradeAdmission for Accept {
    fn admit(
        &self,
        _request: UpgradeRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AdmissionOutcome> + Send>> {
        Box::pin(async { AdmissionOutcome::Decided(AdmissionDecision::Accept { reservation: 1 }) })
    }

    fn writing(&self, _reservation: u64) -> bool {
        true
    }

    fn release(&self, _reservation: u64) {}
}

/// Opens the socket the `101` handed over, sends one compressed message, and
/// records the window bits the handshake negotiated.
struct SendOnce {
    payload: Vec<u8>,
    window: Mutex<Option<Option<u8>>>,
    sent: Arc<AtomicBool>,
}

impl SocketSink for SendOnce {
    fn opened(
        &self,
        _reservation: u64,
        stream: Box<dyn UpgradeIo>,
        _user_agent: Option<String>,
        deflate: Option<Deflate>,
    ) {
        let window = deflate
            .as_ref()
            .and_then(|deflate| deflate.server_max_window_bits());
        *self.window.lock().expect("no poison") = Some(window);
        // The sink is called from the connection's task; its own task drives the
        // socket while the test reads the wire.
        let payload = Bytes::from(self.payload.clone());
        let sent = Arc::clone(&self.sent);
        tokio::spawn(async move {
            let (handle, mut events) = open_socket(stream, deflate, None);
            handle.send(payload, true, true, 1);
            while let Some(event) = events.recv().await {
                if matches!(event, SocketEvent::Sent { .. }) {
                    break;
                }
            }
            sent.store(true, Ordering::Release);
            let _ = handle.close(Some(1000), String::new());
            while events.recv().await.is_some() {}
        });
    }
}

/// Reads until the response head's blank line, returning it as text.
async fn head<S: AsyncRead + Unpin>(stream: &mut S) -> String {
    let mut seen = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        let read = tokio::time::timeout(WAIT, stream.read(&mut byte))
            .await
            .expect("the 101 arrives")
            .expect("the client reads");
        assert_eq!(read, 1, "the connection ended inside the 101");
        seen.push(byte[0]);
        if seen.ends_with(b"\r\n\r\n") {
            return String::from_utf8(seen).expect("the 101 is ASCII");
        }
    }
}

/// One server frame (unmasked, never fragmented by the server): FIN, RSV1, the
/// opcode, the length and the payload.
async fn frame<S: AsyncRead + Unpin>(stream: &mut S) -> (bool, u8, Vec<u8>) {
    let mut first = [0u8; 2];
    tokio::time::timeout(WAIT, stream.read_exact(&mut first))
        .await
        .expect("the frame header arrives")
        .expect("the client reads");
    let rsv1 = first[0] & 0x40 != 0;
    let opcode = first[0] & 0x0f;
    let short = first[1] & 0x7f;
    let length = match short {
        126 => {
            let mut extended = [0u8; 2];
            stream.read_exact(&mut extended).await.expect("a length");
            usize::from(u16::from_be_bytes(extended))
        }
        127 => {
            let mut extended = [0u8; 8];
            stream.read_exact(&mut extended).await.expect("a length");
            usize::try_from(u64::from_be_bytes(extended)).expect("a length")
        }
        length => usize::from(length),
    };
    let mut payload = vec![0u8; length];
    tokio::time::timeout(WAIT, stream.read_exact(&mut payload))
        .await
        .expect("the payload arrives")
        .expect("the client reads");
    (rsv1, opcode, payload)
}

#[tokio::test]
async fn every_compressed_frame_a_listener_sends_fits_an_eight_bit_window() {
    let payload = message();
    let identity = TlsIdentity::from_pem(EC_LEAF_CERT.as_bytes(), EC_LEAF_KEY.as_bytes())
        .expect("the identity loads");
    let pin = client::spki(&identity.key().cert[0]);
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let target = ProxyTarget::new(
        upstream.local_addr().expect("its address"),
        Arc::new(HopSecret::from_hex(&"ab".repeat(32)).expect("a secret")),
    )
    .expect("a loopback target");
    let sink = Arc::new(SendOnce {
        payload: payload.clone(),
        window: Mutex::new(None),
        sent: Arc::new(AtomicBool::new(false)),
    });
    let listener = RemoteListener::bind(
        "127.0.0.1:0".parse().expect("an address"),
        client::provider(),
        identity,
        ConnectionLimits::remote_sni(SniLimits::default()),
        target,
        Arc::new(WebSocketUpgrades::with_deflate(
            Arc::new(Accept),
            sink.clone(),
        )),
    )
    .await
    .expect("the listener binds");
    let address = listener.local_addr();

    let mut client = client::connect(
        address,
        client::client_config(&[pin], Options::default()),
        "localhost",
    )
    .await
    .expect("the handshake completes");
    let request = "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=8\r\n\r\n";
    client
        .write_all(request.as_bytes())
        .await
        .expect("the upgrade is written");
    let answer = head(&mut client).await;
    assert!(
        answer.starts_with("HTTP/1.1 101 Switching Protocols\r\n"),
        "the upgrade was accepted: {answer}"
    );
    let extension = answer
        .lines()
        .find(|line| {
            line.to_ascii_lowercase()
                .starts_with("sec-websocket-extensions:")
        })
        .expect("the answer names the extension");
    assert_eq!(
        extension.trim(),
        "Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
        "the answer echoes =8 and adds both no-context-takeover parameters"
    );

    let (rsv1, opcode, compressed) = frame(&mut client).await;
    assert!(rsv1, "a message over the threshold goes compressed");
    assert_eq!(opcode, 0x2, "the daemon's bulk messages are binary");
    assert!(
        compressed.len() < payload.len(),
        "the frame is smaller than its message: {} vs {}",
        compressed.len(),
        payload.len()
    );
    assert!(payload.len() >= THRESHOLD);
    assert_eq!(
        window8::decode_message(&compressed).expect("an 8-bit window holds every distance"),
        payload
    );
    assert_eq!(
        *sink.window.lock().expect("no poison"),
        Some(Some(8)),
        "the socket was opened with the negotiated window"
    );

    listener.close(Duration::from_secs(1)).await;
    assert!(sink.sent.load(Ordering::Acquire));
}
