// SPDX-License-Identifier: Apache-2.0
//! The handshakes a client can and cannot complete (T1b.1a): TLS versions,
//! ALPN, key-exchange groups, resumption, and the certificate pushed at run
//! time. The client pins the server's key the way ace pins a paired machine.

use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::CertificateDer;
use rustls::version::TLS12;
use rustls::{ClientConfig, HandshakeKind, NamedGroup, ProtocolVersion, ServerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::tls::identity::TlsIdentity;
use crate::tls::resolver::SniResolver;
use crate::tls::server_config;

use self::client::Options;
use super::{client, ec, rsa};

/// A server configuration whose identity is `identity`, with the pin a client
/// of that identity needs.
fn server(identity: TlsIdentity) -> (Arc<ServerConfig>, Vec<u8>) {
    let pin = client::spki(&identity_pin_cert(&identity));
    let resolver = Arc::new(SniResolver::new(identity));
    let config = server_config(client::provider(), resolver).expect("the server config builds");
    (Arc::new(config), pin)
}

/// The certificate a test identity was loaded from, for its pin. The identity
/// knows its chain, so this is the certificate the server really serves.
fn identity_pin_cert(identity: &TlsIdentity) -> CertificateDer<'static> {
    identity
        .key()
        .cert
        .first()
        .cloned()
        .expect("an identity has a leaf certificate")
}

#[tokio::test]
async fn tls_1_3_completes() {
    let (config, pin) = server(rsa());
    let (addr, task) = client::endpoint(config).await;
    let client = client::connect(
        addr,
        client::client_config(&[pin], Options::default()),
        "localhost",
    )
    .await
    .expect("TLS 1.3 completes");
    assert_eq!(
        client.get_ref().1.protocol_version(),
        Some(ProtocolVersion::TLSv1_3)
    );
    assert!(task.await.expect("the server task").is_some());
}

#[tokio::test]
async fn tls_1_2_completes() {
    let (config, pin) = server(rsa());
    let (addr, task) = client::endpoint(config).await;
    let options = Options {
        versions: vec![&TLS12],
        ..Options::default()
    };
    let client = client::connect(addr, client::client_config(&[pin], options), "localhost")
        .await
        .expect("TLS 1.2 completes");
    assert_eq!(
        client.get_ref().1.protocol_version(),
        Some(ProtocolVersion::TLSv1_2)
    );
    assert!(task.await.expect("the server task").is_some());
}

#[tokio::test]
async fn a_client_that_offers_only_tls_1_1_is_refused() {
    let (config, _pin) = server(rsa());
    let (addr, task) = client::endpoint(config).await;
    let mut tcp = TcpStream::connect(addr)
        .await
        .expect("the listener accepts");
    tcp.write_all(&client_hello([0x03, 0x02], &[[0x03, 0x02]]))
        .await
        .expect("the hello is written");
    assert!(
        task.await.expect("the server task").is_none(),
        "no TLS 1.1 handshake completes"
    );
}

#[tokio::test]
async fn the_first_offered_alpn_the_server_speaks_is_chosen() {
    let (config, pin) = server(rsa());
    let (addr, task) = client::endpoint(config).await;
    let options = Options {
        alpn: vec![b"h2".to_vec(), b"http/1.1".to_vec()],
        ..Options::default()
    };
    let client = client::connect(addr, client::client_config(&[pin], options), "localhost")
        .await
        .expect("the handshake completes");
    assert_eq!(client.get_ref().1.alpn_protocol(), Some(&b"http/1.1"[..]));
    assert!(task.await.expect("the server task").is_some());
}

#[tokio::test]
async fn a_client_that_offers_only_h2_is_refused() {
    let (config, pin) = server(rsa());
    let (addr, task) = client::endpoint(config).await;
    let options = Options {
        alpn: vec![b"h2".to_vec()],
        ..Options::default()
    };
    assert!(
        client::connect(addr, client::client_config(&[pin], options), "localhost")
            .await
            .is_err(),
        "no shared protocol name: the handshake fails"
    );
    assert!(task.await.expect("the server task").is_none());
}

#[tokio::test]
async fn a_client_offering_the_hybrid_group_negotiates_it() {
    let (config, pin) = server(rsa());
    let (addr, task) = client::endpoint(config).await;
    let options = Options {
        kx_groups: Some(vec![
            rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768,
            rustls::crypto::aws_lc_rs::kx_group::X25519,
        ]),
        ..Options::default()
    };
    let client = client::connect(addr, client::client_config(&[pin], options), "localhost")
        .await
        .expect("the handshake completes");
    assert_eq!(negotiated(&client), NamedGroup::X25519MLKEM768);
    assert!(task.await.expect("the server task").is_some());
}

#[tokio::test]
async fn a_client_without_the_hybrid_group_negotiates_x25519() {
    let (config, pin) = server(rsa());
    let (addr, task) = client::endpoint(config).await;
    let options = Options {
        kx_groups: Some(vec![rustls::crypto::aws_lc_rs::kx_group::X25519]),
        ..Options::default()
    };
    let client = client::connect(addr, client::client_config(&[pin], options), "localhost")
        .await
        .expect("the handshake completes");
    assert_eq!(negotiated(&client), NamedGroup::X25519);
    assert!(task.await.expect("the server task").is_some());
}

