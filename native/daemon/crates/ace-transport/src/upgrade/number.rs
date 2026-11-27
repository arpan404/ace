// SPDX-License-Identifier: Apache-2.0
//! JavaScript's `Number(text)`, the coercion `ws` applies to
//! `Sec-WebSocket-Version` with unary `+`. The rules restate `native/cli`'s
//! `cli-parse` `js_number` (T1a.3 does not depend on the CLI crate).

/// What `Number(text)` returns: decimal, unsigned hex/binary/octal,
/// `Infinity`, and empty-as-zero, or `NaN` for anything else.
pub(super) fn js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    if trimmed.is_empty() {
        return 0.0;
    }
    if let Some(value) = unsigned_radix(trimmed) {
        return value;
    }
    let (negative, rest) = match trimmed.as_bytes().first() {
        Some(b'+') => (false, &trimmed[1..]),
        Some(b'-') => (true, &trimmed[1..]),
        _ => (false, trimmed),
    };
    if rest == "Infinity" {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if !decimal_literal(rest) {
        return f64::NAN;
    }
    let value = rest.parse::<f64>().unwrap_or(f64::NAN);
    if negative { -value } else { value }
}

/// An unsigned `0x`/`0o`/`0b` literal. `Number()` rejects a sign before one,
/// so `"+0xd"` is `NaN`.
fn unsigned_radix(text: &str) -> Option<f64> {
    let (digits, radix) = prefixed(text, "0x", "0X", 16)
        .or_else(|| prefixed(text, "0o", "0O", 8))
        .or_else(|| prefixed(text, "0b", "0B", 2))?;
    if digits.is_empty() || !digits.bytes().all(|byte| char::from(byte).is_digit(radix)) {
        return None;
    }
    Some(radix_value(digits, radix))
}

fn prefixed<'a>(text: &'a str, lower: &str, upper: &str, radix: u32) -> Option<(&'a str, u32)> {
    let digits = text
        .strip_prefix(lower)
        .or_else(|| text.strip_prefix(upper))?;
    Some((digits, radix))
}

/// An unsigned digit string's value: exact while it fits, then floating.
fn radix_value(digits: &str, radix: u32) -> f64 {
    let bytes = digits.as_bytes();
    let mut exact: u128 = 0;
    let mut index = 0;
    while index < bytes.len() {
        let Some(digit) = char::from(bytes[index]).to_digit(radix) else {
            return f64::NAN;
        };
        let Some(next) = exact
            .checked_mul(u128::from(radix))
            .and_then(|value| value.checked_add(u128::from(digit)))
        else {
            break;
        };
        exact = next;
        index += 1;
    }
    // One rounding, as `Number()` converts the exact integer once; beyond 128
    // bits the rest only needs float precision.
    let mut value = exact as f64;
    while index < bytes.len() {
        let Some(digit) = char::from(bytes[index]).to_digit(radix) else {
            return f64::NAN;
        };
        value = value.mul_add(f64::from(radix), f64::from(digit));
        index += 1;
    }
    value
}

/// A decimal literal with an optional fraction and exponent, fully consumed.
fn decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    let mut digits = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
        digits += 1;
    }
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        index += 1;
        if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    index == bytes.len()
}
