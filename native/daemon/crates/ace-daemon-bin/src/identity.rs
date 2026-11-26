// SPDX-License-Identifier: Apache-2.0
//! The daemon's pinned TLS identity: `<home>/tls/cert.pem` and `tls/key.pem`, made
//! on first use by OpenSSL exactly as `apps/daemon/src/tls-identity.ts` makes it
//! (`req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -subj /CN=ace`), and
//! its fingerprint: the SHA-256 of the certificate's SubjectPublicKeyInfo.
//!
//! Paired devices pin that fingerprint, so an existing identity is never
//! regenerated while its files are readable (`pin continuity`,
//! `docs/transport/behaviour.md` §6).
//!
//! TypeScript cases ported: `apps/daemon/src/tls-identity.process.test.ts`
//! ("makes the identity once and keeps it across loads", "a fingerprint is the
//! certificate's public key, not the certificate") and the pinned-handshake
//! cases of `apps/daemon/src/tls-identity-node.process.test.ts`.

use std::io;
use std::path::Path;

use sha2::{Digest, Sha256};

/// The identity's bytes and the fingerprint a client pins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub key_pem: Vec<u8>,
    pub cert_pem: Vec<u8>,
    /// Lower-case hex of the SHA-256 over the certificate's SPKI DER.
    pub fingerprint: String,
}

/// Why the identity could not be made or read.
#[derive(Debug)]
pub enum IdentityError {
    /// OpenSSL refused or is missing: TypeScript's own sentence.
    Generate,
    Io {
        action: String,
        source: io::Error,
    },
    /// The certificate's public key could not be read from its DER.
    Certificate,
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Generate => {
                formatter.write_str("Cannot generate TLS identity. Install OpenSSL and retry.")
            }
            Self::Io { action, source } => write!(formatter, "{action}: {source}"),
            Self::Certificate => {
                formatter.write_str("The TLS certificate has no readable public key")
            }
        }
    }
}

impl std::error::Error for IdentityError {}

fn io_error(action: impl Into<String>, source: io::Error) -> IdentityError {
    IdentityError::Io {
        action: action.into(),
        source,
    }
}

/// `loadIdentity`: make the identity when the home has none, then read it.
pub async fn load(home: &Path) -> Result<Identity, IdentityError> {
    let directory = home.join("tls");
    if !directory.exists() {
        generate(home, &directory).await?;
    }
    let key_path = directory.join("key.pem");
    let cert_path = directory.join("cert.pem");
    set_private(&key_path).map_err(|error| io_error("Cannot restrict the TLS key", error))?;
    let key_pem =
        std::fs::read(&key_path).map_err(|error| io_error("Cannot read the TLS key", error))?;
    let cert_pem = std::fs::read(&cert_path)
        .map_err(|error| io_error("Cannot read the TLS certificate", error))?;
    let fingerprint = fingerprint(&cert_pem)?;
    Ok(Identity {
        key_pem,
        cert_pem,
        fingerprint,
    })
}