#[tokio::test]
async fn a_pushed_certificate_serves_the_next_handshake_and_an_open_one_keeps_its_own() {
    let pinned = rsa();
    let pinned_pin = client::spki(&pinned.key().cert[0]);
    let trusted = ec();
    let trusted_pin = client::spki(&trusted.key().cert[0]);
    let resolver = Arc::new(SniResolver::new(pinned));
    let config =
        Arc::new(server_config(client::provider(), Arc::clone(&resolver)).expect("the config"));
    let pins = [pinned_pin, trusted_pin];

    let (addr, first_task) = client::endpoint(Arc::clone(&config)).await;
    let open = client::connect(
        addr,
        client::client_config(&pins, Options::default()),
        "ace.tail1234.ts.net",
    )
    .await
    .expect("the first handshake completes");
    assert_eq!(served(&open), pins[0], "no trusted certificate yet");

    resolver.set_trusted("ace.tail1234.ts.net", trusted);
    let (addr, second_task) = client::endpoint(Arc::clone(&config)).await;
    let next = client::connect(
        addr,
        client::client_config(&pins, Options::default()),
        "ace.tail1234.ts.net",
    )
    .await
    .expect("the next handshake completes");
    assert_eq!(served(&next), pins[1], "the pushed certificate is served");
    assert_eq!(
        served(&open),
        pins[0],
        "a connection keeps the certificate it shook hands with"
    );
    assert!(first_task.await.expect("the task").is_some());
    assert!(second_task.await.expect("the task").is_some());
}

/// The SPKI the server presented, as the client recorded it.
fn served(client: &tokio_rustls::client::TlsStream<TcpStream>) -> Vec<u8> {
    let certificates = client
        .get_ref()
        .1
        .peer_certificates()
        .expect("the server sent a certificate");
    client::spki(certificates.first().expect("the chain's leaf is first"))
}

#[tokio::test]
async fn a_second_connection_resumes_with_a_ticket() {
    let (config, pin) = server(rsa());
    let client_config = client::client_config(&[pin], Options::default());
    assert_eq!(
        round_trip(Arc::clone(&config), Arc::clone(&client_config)).await,
        HandshakeKind::Full
    );
    assert_eq!(
        round_trip(config, client_config).await,
        HandshakeKind::Resumed,
        "the ticket the first handshake issued is spent by the second"
    );
}

/// One handshake and one answer, so the client reads the session tickets the
/// server queued after its handshake; the kind of handshake is the result.
async fn round_trip(config: Arc<ServerConfig>, client_config: Arc<ClientConfig>) -> HandshakeKind {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a listener");
    let addr = listener.local_addr().expect("its address");
    let acceptor = tokio_rustls::TlsAcceptor::from(config);
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("a connection");
        let accepted =
            crate::tls::handshake::accept(&acceptor, stream, Some(Duration::from_secs(10)))
                .await
                .expect("the handshake");
        let mut stream = accepted.stream;
        stream.write_all(b"ok").await.expect("the answer");
        stream.flush().await.expect("the flush");
        stream.shutdown().await.expect("the close");
    });
    let mut client = client::connect(addr, client_config, "localhost")
        .await
        .expect("the handshake completes");
    let mut answer = [0u8; 2];
    client.read_exact(&mut answer).await.expect("the answer");
    let kind = client
        .get_ref()
        .1
        .handshake_kind()
        .expect("a finished handshake has a kind");
    server.await.expect("the server task");
    kind
}

fn negotiated(stream: &tokio_rustls::client::TlsStream<TcpStream>) -> NamedGroup {
    stream
        .get_ref()
        .1
        .negotiated_key_exchange_group()
        .expect("a finished handshake negotiated a group")
        .name()
}

/// A `ClientHello` written by hand, the only way to offer a TLS version rustls
/// can no longer speak (TLS 1.1).
fn client_hello(legacy: [u8; 2], supported: &[[u8; 2]]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&legacy);
    body.extend_from_slice(&[0x42; 32]);
    body.push(0); // no session id
    body.extend_from_slice(&[0x00, 0x02, 0xc0, 0x2f]); // one ECDHE suite
    body.extend_from_slice(&[0x01, 0x00]); // null compression
    let mut versions = Vec::new();
    versions.push(u8::try_from(supported.len() * 2).expect("a short list"));
    for version in supported {
        versions.extend_from_slice(version);
    }
    let extensions_len = 4 + versions.len();
    body.extend_from_slice(
        &u16::try_from(extensions_len)
            .expect("a short extension")
            .to_be_bytes(),
    );
    body.extend_from_slice(&[0x00, 0x2b]); // supported_versions
    body.extend_from_slice(
        &u16::try_from(versions.len())
            .expect("a short list")
            .to_be_bytes(),
    );
    body.extend_from_slice(&versions);

    let mut handshake = vec![0x01];
    handshake.extend_from_slice(
        &u32::try_from(body.len())
            .expect("a small hello")
            .to_be_bytes()[1..],
    );
    handshake.extend_from_slice(&body);

    let mut record = vec![0x16, 0x03, 0x01];
    record.extend_from_slice(
        &u16::try_from(handshake.len())
            .expect("a small record")
            .to_be_bytes(),
    );
    record.extend_from_slice(&handshake);
    record
}
