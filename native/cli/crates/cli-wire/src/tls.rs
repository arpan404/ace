// SPDX-License-Identifier: Apache-2.0
//! Pinned TLS verification and WSS dialer over `rustls` (`ring` provider).
//!
//! Matches `pinnedConnector` in `apps/daemon/src/client-access.ts` and ADR 0097:
//! - Verifies the leaf certificate's SPKI SHA-256 fingerprint in constant time before any HTTP
//!   headers or credentials are transmitted.
//! - Allows a Tailscale `*.ts.net` `MagicDNS` host to fall back to OS system CA roots when its
//!   certificate rotates on renewal (ADR 0097), without reading `SSL_CERT_FILE` / `SSL_CERT_DIR`
//!   environment overrides (matching Node's default `tls.connect` trust).
//! - Rejects certificates outside `[notBefore, notAfter)` using an injected [`Clock`].

use std::fmt;
use std::io;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    /// Optional CA root store override for the `.ts.net` renewal fallback (for tests only).
    /// When `None`, OS system CA roots are loaded lazily only if a `*.ts.net` host's leaf key
    /// does not match the pin, never honoring `SSL_CERT_FILE` / `SSL_CERT_DIR`.
    pub tailnet_roots: Option<Arc<RootCertStore>>,
}

impl TlsPinConfig {
    /// Creates a standard pinned TLS config using [`SystemClock`] and lazy OS system roots for
    /// `.ts.net` key-rotation fallback.
    #[must_use]
    pub fn new(fingerprint: Fingerprint) -> Self {
        Self {
            fingerprint,
            clock: Arc::new(SystemClock),
            tailnet_roots: None,
        }
    }

    /// Builds a `rustls::ClientConfig` enforcing this pin, `[notBefore, notAfter)`, and `.ts.net`
    /// renewal fallback rules.
    pub fn build_client_config(&self) -> Result<Arc<ClientConfig>, WireError> {
        build_pinned_rustls_config(self)
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
                    None => load_system_roots(),
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
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        let info = parse_leaf_certificate(end_entity.as_ref())
            .map_err(|_| RustlsError::InvalidCertificate(CertificateError::BadEncoding))?;
        let actual = sha256_fingerprint(info.spki_der);
        let at_ms = self.clock.now_millis();
        let verify_now = UnixTime::since_unix_epoch(Duration::from_millis(at_ms));

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
                                verify_now,
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

        if at_ms < info.not_before_ms {
            return Err(RustlsError::InvalidCertificate(
                CertificateError::NotValidYet,
            ));
        }
        if at_ms >= info.not_after_ms {
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

/// Loads OS system root CAs without consulting `SSL_CERT_FILE` or `SSL_CERT_DIR`.
fn load_system_roots() -> Arc<RootCertStore> {
    let mut store = RootCertStore::empty();
    load_platform_system_roots(&mut store);
    Arc::new(store)
}

#[cfg(target_os = "macos")]
fn load_platform_system_roots(store: &mut RootCertStore) {
    use security_framework::trust_settings::{Domain, TrustSettings, TrustSettingsForCertificate};

    // Query only the immutable System domain (Apple's shipped public CAs), matching Node's
    // bundled public CA store and ignoring SSL_CERT_* and per-user overrides.
    let ts = TrustSettings::new(Domain::System);
    let Ok(iter) = ts.iter() else {
        return;
    };
    for cert in iter {
        let trusted = match ts.tls_trust_settings_for_certificate(&cert) {
            Ok(Some(setting)) => setting,
            Ok(None) => TrustSettingsForCertificate::TrustRoot,
            Err(_) => continue,
        };
        if matches!(
            trusted,
            TrustSettingsForCertificate::TrustRoot | TrustSettingsForCertificate::TrustAsRoot
        ) {
            let _ = store.add(CertificateDer::from(cert.to_der()));
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn load_platform_system_roots(store: &mut RootCertStore) {
    use rustls::pki_types::pem::PemObject;

    // Standard Linux/BSD system CA bundle locations; never reads SSL_CERT_FILE / SSL_CERT_DIR.
    const SYSTEM_BUNDLES: &[&str] = &[
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/ca-bundle.pem",
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
        "/etc/ssl/cert.pem",
    ];
    for path in SYSTEM_BUNDLES {
        let Ok(iter) = CertificateDer::pem_file_iter(path) else {
            continue;
        };
        let mut added = 0usize;
        for cert in iter.flatten() {
            if store.add(cert).is_ok() {
                added += 1;
            }
        }
        if added > 0 {
            break;
        }
    }
}

#[cfg(windows)]
fn load_platform_system_roots(store: &mut RootCertStore) {
    let Ok(cert_store) = schannel::cert_store::CertStore::open_local_machine("ROOT") else {
        return;
    };
    for cert in cert_store.certs() {
        let _ = store.add(CertificateDer::from(cert.to_der().to_vec()));
    }
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

/// Dials TCP + completes a pinned TLS handshake under an absolute per-syscall `deadline`.
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
        match conn.complete_io(&mut tcp) {
            Ok((0, 0)) if conn.is_handshaking() => {
                return Err(WireError::Offline {
                    detail: "TLS peer closed during handshake".into(),
                });
            }
            Ok(_) => {}
            Err(err) => return Err(classify_tls_io_error(&err)),
        }
    }

    Ok(TransportStream::Tls(Box::new(StreamOwned::new(conn, tcp))))
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
