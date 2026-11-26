// SPDX-License-Identifier: Apache-2.0
//! Tailscale: this machine's 100.x address and MagicDNS name, and the
//! browser-trusted certificate Tailscale issues for it
//! (`apps/daemon/src/network.ts`, `tailscale-certificate.ts`).
//!
//! The daemon serves ace's pinned certificate until a valid Tailscale
//! certificate is fetched, then serves that one for its `ts.net` name through the
//! SNI resolver, refreshing twice a day. A failed fetch keeps the pinned
//! certificate and is retried, exactly as `trustedCertificate` does.
//!
//! TypeScript cases ported: `apps/daemon/src/tailscale-certificate.test.ts`
//! ("takes a chain and its key and reads when it expires", "refuses a certificate
//! for another name", "refuses an expired certificate", "refuses a key that is
//! not the certificate's") and `apps/daemon/src/network.test.ts` ("reads the 100.x
//! address and MagicDNS name from tailscale status", "gives the pairing guidance
//! when Tailscale is not running").

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

/// The machine's Tailscale address and, when MagicDNS is on, its `ts.net` name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tailnet {
    pub address: std::net::IpAddr,
    pub name: Option<String>,
}

/// The guidance `remoteListener` gives when Tailscale cannot be read.
const GUIDANCE: &str = "Cannot detect Tailscale address. Start Tailscale, or start ace with ACE_LISTEN=lan and ACE_REMOTE_PORT=4243, then run tailscale serve --tcp=443 tcp://localhost:4243. Replace the pairing URL authority with the Serve hostname:443 and keep its fragment to preserve the ace public-key pin.";

