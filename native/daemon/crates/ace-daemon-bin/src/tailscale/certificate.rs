// SPDX-License-Identifier: Apache-2.0
//! The certificate checks `tailscale-certificate.ts` makes: the chain and key split
//! out of the CLI's output, the leaf's names, its validity, and its key.

use std::path::Path;

/// The certificate chain and the first private key in a PEM document.
pub(super) fn split_pem(output: &str) -> Option<(String, String)> {
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
pub(super) async fn host_checked(chain: &str, name: &str, home: &Path) -> bool {
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
