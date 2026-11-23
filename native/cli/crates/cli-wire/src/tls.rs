// SPDX-License-Identifier: Apache-2.0
//! Pinned TLS verification and connectors over `rustls` (`ring` provider).
//!
//! Matches `pinnedConnector` in `apps/daemon/src/client-access.ts`:
//! - Verifies the leaf certificate's SPKI SHA-256 fingerprint in constant time before any HTTP
//!   headers or credentials are transmitted.
//! - Allows a Tailscale `.ts.net` `MagicDNS` host to fall back to OS CA roots (loaded lazily via
//!   `rustls-native-certs` only on pin mismatch, or an explicit `tailnet_roots` override in tests)
//!   when its certificate rotates on renewal (ADR 0097).
//! - Rejects certificates outside `[notBefore, notAfter)` using an injected [`Clock`].
//! - Provides both a direct [`connect_pinned_tls`] stream for `tungstenite` `WebSockets` and a
//!   [`PinnedTlsConnector`] implementing `ureq`'s `Connector` trait for `/v1/*` HTTPS calls.

use std::fmt;
use std::io::{self, Read, Write};
use std::sync::{Arc, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, Error as RustlsError,
    OtherError, RootCertStore, SignatureScheme, StreamOwned,
};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, Either, LazyBuffers, NextTimeout, Transport,
    TransportAdapter,
};

use crate::error::WireError;
use crate::origin::{RemoteOrigin, is_tailnet_name};
use crate::stream::{TransportStream, classify_io_error, connect_remote_tcp};
use crate::types::Fingerprint;
use crate::x509::{parse_leaf_certificate, sha256_fingerprint};

/// Wall-clock source for certificate validity checks, injected so tests can simulate expiry.
pub trait Clock: Send + Sync + fmt::Debug {
    /// Current Unix epoch time in milliseconds.
    fn now_millis(&self) -> u64;
}

/// Real wall clock backed by [`SystemTime::now`].
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_millis(&self) -> u64 {
        let Ok(since_epoch) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return 0;
        };
        u64::try_from(since_epoch.as_millis()).unwrap_or(u64::MAX)
    }
}

/// Configuration for a pinned TLS dial.
#[derive(Debug, Clone)]
pub struct TlsPinConfig {
    /// Expected lowercase 64-hex SHA-256 fingerprint of the peer leaf certificate's SPKI.
    pub fingerprint: Fingerprint,
    /// Clock used to validate `[notBefore, notAfter)`.
    pub clock: Arc<dyn Clock>,
    /// Optional CA root store override for the `.ts.net` renewal fallback (for tests).
    /// When `None`, OS native CA roots are loaded lazily via `rustls-native-certs` only if a
    /// `.ts.net` host's leaf key does not match the pin.
    pub tailnet_roots: Option<Arc<RootCertStore>>,
}

impl TlsPinConfig {
    /// Creates a standard pinned TLS config using [`SystemClock`] and lazy native OS roots for
    /// `.ts.net` key-rotation fallback.
    #[must_use]
    pub fn new(fingerprint: Fingerprint) -> Self {
        Self {
            fingerprint,
            clock: Arc::new(SystemClock),
            tailnet_roots: None,
        }
    }
}

#[derive(Debug)]
struct PinMismatchError;

impl fmt::Display for PinMismatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TLS public-key fingerprint mismatch")
    }
}

impl std::error::Error for PinMismatchError {}

