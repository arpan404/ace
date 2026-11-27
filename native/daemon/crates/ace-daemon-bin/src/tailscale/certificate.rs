// SPDX-License-Identifier: Apache-2.0
//! The certificate checks `tailscale-certificate.ts` makes: the chain and key split
//! out of the CLI's output, the leaf's names, its validity, and its key.

use ace_transport::tls::identity::{pem_certificate, tlv};

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

/// `certificate.checkHost(name)` and its validity window, in memory
/// (`tailscale-certificate.ts:34`–`:42`): the leaf must name `name`, be valid now,
/// and (checked by the caller) match its key.
pub(super) fn host_checked(chain: &str, name: &str, now_ms: u64) -> bool {
    let Some(der) = leaf_der(chain) else {
        return false;
    };
    if !names(&der)
        .iter()
        .any(|candidate| host_matches(candidate, name))
    {
        return false;
    }
    valid_at(&der, now_ms)
}

/// `now < validTo` and `now >= validFrom`, from the certificate's validity.
fn valid_at(der: &[u8], now_ms: u64) -> bool {
    validity(der).is_some_and(|(from, until)| now_ms >= from && now_ms < until)
}

pub(super) fn valid_until(chain: &str) -> Option<u64> {
    validity(&leaf_der(chain)?).map(|(_, until)| until)
}

/// The validity SEQUENCE's two times, in epoch milliseconds.
fn validity(der: &[u8]) -> Option<(u64, u64)> {
    let (tag, value, _) = tlv(der)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, tbs, _) = tlv(value)?;
    if tag != 0x30 {
        return None;
    }
    let mut rest = tbs;
    let (tag, _, after) = tlv(rest)?;
    if tag == 0xa0 {
        rest = after;
    }
    // serial, signature, issuer, then validity.
    for _ in 0..3 {
        let (_, _, after) = tlv(rest)?;
        rest = after;
    }
    let (tag, times, _) = tlv(rest)?;
    if tag != 0x30 {
        return None;
    }
    let (first_tag, first, after) = tlv(times)?;
    let (second_tag, second, _) = tlv(after)?;
    Some((
        time_value(first_tag, first)?,
        time_value(second_tag, second)?,
    ))
}

/// UTCTime (`YYMMDDHHMMSSZ`) or GeneralizedTime (`YYYYMMDDHHMMSSZ`), to epoch ms.
fn time_value(tag: u8, text: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(text).ok()?.strip_suffix('Z')?;
    let (year, rest) = match (tag, text.len()) {
        (0x17, 12) => {
            let year: i64 = text.get(..2)?.parse().ok()?;
            // RFC 5280: 50–99 is 1950–1999, 00–49 is 2000–2049.
            (
                if year >= 50 { 1900 + year } else { 2000 + year },
                text.get(2..)?,
            )
        }
        (0x18, 14) => (text.get(..4)?.parse().ok()?, text.get(4..)?),
        _ => return None,
    };
    let month: u32 = rest.get(0..2)?.parse().ok()?;
    let day: u32 = rest.get(2..4)?.parse().ok()?;
    let hour: u64 = rest.get(4..6)?.parse().ok()?;
    let minute: u64 = rest.get(6..8)?.parse().ok()?;
    let second: u64 = rest.get(8..10)?.parse().ok()?;
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    Some(days as u64 * 86_400_000 + (hour * 3600 + minute * 60 + second) * 1000)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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
    pem_certificate(chain.as_bytes())
}
