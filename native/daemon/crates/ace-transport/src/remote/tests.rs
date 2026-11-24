// SPDX-License-Identifier: Apache-2.0
//! The remote listener's end-to-end proof (T1b.1a): one request through real
//! TLS, reaching a real local HTTP target with the hop's fields set from the
//! connection's real peer. The listener's timers are deliberately not here:
//! `sni-listener.process`'s cases are their proof, and T1b.4 runs them against
//! whichever listener the switch selects.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http::{Request, Response};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::driver::RefuseUpgrades;
use crate::hop::HopSecret;
use crate::limits::{ConnectionLimits, SniLimits};
use crate::proxy::ProxyTarget;
use crate::remote::RemoteListener;
use crate::tls::identity::TlsIdentity;
use crate::tls::tests::client::{self, Options};
use crate::tls::tests::fixtures::{EC_LEAF_CERT, EC_LEAF_KEY};

/// The daemon's own HTTP server, standing in for the TypeScript handlers: it
/// records the headers it received and answers `ok`.
async fn target() -> (SocketAddr, Arc<Mutex<Vec<Vec<(String, Vec<u8>)>>>>) {
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
                        let headers = req
                            .headers()
                            .iter()
                            .map(|(name, value)| {
                                (name.as_str().to_owned(), value.as_bytes().to_vec())
                            })
                            .collect();
                        record.lock().expect("no poison").push(headers);
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

#[tokio::test]
async fn a_request_through_tls_reaches_the_target_with_the_hop_fields() {
    let (upstream, seen) = target().await;
    let identity = TlsIdentity::from_pem(EC_LEAF_CERT.as_bytes(), EC_LEAF_KEY.as_bytes())
        .expect("the identity loads");
    let pin = client::spki(&identity.key().cert[0]);
    let secret = "cd".repeat(32);
    let target = ProxyTarget::new(
        upstream,
        Arc::new(HopSecret::from_hex(&secret).expect("a test secret")),
    )
    .expect("a loopback target");

    let listener = RemoteListener::bind(
        "127.0.0.1:0".parse().expect("an address"),
        client::provider(),
        identity,
        ConnectionLimits::remote_sni(SniLimits::default()),
        target,
        Arc::new(RefuseUpgrades),
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
    let peer_port = client
        .get_ref()
        .0
        .local_addr()
        .expect("the client's address")
        .port();
    client
        .write_all(b"GET /hello HTTP/1.1\r\nHost: ace\r\nConnection: close\r\n\r\n")
        .await
        .expect("the request is written");
    let mut answer = Vec::new();
    client
        .read_to_end(&mut answer)
        .await
        .expect("the answer arrives");
    assert!(
        answer.windows(2).any(|window| window == b"ok"),
        "the target's answer reached the client through TLS"
    );
    listener.close(Duration::ZERO).await;

    let requests = seen.lock().expect("no poison");
    let headers = requests.first().expect("the target was asked once");
    let header = |name: &str| {
        headers
            .iter()
            .find(|(field, _)| field == name)
            .map(|(_, value)| String::from_utf8_lossy(value).into_owned())
    };
    assert_eq!(
        header("x-ace-hop-peer-address").as_deref(),
        Some("127.0.0.1")
    );
    assert_eq!(
        header("x-ace-hop-peer-port"),
        Some(peer_port.to_string()),
        "the hop carries the TLS connection's own peer"
    );
    assert_eq!(
        header("x-ace-hop-local-port"),
        Some(address.port().to_string())
    );
    assert_eq!(header("x-ace-hop-secret"), Some(secret));
}