#[derive(Debug)]
struct PinnedCertVerifier {
    fingerprint: Fingerprint,
    clock: Arc<dyn Clock>,
    custom_roots: Option<Arc<RootCertStore>>,
    cached_tailnet_verifier: OnceLock<Option<Arc<WebPkiServerVerifier>>>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl PinnedCertVerifier {
    fn new(config: &TlsPinConfig) -> Self {
        let provider = rustls::crypto::ring::default_provider();
        Self {
            fingerprint: config.fingerprint.clone(),
            clock: Arc::clone(&config.clock),
            custom_roots: config.tailnet_roots.clone(),
            cached_tailnet_verifier: OnceLock::new(),
            algorithms: provider.signature_verification_algorithms,
        }
    }

    fn tailnet_verifier(&self) -> Option<&Arc<WebPkiServerVerifier>> {
        self.cached_tailnet_verifier
            .get_or_init(|| {
                let roots = match &self.custom_roots {
                    Some(custom) => Arc::clone(custom),
                    None => load_native_roots(),
                };
                if roots.is_empty() {
                    return None;
                }
                let provider = Arc::new(rustls::crypto::ring::default_provider());
                WebPkiServerVerifier::builder_with_provider(roots, provider)
                    .build()
                    .ok()
            })
            .as_ref()
    }
}

impl ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        let info = parse_leaf_certificate(end_entity.as_ref())
            .map_err(|_| RustlsError::InvalidCertificate(CertificateError::BadEncoding))?;
        let actual = sha256_fingerprint(info.spki_der);

        if !actual.ct_eq_bytes(self.fingerprint.as_bytes()) {
            let trusted_tailnet = match server_name {
                ServerName::DnsName(dns) if is_tailnet_name(dns.as_ref()) => {
                    self.tailnet_verifier().is_some_and(|verifier| {
                        verifier
                            .verify_server_cert(
                                end_entity,
                                intermediates,
                                server_name,
                                ocsp_response,
                                now,
                            )
                            .is_ok()
                    })
                }
                _ => false,
            };
            if !trusted_tailnet {
                return Err(RustlsError::InvalidCertificate(CertificateError::Other(
                    OtherError(Arc::new(PinMismatchError)),
                )));
            }
        }

        let at = self.clock.now_millis();
        if at < info.not_before_ms {
            return Err(RustlsError::InvalidCertificate(
                CertificateError::NotValidYet,
            ));
        }
        if at >= info.not_after_ms {
            return Err(RustlsError::InvalidCertificate(CertificateError::Expired));
        }

        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn load_native_roots() -> Arc<RootCertStore> {
    let mut store = RootCertStore::empty();
    let result = rustls_native_certs::load_native_certs();
    for cert in result.certs {
        let _ = store.add(cert);
    }
    Arc::new(store)
}

/// Builds a `rustls::ClientConfig` enforcing SPKI pinning and `[notBefore, notAfter)`.
pub(crate) fn build_pinned_rustls_config(
    config: &TlsPinConfig,
) -> Result<Arc<ClientConfig>, WireError> {
    let verifier = Arc::new(PinnedCertVerifier::new(config));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let client_config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| WireError::Protocol {
            detail: format!("TLS configuration error: {err}"),
        })?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(Arc::new(client_config))
}

/// `ureq` v3 [`Connector`] wrapping a chained TCP transport with our pinned `rustls::ClientConfig`.
pub(crate) struct PinnedTlsConnector {
    rustls_config: Arc<ClientConfig>,
}

impl PinnedTlsConnector {
    pub(crate) const fn new(rustls_config: Arc<ClientConfig>) -> Self {
        Self { rustls_config }
    }
}

impl fmt::Debug for PinnedTlsConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PinnedTlsConnector").finish()
    }
}

impl<In: Transport> Connector<In> for PinnedTlsConnector {
    type Out = Either<In, PinnedTlsTransport>;

    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        chained: Option<In>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        let Some(transport) = chained else {
            return Err(ureq::Error::Tls(
                "PinnedTlsConnector requires a chained TCP transport",
            ));
        };
        if !details.needs_tls() || transport.is_tls() {
            return Ok(Some(Either::A(transport)));
        }

        let host = details
            .uri
            .host()
            .ok_or(ureq::Error::Tls("Missing host for TLS"))?;
        let bare_host = host
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .unwrap_or(host);
        let server_name = ServerName::try_from(bare_host.to_owned())
            .map_err(|_| ureq::Error::Tls("Invalid TLS server name"))?;