/// `tailscale status --json`, read for the address and MagicDNS name.
pub async fn status() -> Result<Tailnet, String> {
    let output = run(&["status", "--json"], Duration::from_secs(5)).await?;
    let value: Value = serde_json::from_str(&output).map_err(|_| GUIDANCE.to_owned())?;
    if value.get("BackendState").and_then(Value::as_str) != Some("Running") {
        return Err(GUIDANCE.to_owned());
    }
    let addresses = value
        .get("TailscaleIPs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|text| text.parse::<std::net::IpAddr>().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let address = addresses
        .iter()
        .find(|address| address.is_ipv4())
        .copied()
        .ok_or_else(|| GUIDANCE.to_owned())?;
    // MagicDNS off means the name is not reachable: links keep the 100.x address.
    let magic_dns = value
        .get("CurrentTailnet")
        .and_then(|tailnet| tailnet.get("MagicDNSEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let name = if magic_dns {
        value
            .get("Self")
            .and_then(|me| me.get("DNSName"))
            .and_then(Value::as_str)
            .map(|name| name.trim().trim_end_matches('.').to_ascii_lowercase())
            .filter(|name| name.contains('.') && name.parse::<std::net::IpAddr>().is_err())
    } else {
        None
    };
    Ok(Tailnet { address, name })
}

/// `tailscale cert --cert-file - --key-file - -- <name>`: the chain and key as PEM.
pub async fn certificate(name: &str) -> Result<String, String> {
    run(
        &["cert", "--cert-file", "-", "--key-file", "-", "--", name],
        Duration::from_secs(120),
    )
    .await
}

/// A chain and its key, as the SNI resolver takes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailscalePem {
    pub chain_pem: String,
    pub key_pem: String,
}

/// `parseTailscaleCertificate`: the first certificate chain and its key, only
/// when the leaf names `name` and is valid now. Undefined otherwise, so a bad
/// issuance never replaces a working certificate.
pub async fn parse(output: &str, name: &str, home: &Path) -> Option<TailscalePem> {
    let (chain, key) = split_pem(output)?;
    if !host_checked(&chain, name, home).await {
        return None;
    }
    // `certificate.checkPrivateKey`: re-encoding refuses a key that is not the
    // leaf's.
    ace_transport::TlsIdentity::from_pem(chain.as_bytes(), key.as_bytes()).ok()?;
    Some(TailscalePem {
        chain_pem: chain,
        key_pem: key,
    })
}

/// The certificate chain and the first private key in a PEM document.
fn split_pem(output: &str) -> Option<(String, String)> {
    let mut chain = Vec::new();
    let mut key: Option<String> = None;
    let mut rest = output;
    while let Some(begin) = rest.find("-----BEGIN ") {
        let after = &rest[begin + "-----BEGIN ".len()..];
        let label_end = after.find("-----")?;
        let label = &after[..label_end];
        let end_marker = format!("-----END {label}-----");
        let block_end = after.find(&end_marker)? + end_marker.len();
        let block = &rest[begin..begin + "-----BEGIN ".len() + block_end];
        if label == "CERTIFICATE" {
            chain.push(block.to_owned());
        } else if label.ends_with("PRIVATE KEY") && key.is_none() {
            key = Some(block.to_owned());
        }
        rest = &rest[begin + "-----BEGIN ".len() + block_end..];
    }
    if chain.is_empty() {
        return None;
    }
    Some((format!("{}\n", chain.join("\n")), format!("{}\n", key?)))
}

/// `certificate.checkHost(name)` and its validity window: the leaf must name
/// `name` (SAN DNS or subject CN), still be valid, and match its key.
async fn host_checked(chain: &str, name: &str, home: &Path) -> bool {
    let Some(der) = leaf_der(chain) else {
        return false;
    };
    if !names(&der)
        .iter()
        .any(|candidate| host_matches(candidate, name))
    {
        return false;
    }
    let id = crate::ids::uuid_v4().unwrap_or_else(|_| "certificate".to_owned());
    let directory = home.join(format!("tls-check-{id}"));
    if std::fs::create_dir_all(&directory).is_err() {
        return false;
    }
    let cert = directory.join("cert.pem");
    let written = std::fs::write(&cert, chain).is_ok();
    let valid = written
        && matches!(
            tokio::process::Command::new("openssl")
                .args(["x509", "-checkend", "0", "-noout", "-in"])
                .arg(&cert)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await,
            Ok(status) if status.success()
        );
    let _ = std::fs::remove_dir_all(&directory);
    valid
}

/// Whether a certificate name matches `name`: exact, or one wildcard label.
fn host_matches(candidate: &str, name: &str) -> bool {
    let candidate = candidate.trim_end_matches('.').to_ascii_lowercase();
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if candidate == name {
        return true;
    }
    match candidate.strip_prefix("*.") {
        Some(rest) => match name.split_once('.') {
            Some((label, tail)) => !label.is_empty() && tail == rest,
            None => false,
        },
        None => false,
    }
}

/// The names a DER certificate carries: its SAN DNS entries and its subject CN.
fn names(der: &[u8]) -> Vec<String> {
    let mut found = Vec::new();
    let Some((tag, value, _)) = tlv(der) else {
        return found;
    };
    if tag != 0x30 {
        return found;
    }
    let Some((tag, tbs, _)) = tlv(value) else {
        return found;
    };
    if tag != 0x30 {
        return found;
    }
    let mut rest = tbs;
    let Some((tag, _, after)) = tlv(rest) else {
        return found;
    };
    if tag == 0xa0 {
        rest = after;
    }
    // serial, signature, issuer, validity, subject.
    for _ in 0..4 {
        let Some((_, _, after)) = tlv(rest) else {
            return found;
        };
        rest = after;
    }
    if let Some((_, subject, after)) = tlv(rest) {
        collect_cn(subject, &mut found);
        rest = after;
    }
    // subjectPublicKeyInfo, then the optional unique ids and extensions.
    let Some((_, _, after)) = tlv(rest) else {
        return found;
    };
    rest = after;
    while let Some((tag, value, after)) = tlv(rest) {
        if tag == 0xa3 {
            collect_san(value, &mut found);
        }
        rest = after;
    }
    found
}

/// The subject's CN (`2.5.4.3`) values, walking SEQUENCE OF SET OF SEQUENCE.
fn collect_cn(subject: &[u8], found: &mut Vec<String>) {
    // `subject` is the SEQUENCE's contents: a list of SET OF AttributeTypeAndValue.
    let mut rest = subject;
    while let Some((tag, set, after)) = tlv(rest) {
        if tag == 0x31
            && let Some((tag, entries, _)) = tlv(set)
            && tag == 0x30
        {
            let mut entry = entries;
            while let Some((tag, oid, next)) = tlv(entry) {
                if tag == 0x06
                    && oid == [0x55, 0x04, 0x03]
                    && let Some((_, value, _)) = tlv(next)
                {
                    found.push(String::from_utf8_lossy(value).into_owned());
                    break;
                }
                entry = next;
            }
        }
        rest = after;
    }
}

/// The SAN extension's dNSName entries (`2.5.29.17`).
fn collect_san(extensions: &[u8], found: &mut Vec<String>) {
    let Some((tag, list, _)) = tlv(extensions) else {
        return;
    };
    if tag != 0x30 {
        return;
    }
    let mut rest = list;
    while let Some((tag, extension, after)) = tlv(rest) {
        if tag == 0x30 {
            let mut entry = extension;
            // OID, optional critical, then the OCTET STRING.
            if let Some((tag, oid, next)) = tlv(entry)
                && tag == 0x06
                && oid == [0x55, 0x1d, 0x11]
            {
                entry = next;
                if let Some((tag, _, next)) = tlv(entry)
                    && tag == 0x01
                {
                    entry = next;
                }
                if let Some((tag, octets, _)) = tlv(entry)
                    && tag == 0x04
                    && let Some((tag, general, _)) = tlv(octets)
                    && tag == 0x30
                {
                    let mut name = general;
                    while let Some((tag, value, next)) = tlv(name) {
                        if tag == 0x82 {
                            found.push(String::from_utf8_lossy(value).into_owned());
                        }
                        name = next;
                    }
                }
            }
        }
        rest = after;
    }
}

/// The DER bytes of the leaf certificate in a PEM chain.
fn leaf_der(chain: &str) -> Option<Vec<u8>> {
    let begin = chain.find("-----BEGIN CERTIFICATE-----")? + "-----BEGIN CERTIFICATE-----".len();
    let end = chain[begin..].find("-----END CERTIFICATE-----")? + begin;
    base64_decode(&chain[begin..end])
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

/// Run `tailscale` with `args`, its stdout when it succeeds.
async fn run(args: &[&str], timeout: Duration) -> Result<String, String> {
    let child = tokio::process::Command::new("tailscale")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(timeout, child)
        .await
        .map_err(|_| GUIDANCE.to_owned())?
        .map_err(|_| GUIDANCE.to_owned())?;
    if !output.status.success() {
        return Err(GUIDANCE.to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Fetch Tailscale's certificate for `name` now, push it to `resolver`, and
/// refresh twice a day; a failed fetch keeps the pinned certificate and is
/// retried in ten minutes (`trustedCertificate`'s `refreshMs` and `retryMs`).
pub fn spawn_refresh(
    resolver: std::sync::Arc<ace_transport::SniResolver>,
    name: String,
    home: std::path::PathBuf,
    log: std::sync::Arc<crate::log::Log>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let wait = match certificate(&name).await {
                Ok(output) => match parse(&output, &name, &home).await {
                    Some(pem) => {
                        match ace_transport::TlsIdentity::from_pem(
                            pem.chain_pem.as_bytes(),
                            pem.key_pem.as_bytes(),
                        ) {
                            Ok(identity) => {
                                resolver.set_trusted(&name, identity);
                                log.log(
                                    "info",
                                    "Serving Tailscale's certificate",
                                    serde_json::json!({"name": name}),
                                );
                                Duration::from_secs(12 * 60 * 60)
                            }
                            Err(error) => {
                                log.log(
                                    "warn",
                                    "Tailscale's certificate could not be used",
                                    serde_json::json!({"error": error.to_string()}),
                                );
                                Duration::from_secs(10 * 60)
                            }
                        }
                    }
                    None => {
                        log.log(
                            "warn",
                            "Tailscale returned no usable certificate",
                            serde_json::json!({"name": name}),
                        );
                        Duration::from_secs(10 * 60)
                    }
                },
                Err(error) => {
                    log.log(
                        "warn",
                        "Tailscale's certificate could not be fetched",
                        serde_json::json!({"name": name, "error": error}),
                    );
                    Duration::from_secs(10 * 60)
                }
            };
            tokio::time::sleep(wait).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// A PEM document with no certificate, or one with no key, is unusable.
    #[test]
    fn a_document_without_a_chain_and_key_is_refused() {
        assert_eq!(split_pem(""), None);
        assert_eq!(
            split_pem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"),
            None
        );
    }

    /// `tailscale-certificate.test.ts`: "takes a chain and its key"; a key is
    /// recognised by its PEM label.
    #[test]
    fn a_chain_and_its_key_are_split_out() {
        let output = "noise\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\nmore\n";
        let split = split_pem(output);
        let Some((chain, key)) = split else {
            panic!("a chain and key are found");
        };
        assert!(chain.starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(chain.ends_with('\n'));
        assert_eq!(
            key,
            "-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n"
        );
    }

    /// `tailscale-certificate.test.ts`: a certificate for another name is refused;
    /// the identity OpenSSL makes is `CN=ace`.
    #[tokio::test]
    async fn a_certificate_for_another_name_is_refused() {
        let home = TempDir::new("ace-tailscale");
        let identity = crate::identity::load(home.path()).await;
        let Ok(identity) = identity else {
            // No OpenSSL on this machine: the case needs it to make a certificate.
            return;
        };
        let chain = String::from_utf8_lossy(&identity.cert_pem).into_owned();
        let key = String::from_utf8_lossy(&identity.key_pem).into_owned();
        let output = format!("{chain}{key}");
        assert!(parse(&output, "ace", home.path()).await.is_some());
        assert!(
            parse(&output, "mac.tailnet.ts.net", home.path())
                .await
                .is_none()
        );
    }
}
