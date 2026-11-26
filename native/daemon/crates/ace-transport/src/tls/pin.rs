// SPDX-License-Identifier: Apache-2.0
//! The client ace is to another daemon (T2's `client-access.ts`): a verifier that trusts exactly
//! one certificate key, the fingerprint a pairing link carries, and checks its validity window.
//! A ts.net host may instead present the publicly trusted certificate Tailscale issues for that
//! name (ADR 0097), so the shell can hand in the system's own verifier for those names. The
//! handshake's bytes are tokio's; only the decision lives here.

use std::fmt;
use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{DigitallySignedStruct, Error, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};

use crate::error::TransportError;

/// The message a pin that matches no key shows (`client-access.ts:129`).
pub const PIN_MISMATCH: &str = "TLS public-key fingerprint mismatch";
/// The message a pinned certificate outside its validity window shows (`:132`).
pub const PIN_EXPIRED: &str = "TLS certificate expired or not yet valid";
/// The message any other pin failure shows (`:135`).
pub const PIN_FAILED: &str = "TLS pin failed";

/// A certificate key's fingerprint: the SHA-256 of its `SubjectPublicKeyInfo`, 64 hex characters
/// (`tls-identity.ts:6`–`:9`). The same rule `client-access.ts` refuses a malformed pin with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pin([u8; 32]);

impl Pin {
    /// Parse the 64 lowercase hex characters a pairing link carries. The rule is `ace-keys`',
    /// the same one the client's `valid_fingerprint` applies before a handshake.
    pub fn parse(fingerprint: &str) -> Result<Self, TransportError> {
        ace_keys::parse_fingerprint(fingerprint)
            .map(Self)
            .ok_or(TransportError::Identity("Invalid public-key fingerprint"))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The certificate's key fingerprint, as `X509Certificate.publicKey.export` hashes it.
    pub fn of_certificate(certificate: &CertificateDer<'_>) -> Option<Self> {
        let parsed = ParsedCertificate::try_from(certificate).ok()?;
        Some(Self(
            Sha256::digest(parsed.subject_public_key_info().as_ref()).into(),
        ))
    }
}

/// Whether a certificate is inside its own validity window, in milliseconds as Node reads them.
pub fn validity_error(not_before_ms: i64, not_after_ms: i64, now_ms: i64) -> Option<&'static str> {
    (now_ms < not_before_ms || now_ms >= not_after_ms).then_some(PIN_EXPIRED)
}

/// The names whose publicly trusted certificate may stand in for the pin (a ts.net host).
pub type TrustedNames = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// A verifier that accepts one pinned key, or a trusted ts.net name's own certificate.
pub struct PinnedVerifier {
    pin: Pin,
    algorithms: WebPkiSupportedAlgorithms,
    /// The system's verifier, for a trusted name that presents a public certificate.
    public: Option<Arc<WebPkiServerVerifier>>,
    trusted: Option<TrustedNames>,
}

impl fmt::Debug for PinnedVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PinnedVerifier")
    }
}

impl PinnedVerifier {
    /// A verifier for exactly `pin`.
    pub fn new(pin: Pin, provider: &Arc<CryptoProvider>) -> Self {
        Self {
            pin,
            algorithms: provider.signature_verification_algorithms,
            public: None,
            trusted: None,
        }
    }

