// SPDX-License-Identifier: Apache-2.0
//! Pinned TLS verification and blocking connection setup over `rustls` (`ring` provider).
//!
//! Matches `pinnedConnector` in `apps/daemon/src/client-access.ts`:
//! - Verifies the leaf certificate's SPKI SHA-256 fingerprint in constant time before any HTTP
//!   headers or credentials are transmitted.
//! - Optionally allows a Tailscale `.ts.net` `MagicDNS` host to verify against trusted CA roots
//!   when its certificate rotates on renewal (ADR 0097).
//! - Rejects certificates outside `[notBefore, notAfter)` using an injected [`Clock`].

use std::fmt;
use std::io;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, Error as RustlsError,
    OtherError, RootCertStore, SignatureScheme, StreamOwned,
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
    /// Optional CA root store used only as the `.ts.net` renewal fallback (ADR 0097).
    pub tailnet_roots: Option<Arc<RootCertStore>>,
}

impl TlsPinConfig {
    /// Creates a standard pinned TLS config using [`SystemClock`] and no CA fallback roots.
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
    tailnet_verifier: Option<Arc<WebPkiServerVerifier>>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl PinnedCertVerifier {
    fn new(config: &TlsPinConfig) -> Result<Self, WireError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let algorithms = provider.signature_verification_algorithms;
        let tailnet_verifier = match &config.tailnet_roots {
            Some(roots) => {
                let verifier = WebPkiServerVerifier::builder_with_provider(
                    Arc::clone(roots),
                    Arc::clone(&provider),
                )
                .build()
                .map_err(|err| WireError::Auth {
                    detail: format!("Invalid TLS root store: {err}"),
                    revoked: false,
                })?;
                Some(verifier)
            }
            None => None,
        };
        Ok(Self {
            fingerprint: config.fingerprint.clone(),
            clock: Arc::clone(&config.clock),
            tailnet_verifier,
            algorithms,
        })
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
            let trusted_tailnet = match (server_name, &self.tailnet_verifier) {
                (ServerName::DnsName(dns), Some(verifier)) if is_tailnet_name(dns.as_ref()) => {
                    verifier
                        .verify_server_cert(
                            end_entity,
                            intermediates,
                            server_name,
                            ocsp_response,
                            now,
                        )
                        .is_ok()
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

/// Dials TCP + completes a pinned TLS handshake before returning the stream, so pin mismatches and
/// certificate validity errors fail immediately with [`WireError::Auth`].
pub(crate) fn connect_pinned_tls(
    origin: &RemoteOrigin,
    config: &TlsPinConfig,
    deadline: Instant,
) -> Result<TransportStream, WireError> {
    let verifier = Arc::new(PinnedCertVerifier::new(config)?);
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let client_config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| WireError::Protocol {
            detail: format!("TLS configuration error: {err}"),
        })?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();

    let server_name =
        ServerName::try_from(origin.host().to_owned()).map_err(|_| WireError::InvalidTarget {
            detail: format!("Invalid TLS server name: {}", origin.host()),
        })?;

    let mut tcp = connect_remote_tcp(origin.host(), origin.port(), deadline)?;
    let mut conn = ClientConnection::new(Arc::new(client_config), server_name).map_err(|err| {
        WireError::Protocol {
            detail: format!("TLS client init failed: {err}"),
        }
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

fn classify_rustls_error(err: &RustlsError) -> WireError {
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