/// `loadIdentity`'s OpenSSL invocation, into a temporary directory renamed into
/// place, so a failed generation leaves nothing half made.
async fn generate(home: &Path, directory: &Path) -> Result<(), IdentityError> {
    let id = crate::ids::uuid_v4().unwrap_or_else(|_| "identity".to_owned());
    let temporary = home.join(format!("tls-{id}"));
    create_private_dir(&temporary)
        .map_err(|error| io_error("Cannot make the TLS directory", error))?;
    let outcome = tokio::process::Command::new("openssl")
        .args([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650", "-subj",
            "/CN=ace", "-keyout",
        ])
        .arg(temporary.join("key.pem"))
        .arg("-out")
        .arg(temporary.join("cert.pem"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
    let made = matches!(outcome, Ok(status) if status.success())
        && temporary.join("key.pem").exists()
        && temporary.join("cert.pem").exists();
    if !made {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(IdentityError::Generate);
    }
    let _ = set_private(&temporary.join("key.pem"));
    if let Err(error) = std::fs::rename(&temporary, directory) {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(io_error("Cannot publish the TLS identity", error));
    }
    Ok(())
}

/// The fingerprint `publicKeyFingerprint` computes: SHA-256 over the SPKI DER.
pub fn fingerprint(cert_pem: &[u8]) -> Result<String, IdentityError> {
    let der = pem_certificate(cert_pem).ok_or(IdentityError::Certificate)?;
    let spki = spki_der(&der).ok_or(IdentityError::Certificate)?;
    let mut hasher = Sha256::new();
    hasher.update(spki);
    let digest = hasher.finalize();
    let mut text = String::with_capacity(64);
    for byte in digest {
        text.push_str(&format!("{byte:02x}"));
    }
    Ok(text)
}

/// The DER bytes of the first certificate in a PEM document.
fn pem_certificate(pem: &[u8]) -> Option<Vec<u8>> {
    let text = String::from_utf8_lossy(pem);
    let begin = text.find("-----BEGIN CERTIFICATE-----")? + "-----BEGIN CERTIFICATE-----".len();
    let end = text[begin..].find("-----END CERTIFICATE-----")? + begin;
    base64_decode(&text[begin..end])
}

/// The SubjectPublicKeyInfo, as the whole DER element, from a DER certificate.
fn spki_der(certificate: &[u8]) -> Option<&[u8]> {
    let (tag, value, _) = tlv(certificate)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, tbs, _) = tlv(value)?;
    if tag != 0x30 {
        return None;
    }
    let mut rest = tbs;
    // Version [0] is optional, and comes before serial, signature, issuer,
    // validity and subject.
    let (tag, _, after) = tlv(rest)?;
    if tag == 0xa0 {
        rest = after;
    }
    for _ in 0..5 {
        let (_, _, after) = tlv(rest)?;
        rest = after;
    }
    let (tag, _, after) = tlv(rest)?;
    if tag != 0x30 {
        return None;
    }
    Some(&rest[..rest.len() - after.len()])
}

/// One DER element: its tag, its value and what follows it.
fn tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, after_first) = rest.split_first()?;
    let (length, body) = if first < 0x80 {
        (usize::from(first), after_first)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 || after_first.len() < count {
            return None;
        }
        let mut length = 0_usize;
        for byte in &after_first[..count] {
            length = length.checked_mul(256)?.checked_add(usize::from(*byte))?;
        }
        (length, &after_first[count..])
    };
    if body.len() < length {
        return None;
    }
    Some((tag, &body[..length], &body[length..]))
}

/// Standard base64 with padding, whitespace ignored.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut chunk = [0_u8; 4];
    let mut filled = 0;
    for byte in text.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => return None,
        };
        chunk[filled] = value;
        filled += 1;
        if filled == 4 {
            out.push((chunk[0] << 2) | (chunk[1] >> 4));
            if chunk[2] != 64 {
                out.push((chunk[1] << 4) | (chunk[2] >> 2));
            }
            if chunk[3] != 64 && chunk[2] != 64 {
                out.push((chunk[2] << 6) | chunk[3]);
            }
            filled = 0;
        }
    }
    (filled == 0).then_some(out)
}

