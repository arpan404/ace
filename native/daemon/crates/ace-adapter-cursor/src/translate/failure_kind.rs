// SPDX-License-Identifier: Apache-2.0
//! How a failed Cursor run is classified (`failure-kind.ts`). Only the SDK's
//! own `rate_limit` code is a usage limit; out-of-usage prose stays a failed
//! turn that holds nothing.

use super::json::{J, is_low, units_eq};

/// A classified failure: its kind and, when the SDK names one, its code.
pub struct Failure {
    pub kind: &'static str,
    pub code: Option<Vec<u16>>,
}

fn is_word_unit(unit: u16) -> bool {
    unit < 0x80 && ((unit as u8).is_ascii_alphanumeric() || unit == u16::from(b'_'))
}

/// Lowercase the units, pairing surrogates first so casing matches the
/// TypeScript's `toLowerCase`.
fn lower(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut index = 0;
    while let Some(unit) = units.get(index) {
        let unit = *unit;
        if super::json::is_high(unit)
            && let Some(next) = units.get(index + 1)
            && is_low(*next)
        {
            let high = u32::from(unit - 0xd800);
            let low = u32::from(*next - 0xdc00);
            if let Some(c) = char::from_u32(0x10000 + high * 0x400 + low) {
                let mut pair = [0u16; 2];
                for c in c.to_lowercase() {
                    out.extend_from_slice(c.encode_utf16(&mut pair));
                }
                index += 2;
                continue;
            }
            out.push(unit);
            index += 1;
            continue;
        }
        if is_low(unit) {
            out.push(unit);
        } else if let Some(c) = char::from_u32(u32::from(unit)) {
            let mut pair = [0u16; 2];
            for c in c.to_lowercase() {
                out.extend_from_slice(c.encode_utf16(&mut pair));
            }
        } else {
            out.push(unit);
        }
        index += 1;
    }
    out
}

/// Case-insensitive phrase search with word boundaries, as the `\b` anchors do.
fn find_phrase(text: &[u16], phrase: &str) -> bool {
    let needle: Vec<u16> = phrase.encode_utf16().collect();
    if needle.is_empty() {
        return false;
    }
    let mut start = 0;
    while start + needle.len() <= text.len() {
        if text[start..start + needle.len()] == needle
            && (start == 0 || !is_word_unit(text[start - 1]))
            && (start + needle.len() >= text.len() || !is_word_unit(text[start + needle.len()]))
        {
            return true;
        }
        start += 1;
    }
    false
}

fn hit_limit(text: &[u16]) -> bool {
    let hit: Vec<u16> = "hit your ".encode_utf16().collect();
    let limit: Vec<u16> = " limit".encode_utf16().collect();
    let mut start = 0;
    while start + hit.len() <= text.len() {
        if text[start..start + hit.len()] == hit && (start == 0 || !is_word_unit(text[start - 1])) {
            let mut end = start + hit.len();
            while end < text.len() && (is_word_unit(text[end]) || text[end] == u16::from(b'-')) {
                end += 1;
            }
            if end > start + hit.len()
                && end + limit.len() <= text.len()
                && text[end..end + limit.len()] == limit
                && (end + limit.len() >= text.len() || !is_word_unit(text[end + limit.len()]))
            {
                return true;
            }
            start += 1;
            continue;
        }
        start += 1;
    }
    false
}

/// Classify a failed run from the SDK's code and its message.
pub fn cursor_failure(code: &J, message: &[u16], retryable: &J) -> Failure {
    if matches!(code, J::Str(units) if units_eq(units, "auth")) {
        return Failure {
            kind: "auth",
            code: None,
        };
    }
    if matches!(code, J::Str(units) if units_eq(units, "rate_limit")) {
        return if matches!(retryable, J::Bool(true)) {
            Failure {
                kind: "provider",
                code: Some("rate_limited".encode_utf16().collect()),
            }
        } else {
            Failure {
                kind: "quota",
                code: None,
            }
        };
    }
    if matches!(code, J::Str(units) if units_eq(units, "network")) {
        return Failure {
            kind: "network",
            code: None,
        };
    }
    let lower = lower(message);
    if find_phrase(&lower, "out of usage")
        || find_phrase(&lower, "usage limit")
        || hit_limit(&lower)
    {
        let suggests_model = find_phrase(&lower, "switch to auto")
            || find_phrase(&lower, "another model")
            || find_phrase(&lower, "a different model");
        return Failure {
            kind: "provider",
            code: Some(
                if suggests_model {
                    "model_quota"
                } else {
                    "usage_limit"
                }
                .encode_utf16()
                .collect(),
            ),
        };
    }
    Failure {
        kind: "provider",
        code: None,
    }
}