        let mut conn = ClientConnection::new(Arc::clone(&self.rustls_config), server_name)?;
        let mut sock = TransportAdapter::new(transport.boxed(), Arc::clone(&details.current_time));
        sock.set_timeout(details.timeout);
        while conn.is_handshaking() {
            match conn.complete_io(&mut sock) {
                Ok((0, 0)) if conn.is_handshaking() => {
                    return Err(ureq::Error::Io(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "TLS peer closed during handshake",
                    )));
                }
                Ok(_) => {}
                Err(io_err) => return Err(extract_ureq_tls_error(io_err)),
            }
        }

        let buffers = LazyBuffers::new(
            details.config.input_buffer_size(),
            details.config.output_buffer_size(),
        );
        Ok(Some(Either::B(PinnedTlsTransport {
            buffers,
            stream: StreamOwned::new(conn, sock),
        })))
    }
}

/// Active pinned-TLS transport for `ureq`.
pub(crate) struct PinnedTlsTransport {
    buffers: LazyBuffers,
    stream: StreamOwned<ClientConnection, TransportAdapter>,
}

impl fmt::Debug for PinnedTlsTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PinnedTlsTransport").finish()
    }
}

impl Transport for PinnedTlsTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let output = &self.buffers.output()[..amount];
        self.stream
            .write_all(output)
            .map_err(extract_ureq_tls_error)
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let input = self.buffers.input_append_buf();
        let amount = self.stream.read(input).map_err(extract_ureq_tls_error)?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }

    fn is_open(&mut self) -> bool {
        self.stream.get_mut().get_mut().is_open()
    }

    fn is_tls(&self) -> bool {
        true
    }
}

fn extract_ureq_tls_error(err: io::Error) -> ureq::Error {
    match err.downcast::<ureq::Error>() {
        Ok(ureq_err) => ureq_err,
        Err(err) => match err.downcast::<RustlsError>() {
            Ok(tls_err) => ureq::Error::Rustls(tls_err),
            Err(io_err) => ureq::Error::Io(io_err),
        },
    }
}

/// Dials TCP + completes a pinned TLS handshake before returning the stream (used by `ws.rs`).
pub(crate) fn connect_pinned_tls(
    origin: &RemoteOrigin,
    config: &TlsPinConfig,
    deadline: Instant,
) -> Result<TransportStream, WireError> {
    let client_config = build_pinned_rustls_config(config)?;
    let server_name =
        ServerName::try_from(origin.host().to_owned()).map_err(|_| WireError::InvalidTarget {
            detail: format!("Invalid TLS server name: {}", origin.host()),
        })?;

    let mut tcp = connect_remote_tcp(origin.host(), origin.port(), deadline)?;
    let mut conn =
        ClientConnection::new(client_config, server_name).map_err(|err| WireError::Protocol {
            detail: format!("TLS client init failed: {err}"),
        })?;

    while conn.is_handshaking() {
        apply_tcp_deadline(&tcp, deadline)?;
        if let Err(err) = conn.complete_io(&mut tcp) {
            return Err(classify_tls_io_error(&err));
        }
    }

    Ok(TransportStream::Tls(Box::new(StreamOwned::new(conn, tcp))))
}

fn apply_tcp_deadline(tcp: &std::net::TcpStream, deadline: Instant) -> Result<(), WireError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or(WireError::Timeout {
            context: "TLS handshake",
        })?;
    tcp.set_read_timeout(Some(remaining))
        .and_then(|()| tcp.set_write_timeout(Some(remaining)))
        .map_err(|err| classify_io_error(&err, "TLS handshake"))
}

fn classify_tls_io_error(err: &io::Error) -> WireError {
    if let Some(tls_err) = err
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<RustlsError>())
    {
        return classify_rustls_error(tls_err);
    }
    classify_io_error(err, "TLS handshake")
}

pub(crate) fn classify_rustls_error(err: &RustlsError) -> WireError {
    match err {
        RustlsError::InvalidCertificate(
            CertificateError::Expired | CertificateError::NotValidYet,
        ) => WireError::Auth {
            detail: "TLS certificate expired or not yet valid".into(),
            revoked: false,
        },
        RustlsError::InvalidCertificate(CertificateError::Other(other)) => WireError::Auth {
            detail: other.to_string(),
            revoked: false,
        },
        RustlsError::InvalidCertificate(cert_err) => WireError::Auth {
            detail: format!("TLS pin failed: {cert_err:?}"),
            revoked: false,
        },
        other => WireError::Offline {
            detail: format!("TLS handshake failed: {other}"),
        },
    }
}
