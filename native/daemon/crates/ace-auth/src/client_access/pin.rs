// SPDX-License-Identifier: Apache-2.0
//! The pin rules the daemon's TLS connector applies (`client-access.ts:87`-`:140`, `:250`-`:280`):
//! the fingerprint shape, the verdict a presented certificate gets, the bare WSS origin a ticket
//! socket needs, and the close a rejected pin sends.

use url::Url;

use super::ClientError;

/// How long a pinned handshake may take (`client-access.ts:118`).
pub const HANDSHAKE_TIMEOUT_MS: i64 = 10_000;
/// The failure a handshake past that deadline shows (`client-access.ts:118`).
pub const HANDSHAKE_TIMEOUT: &str = "TLS handshake timed out";
/// The pinned socket transport closes with this code when a pin rejects (`client-access.ts:279`).
pub const PIN_REJECTED_CLOSE: u16 = 4001;

/// The pin a connector accepts: 64 lowercase hex characters, never a hostname.
pub fn valid_fingerprint(fingerprint: &str) -> bool {
    fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// What a pinned handshake found on the certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresentedCertificate {
    /// SHA-256 of the certificate's `SubjectPublicKeyInfo`, lowercase hex.
    pub fingerprint: &'static str,
    /// `Date.parse(certificate.validFrom)`, in milliseconds.
    pub valid_from: i64,
    /// `Date.parse(certificate.validTo)`, in milliseconds.
    pub valid_to: i64,
}

/// Why a pinned handshake is refused, in the TypeScript's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinRefusal {
    /// The pin isn't a fingerprint at all.
    InvalidFingerprint,
    /// The certificate's key is not the pinned one, and its name is not a trusted ts.net name.
    Mismatch,
    /// The pinned certificate is outside its validity window.
    Expired,
    /// The response failed for another reason.
    Failed,
}

impl PinRefusal {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidFingerprint => "Invalid public-key fingerprint",
            Self::Mismatch => "TLS public-key fingerprint mismatch",
            Self::Expired => "TLS certificate expired or not yet valid",
            Self::Failed => "TLS pin failed",
        }
    }

    /// Every pin refusal is an `auth` failure on the client, except the invalid pin a caller
    /// hands in, which is thrown where it is passed.
    pub fn client_error(self) -> ClientError {
        ClientError::new("auth", self.message())
    }
}

/// The pin check (`client-access.ts:121`–`:137`): the pinned key authenticates ace's own
/// certificate; a ts.net host may instead present the publicly trusted certificate Tailscale
/// issues for that exact name (ADR 0097). The validity window is checked after the pin.
pub fn pin_verdict(
    pin: &str,
    certificate: PresentedCertificate,
    trusted_name: bool,
    now: i64,
) -> Result<(), PinRefusal> {
    if !valid_fingerprint(pin) {
        return Err(PinRefusal::InvalidFingerprint);
    }
    if certificate.fingerprint != pin && !trusted_name {
        return Err(PinRefusal::Mismatch);
    }
    if now < certificate.valid_from || now >= certificate.valid_to {
        return Err(PinRefusal::Expired);
    }
    Ok(())
}

/// A ticket socket's origin: a pinned WSS origin with nothing else in it (`client-access.ts:254`).
pub fn ticket_socket_origin(origin: &str, fingerprint: &str) -> Result<String, ClientError> {
    let url = Url::parse(origin).map_err(|_| {
        ClientError::new(
            "auth",
            "Socket requires a pinned WSS origin without credentials",
        )
    })?;
    if url.scheme() != "wss"
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ClientError::new(
            "auth",
            "Socket requires a pinned WSS origin without credentials",
        ));
    }
    if !valid_fingerprint(fingerprint) {
        return Err(PinRefusal::InvalidFingerprint.client_error());
    }
    Ok(url.origin().ascii_serialization())
}

/// The code a pinned socket closes with when the pin rejects (`pinnedSocketTransport`).
pub fn pin_rejected_close(error: &ClientError) -> Option<u16> {
    (error.code == "auth").then_some(PIN_REJECTED_CLOSE)
}

#[cfg(test)]
mod tests {
    //! The pin's rules, with the refusals `client-access.ts` throws before and after a handshake.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{PinRefusal, PresentedCertificate, pin_verdict, ticket_socket_origin};
    use crate::client_access::ClientError;

    const PIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn a_pinned_certificate_must_match_and_be_inside_its_validity() {
        let certificate = PresentedCertificate {
            fingerprint: PIN,
            valid_from: 1_000,
            valid_to: 2_000,
        };
        assert_eq!(pin_verdict(PIN, certificate, false, 1_500), Ok(()));
        assert_eq!(
            pin_verdict(PIN, certificate, false, 2_000),
            Err(PinRefusal::Expired)
        );
        assert_eq!(
            pin_verdict(PIN, certificate, false, 999),
            Err(PinRefusal::Expired)
        );
        assert_eq!(
            pin_verdict(&"b".repeat(64), certificate, false, 1_500),
            Err(PinRefusal::Mismatch)
        );
        // A ts.net name may instead present Tailscale's publicly trusted certificate.
        assert_eq!(
            pin_verdict(&"b".repeat(64), certificate, true, 1_500),
            Ok(())
        );
        assert_eq!(
            pin_verdict("nope", certificate, true, 1_500),
            Err(PinRefusal::InvalidFingerprint)
        );
        assert_eq!(
            PinRefusal::Mismatch.client_error(),
            ClientError::new("auth", "TLS public-key fingerprint mismatch")
        );
    }

    #[test]
    fn a_ticket_socket_needs_a_bare_pinned_wss_origin() {
        assert_eq!(
            ticket_socket_origin("wss://host:4243/", PIN).unwrap(),
            "wss://host:4243"
        );
        for origin in [
            "ws://host/",
            "wss://host/v1",
            "wss://host/?token=1",
            "wss://owner:secret@host/",
        ] {
            assert_eq!(
                ticket_socket_origin(origin, PIN).unwrap_err().message,
                "Socket requires a pinned WSS origin without credentials"
            );
        }
        assert_eq!(
            ticket_socket_origin("wss://host/", "nope")
                .unwrap_err()
                .message,
            "Invalid public-key fingerprint"
        );
    }
}