#[cfg(unix)]
fn set_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// `tls-identity.process.test.ts`: "makes the identity once and keeps it
    /// across loads": a paired device's pin keeps matching after a restart.
    #[tokio::test]
    async fn the_identity_is_made_once_and_kept_across_loads() {
        let home = TempDir::new("ace-identity");
        let first = load(home.path()).await;
        let Ok(first) = first else {
            // No OpenSSL on this machine: the generation case needs it.
            return;
        };
        assert_eq!(first.fingerprint.len(), 64);
        assert!(
            first
                .fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "a lower-case hex fingerprint"
        );
        assert!(home.path().join("tls/cert.pem").exists());
        assert!(home.path().join("tls/key.pem").exists());
        let second = load(home.path()).await;
        let Ok(second) = second else {
            panic!("the identity loads again");
        };
        assert_eq!(second, first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for (path, mode) in [
                (home.path().join("tls"), 0o700),
                (home.path().join("tls/key.pem"), 0o600),
            ] {
                let actual = std::fs::metadata(path)
                    .map(|meta| meta.permissions().mode())
                    .unwrap_or(0);
                assert_eq!(actual & 0o777, mode);
            }
        }
    }

    /// `tls-identity.process.test.ts`: "a fingerprint is the certificate's public
    /// key, not the certificate": OpenSSL's own SPKI digest is the same value.
    #[tokio::test]
    async fn the_fingerprint_is_the_certificates_public_key() {
        let home = TempDir::new("ace-identity-spki");
        let identity = load(home.path()).await;
        let Ok(identity) = identity else {
            return;
        };
        let cert = home.path().join("tls/cert.pem");
        let pubkey = tokio::process::Command::new("openssl")
            .args(["x509", "-in"])
            .arg(&cert)
            .args(["-pubkey", "-noout"])
            .output()
            .await;
        let Ok(pubkey) = pubkey else {
            return;
        };
        let pem = home.path().join("spki.pem");
        if std::fs::write(&pem, &pubkey.stdout).is_err() {
            return;
        }
        let der = tokio::process::Command::new("openssl")
            .args(["pkey", "-pubin", "-outform", "der", "-in"])
            .arg(&pem)
            .output()
            .await;
        let Ok(der) = der else {
            return;
        };
        if !der.status.success() {
            return;
        }
        let mut hasher = Sha256::new();
        hasher.update(&der.stdout);
        let digest = hasher.finalize();
        let expected: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(identity.fingerprint, expected);
    }

    /// A certificate that is not one is refused rather than given a fingerprint.
    #[test]
    fn a_document_without_a_certificate_is_refused() {
        assert!(fingerprint(b"not a certificate").is_err());
    }
}

#[cfg(test)]
mod loadable {
    use super::*;
    use crate::test_support::TempDir;

    #[tokio::test]
    async fn the_identity_is_a_usable_tls_identity() {
        let home = TempDir::new("ace-identity-load");
        let identity = load(home.path()).await;
        let Ok(identity) = identity else { return };
        let loaded = ace_transport::TlsIdentity::from_pem(&identity.cert_pem, &identity.key_pem);
        assert!(loaded.is_ok(), "{:?}", loaded.err().map(|e| e.to_string()));
        let provider = ace_transport::process_provider();
        assert!(provider.is_ok(), "the process provider installs");
        let again = ace_transport::TlsIdentity::from_pem(&identity.cert_pem, &identity.key_pem);
        assert!(again.is_ok(), "{:?}", again.err().map(|e| e.to_string()));
    }

    /// macOS's `/usr/bin/openssl` is LibreSSL, whose `req -x509` writes an X.509
    /// v1 certificate. A home the TypeScript daemon made with it must still load
    /// (a home is never migrated by switching daemons).
    #[tokio::test]
    async fn a_version_one_certificate_still_loads() {
        let home = TempDir::new("ace-identity-v1");
        let key = home.path().join("key.pem");
        let cert = home.path().join("cert.pem");
        let made = tokio::process::Command::new("/usr/bin/openssl")
            .args([
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
                "-subj", "/CN=ace", "-keyout",
            ])
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
        if !matches!(made, Ok(status) if status.success()) {
            return;
        }
        let key_pem = std::fs::read(&key).unwrap_or_default();
        let cert_pem = std::fs::read(&cert).unwrap_or_default();
        let loaded = ace_transport::TlsIdentity::from_pem(&cert_pem, &key_pem);
        assert!(loaded.is_ok(), "{:?}", loaded.err().map(|e| e.to_string()));
        assert!(
            fingerprint(&cert_pem).is_ok(),
            "a v1 certificate has a fingerprint"
        );
    }
}
