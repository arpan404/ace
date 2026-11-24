// SPDX-License-Identifier: Apache-2.0
//! The client the TLS tests shake hands with: `tokio-rustls`'s connector and a
//! verifier that pins the server's `SubjectPublicKeyInfo`, the value ace derives
//! its pin from (`apps/daemon/src/tls-identity.ts:6`–`:9` exports the same DER
//! and hashes it). The comparison is over the DER bytes rather than their
//! SHA-256: rustls exposes no public digest of arbitrary bytes, and a direct
//! aws-lc-rs dependency is not one this crate may have. Nothing here installs a
//! process provider or builds ring.

use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, SupportedKxGroup, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme, WantsVerifier};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::tls::handshake::{self, Accepted, Configs};

/// The aws-lc-rs provider the tests configure explicitly.
pub(crate) fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

/// The `SubjectPublicKeyInfo` DER a client pins for `cert`: exactly what
/// `X509Certificate.publicKey.export({ type: "spki", format: "der" })` hands
/// `tls-identity.ts`'s hash.
pub(crate) fn spki(cert: &CertificateDer<'_>) -> Vec<u8> {
    ParsedCertificate::try_from(cert)
        .expect("a test certificate parses")
        .subject_public_key_info()
        .as_ref()
        .to_vec()
}

/// What a test's client asks for.
pub(crate) struct Options {
    pub alpn: Vec<Vec<u8>>,
    pub kx_groups: Option<Vec<&'static dyn SupportedKxGroup>>,
    pub versions: Vec<&'static rustls::SupportedProtocolVersion>,
    /// The client's own cipher-suite order, when a test fixes it.
    pub cipher_suites: Option<Vec<rustls::SupportedCipherSuite>>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            alpn: vec![b"http/1.1".to_vec()],
            kx_groups: None,
            versions: vec![&rustls::version::TLS13, &rustls::version::TLS12],
            cipher_suites: None,
        }
    }
}

/// A client configuration that trusts exactly the keys whose SPKI DER is one of
/// `pins`.
pub(crate) fn client_config(pins: &[Vec<u8>], options: Options) -> Arc<ClientConfig> {
    // The client's groups and suites are the provider's order: rustls reads a
    // client's preference from there.
    let mut base = rustls::crypto::aws_lc_rs::default_provider();
    if let Some(groups) = options.kx_groups {
        base.kx_groups = groups;
    }
    if let Some(suites) = options.cipher_suites {
        base.cipher_suites = suites;
    }
    let provider = Arc::new(base);
    let verifier = Arc::new(Pinned {
        pins: pins.to_vec(),
        algorithms: provider.signature_verification_algorithms,
    });
    let builder: rustls::ConfigBuilder<ClientConfig, WantsVerifier> =
        ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&options.versions)
            .expect("the test's protocol versions are supported");
    let mut config = builder
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    config.alpn_protocols = options.alpn;
    Arc::new(config)
}

/// Shake hands as `name`, or fail as the client would.
pub(crate) async fn connect(
    addr: SocketAddr,
    config: Arc<ClientConfig>,
    name: &str,
) -> Result<TlsStream<TcpStream>, std::io::Error> {
    let connector = TlsConnector::from(config);
    let server_name = ServerName::try_from(name.to_owned()).expect("a DNS name");
    let tcp = TcpStream::connect(addr)
        .await
        .expect("the listener accepts the connection");
    connector.connect(server_name, tcp).await
}

/// A one-connection TLS endpoint running `configs`, settled with whatever the
/// handshake produced: `None` for a refusal.
pub(crate) async fn endpoint(configs: Arc<Configs>) -> (SocketAddr, JoinHandle<Option<Accepted>>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback listener");
    let addr = listener.local_addr().expect("its address");
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.ok()?;
        handshake::accept(&configs, stream, Some(Duration::from_secs(10))).await
    });
    (addr, task)
}

/// Accepts a handshake only when the server's SPKI is one of the pins, and
/// verifies the handshake signature as any TLS client does.
struct Pinned {
    pins: Vec<Vec<u8>>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl fmt::Debug for Pinned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Pinned")
    }
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let parsed = ParsedCertificate::try_from(end_entity)?;
        let spki = parsed.subject_public_key_info();
        if self.pins.iter().any(|pin| pin.as_slice() == spki.as_ref()) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "the pinned key does not match".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}
