// SPDX-License-Identifier: Apache-2.0
//! `Number(text)`: what JavaScript's `Number()` accepts and how it reads it.
//!
//! The providers commands (`ace model list --limit`) and their TypeScript twins agree through
//! this one function, so the next group reuses it instead of copying it.

/// What `Number(text)` returns: decimal, hex (`0x`), binary (`0b`), octal (`0o`),
/// `Infinity` and empty-as-zero, or `NaN` for anything else.
#[must_use]
pub fn js_number(text: &str) -> f64 {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
    if trimmed.is_empty() {
        return 0.0;
    }
    if let Some(digits) = prefixed_digits(trimmed, "0x", "0X", |b: u8| b.is_ascii_hexdigit()) {
        return prefixed_value(digits, 16);
    }
    if let Some(digits) = prefixed_digits(trimmed, "0b", "0B", |b| b == b'0' || b == b'1') {
        return prefixed_value(digits, 2);
    }
    if let Some(digits) = prefixed_digits(trimmed, "0o", "0O", |b| matches!(b, b'0'..=b'7')) {
        return prefixed_value(digits, 8);
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
    if !valid_decimal(rest) {
        return f64::NAN;
    }
    let value: f64 = rest.parse().unwrap_or(f64::NAN);
    if negative { -value } else { value }
}

/// The digits after a `0x`/`0b`/`0o` prefix (no sign allowed), or `None`.
fn prefixed_digits<'a>(
    text: &'a str,
    lower: &str,
    upper: &str,
    is_digit: impl Fn(u8) -> bool,
) -> Option<&'a str> {
    let digits = text
        .strip_prefix(lower)
        .or_else(|| text.strip_prefix(upper))?;
    if digits.is_empty() || !digits.bytes().all(is_digit) {
        return None;
    }
    Some(digits)
}

/// An unsigned digit string's value: exact while it fits, then floating.
fn prefixed_value(digits: &str, radix: u32) -> f64 {
    let bytes = digits.as_bytes();
    let mut exact: u128 = 0;
    let mut index = 0;
    while index < bytes.len() {
        let digit = u128::from(match bytes[index] {
            b'0'..=b'9' => bytes[index] - b'0',
            b'a'..=b'f' => bytes[index] - b'a' + 10,
            b'A'..=b'F' => bytes[index] - b'A' + 10,
            _ => return f64::NAN,
        });
        match exact
            .checked_mul(u128::from(radix))
            .and_then(|n| n.checked_add(digit))
        {
            Some(next) => {
                exact = next;
                index += 1;
            }
            None => break,
        }
    }
    if index == bytes.len() {
        // One rounding, as `Number()` converts the exact integer once.
        #[allow(clippy::cast_precision_loss)]
        return exact as f64;
    }
    // Beyond 128 bits the value only needs float precision from here on.
    #[allow(clippy::cast_precision_loss)]
    let mut value = exact as f64;
    while index < bytes.len() {
        let digit = f64::from(match bytes[index] {
            b'0'..=b'9' => bytes[index] - b'0',
            b'a'..=b'f' => bytes[index] - b'a' + 10,
            b'A'..=b'F' => bytes[index] - b'A' + 10,
            _ => return f64::NAN,
        });
        value = value.mul_add(f64::from(radix), digit);
        index += 1;
    }
    value
}

/// A decimal literal with an optional fraction and exponent, fully consumed.
fn valid_decimal(text: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::js_number;

    fn same(actual: f64, expected: f64) -> bool {
        if expected.is_nan() {
            return actual.is_nan();
        }
        actual.to_bits() == expected.to_bits()
    }

    #[test]
    fn reads_what_javascript_reads() {
        let cases: &[(&str, f64)] = &[
            ("0x10", 16.0),
            ("0X10", 16.0),
            ("-0x10", f64::NAN),
            ("+0x10", f64::NAN),
            ("0x", f64::NAN),
            ("0xG1", f64::NAN),
            ("0b101", 5.0),
            ("0B11", 3.0),
            ("-0b1", f64::NAN),
            ("0b2", f64::NAN),
            ("0b", f64::NAN),
            ("0o17", 15.0),
            ("0O7", 7.0),
            ("-0o7", f64::NAN),
            ("0o8", f64::NAN),
            ("0o", f64::NAN),
            ("0d5", f64::NAN),
            ("00", 0.0),
            ("010", 10.0),
            ("08", 8.0),
            ("007", 7.0),
            ("1e2", 100.0),
            ("1E2", 100.0),
            ("1e+2", 100.0),
            ("1e-2", 0.01),
            (".5", 0.5),
            ("5.", 5.0),
            (".", f64::NAN),
            ("e5", f64::NAN),
            ("5e", f64::NAN),
            ("5e+", f64::NAN),
            ("1_0", f64::NAN),
            ("12px", f64::NAN),
            ("0x10p2", f64::NAN),
            ("0b12", f64::NAN),
            ("0o89", f64::NAN),
            (" ", 0.0),
            ("", 0.0),
            ("  3 ", 3.0),
            ("+", f64::NAN),
            ("-", f64::NAN),
            ("++1", f64::NAN),
            ("--1", f64::NAN),
            ("+-1", f64::NAN),
            ("Infinity", f64::INFINITY),
            ("+Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("infinity", f64::NAN),
            ("inf", f64::NAN),
            ("NaN", f64::NAN),
            ("0x1000000000000081", 1_152_921_504_606_847_200.0),
            ("1e999", f64::INFINITY),
            ("0e-999", 0.0),
            (" 0x10 ", 16.0),
            ("3", 3.0),
            (" 3", 3.0),
            ("abc", f64::NAN),
            ("3.5", 3.5),
            ("-0", -0.0),
        ];
        for (text, expected) in cases {
            assert!(
                same(js_number(text), *expected),
                "{text:?}: got {}, want {expected}",
                js_number(text),
            );
        }
    }
}