    /// Let `trusted` names present the public certificate the system's roots accept. A store
    /// that loads no certificate leaves the pin alone, which refuses them.
    pub fn trust_public_names(
        mut self,
        provider: &Arc<CryptoProvider>,
        trusted: TrustedNames,
    ) -> Self {
        let loaded = rustls_native_certs::load_native_certs();
        let mut roots = RootCertStore::empty();
        for certificate in loaded.certs {
            let _ = roots.add(certificate);
        }
        self.public =
            WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::clone(provider))
                .build()
                .ok();
        self.trusted = Some(trusted);
        self
    }

    pub fn pin(&self) -> &Pin {
        &self.pin
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let Some(presented) = Pin::of_certificate(end_entity) else {
            return Err(Error::General(PIN_FAILED.to_owned()));
        };
        if presented == self.pin {
            // Node reads the certificate's own dates; rustls hands the handshake's clock.
            let (_, certificate) = x509_parser::parse_x509_certificate(end_entity.as_ref())
                .map_err(|_| Error::General(PIN_FAILED.to_owned()))?;
            let validity = certificate.validity();
            let not_before = validity.not_before.timestamp().saturating_mul(1_000);
            let not_after = validity.not_after.timestamp().saturating_mul(1_000);
            let now_ms = i64::try_from(now.as_secs())
                .unwrap_or(i64::MAX)
                .saturating_mul(1_000);
            if let Some(message) = validity_error(not_before, not_after, now_ms) {
                return Err(Error::General(message.to_owned()));
            }
            return Ok(ServerCertVerified::assertion());
        }
        // A ts.net name may present the certificate Tailscale issues for it, which rotates its
        // key on renewal: only the system's roots and that exact name can accept it.
        if let (Some(public), Some(trusted)) = (&self.public, &self.trusted)
            && trusted(server_name.to_str().as_ref())
        {
            return public.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            );
        }
        Err(Error::General(PIN_MISMATCH.to_owned()))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls12_signature(message, certificate, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls13_signature(message, certificate, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    //! The pin's decisions, including the handshake `tls-identity-node.process.test.ts` makes on
    //! Windows through `pinnedAgent`: a client that accepts exactly the server's key.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::Arc;

    use rustls::ClientConfig;
    use rustls::client::danger::ServerCertVerifier;

    use super::{PIN_EXPIRED, Pin, PinnedVerifier, TrustedNames, validity_error};
    use crate::tls::identity::TlsIdentity;
    use crate::tls::tests::{client, rsa};

    fn provider() -> Arc<rustls::crypto::CryptoProvider> {
        Arc::new(rustls::crypto::aws_lc_rs::default_provider())
    }

    fn client_config(verifier: Arc<PinnedVerifier>) -> Arc<ClientConfig> {
        let mut config = ClientConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(config)
    }

    async fn handshake(pin: Pin) -> Result<(), String> {
        let identity: TlsIdentity = rsa();
        let resolver = Arc::new(crate::tls::SniResolver::new(identity));
        let configs = Arc::new(crate::tls::Configs::new(
            Arc::new(
                crate::tls::server_config_preferring_hybrid(provider(), Arc::clone(&resolver))
                    .unwrap(),
            ),
            Arc::new(crate::tls::server_config(provider(), resolver).unwrap()),
        ));
        let (addr, task) = client::endpoint(configs).await;
        let verifier = Arc::new(PinnedVerifier::new(pin, &provider()));
        let result = client::connect(addr, client_config(verifier), "localhost").await;
        let _ = task.await;
        result.map(|_| ()).map_err(|error| error.to_string())
    }

    #[tokio::test]
    async fn a_client_that_pins_the_servers_key_completes_the_handshake() {
        let identity = rsa();
        let certificate = identity.key().cert.first().cloned().unwrap();
        let pin = Pin::of_certificate(&certificate).expect("the fixture's key");
        handshake(pin).await.expect("the pinned handshake");
    }

    #[tokio::test]
    async fn a_client_pinning_another_key_is_refused_with_the_ts_text() {
        let wrong = Pin::parse(&"b".repeat(64)).unwrap();
        let error = handshake(wrong).await.unwrap_err();
        assert!(error.contains(super::PIN_MISMATCH), "{error}");
    }

    #[test]
    fn a_pin_is_sixty_four_lowercase_hex_characters() {
        assert!(Pin::parse(&"a".repeat(64)).is_ok());
        assert!(Pin::parse(&"A".repeat(64)).is_err());
        assert!(Pin::parse(&"a".repeat(63)).is_err());
        assert_eq!(
            Pin::parse("nope").unwrap_err().to_string(),
            "TLS identity: Invalid public-key fingerprint"
        );
    }

    #[test]
    fn a_pinned_certificate_is_inside_its_validity_window() {
        assert_eq!(validity_error(1_000, 2_000, 1_500), None);
        assert_eq!(validity_error(1_000, 2_000, 999), Some(PIN_EXPIRED));
        assert_eq!(validity_error(1_000, 2_000, 2_000), Some(PIN_EXPIRED));
    }

    #[test]
    fn a_trusted_name_gets_the_system_verifier_but_a_pinned_key_alone_does_not() {
        let trusted: TrustedNames = Arc::new(|name: &str| name.ends_with(".ts.net"));
        let verifier = PinnedVerifier::new(Pin::parse(&"a".repeat(64)).unwrap(), &provider())
            .trust_public_names(&provider(), trusted);
        // The fixture is self-signed, so the system roots cannot vouch for it: the pin stands.
        let identity = rsa();
        let certificate = identity.key().cert.first().cloned().unwrap();
        let verify = |name: &str| {
            verifier.verify_server_cert(
                &certificate,
                &[],
                &rustls::pki_types::ServerName::try_from(name).unwrap(),
                &[],
                rustls::pki_types::UnixTime::now(),
            )
        };
        // A name the predicate refuses stays on the pin, so the mismatch is the answer.
        let refused = verify("example.com").unwrap_err();
        assert!(
            format!("{refused}").contains(super::PIN_MISMATCH),
            "{refused}"
        );
        // A ts.net name reaches the system verifier, which the self-signed fixture cannot pass.
        let trusted_error = verify("mac.tailnet.ts.net").unwrap_err();
        assert!(
            !format!("{trusted_error}").contains(super::PIN_MISMATCH),
            "{trusted_error}"
        );
    }
}
