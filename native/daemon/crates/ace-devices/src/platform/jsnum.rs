// SPDX-License-Identifier: Apache-2.0
//! JavaScript's numbers: `Math.round` (a half towards positive infinity), `Number(text)` and
//! `Number.prototype.toString`, so a picture's coordinates and a layout's values spell what the
//! TypeScript spelled.

use ace_json::write_number;

/// `Math.round(value)`: the closest integer, a half towards positive infinity. An integer stays
/// itself (a value above 2^52 has no fraction to round), and `-0` stays `-0`.
pub fn round(value: f64) -> f64 {
    if !value.is_finite() || value.fract() == 0.0 {
        return value;
    }
    let floor = value.floor();
    let rounded = match value - floor >= 0.5 {
        true => floor + 1.0,
        false => floor,
    };
    // A negative value that rounds to zero is JavaScript's -0.
    if rounded == 0.0 && value < 0.0 {
        return -0.0;
    }
    rounded
}

/// A number in JavaScript's format: `1` for 1.0, `0` for -0, `1.5e-7` where it applies, and
/// `NaN`/`Infinity` as `String` spells them (JSON's `null` is not what a drawing says).
pub fn text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return match value > 0.0 {
            true => "Infinity".to_string(),
            false => "-Infinity".to_string(),
        };
    }
    let mut out = String::new();
    write_number(&mut out, value);
    out
}

/// `Math.round(value * 10^places) / 10^places`, in JavaScript's format.
pub fn rounded(value: f64, places: u32) -> String {
    let scale = 10f64.powi(places as i32);
    text(round(value * scale) / scale)
}

/// `Number(text)`: a string number as JavaScript reads it. Trims JavaScript's whitespace, reads
/// `0x`/`0o`/`0b` integers, `Infinity`, decimal and exponent forms, and reads anything else as
/// NaN (the empty string is 0). Only the forms a layout or an SDK file can spell are read.
pub fn parse(text: &str) -> f64 {
    let text = text.trim_matches(is_space);
    if text.is_empty() {
        return 0.0;
    }
    let (sign, rest) = match text.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, text.strip_prefix('+').unwrap_or(text)),
    };
    if rest == "Infinity" {
        return sign * f64::INFINITY;
    }
    let radix = match rest.get(..2) {
        Some("0x") | Some("0X") => Some(16),
        Some("0o") | Some("0O") => Some(8),
        Some("0b") | Some("0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        // A radix prefix is unsigned only: `-0x10` is not a number in JavaScript.
        if sign < 0.0 || text.len() != rest.len() {
            return f64::NAN;
        }
        let digits = &rest[2..];
        if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
            return f64::NAN;
        }
        return match u64::from_str_radix(digits, radix) {
            Ok(value) => value as f64,
            Err(_) => digits.chars().fold(0.0, |total, digit| {
                total * f64::from(radix) + f64::from(digit.to_digit(radix).unwrap_or(0))
            }),
        };
    }
    let (mantissa, exponent) = match rest.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (rest, None),
    };
    if let Some(exponent) = exponent
        && !valid_exponent(exponent)
    {
        return f64::NAN;
    }
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (mantissa, None),
    };
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(whole) || !fraction.is_none_or(digits) {
        return f64::NAN;
    }
    if whole.is_empty() && fraction.is_none_or(str::is_empty) {
        return f64::NAN;
    }
    sign * rest.parse::<f64>().unwrap_or(f64::NAN)
}

/// The part after `e`: an optional sign and at least one digit.
fn valid_exponent(text: &str) -> bool {
    let digits = text
        .strip_prefix('+')
        .or_else(|| text.strip_prefix('-'))
        .unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// JavaScript's whitespace (`\s`), which `Number(text)` trims: the ASCII set, the no-break space,
/// and the Unicode spaces. `\0` is not one of them.
fn is_space(character: char) -> bool {
    matches!(
        character,
        '\u{9}'
            | '\u{a}'
            | '\u{b}'
            | '\u{c}'
            | '\u{d}'
            | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_half_rounds_towards_positive_infinity_as_math_round_does() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-2.6), -3.0);
        assert_eq!(round(-0.5), -0.0);
        assert!(round(-0.5).is_sign_negative());
        assert_eq!(round(1.1), 1.0);
        // The largest double below a half must not round up: `x + 0.5` would.
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(0.5), 1.0);
        // Above 2^52 every value is an integer already.
        assert_eq!(round(4503599627370496.0), 4503599627370496.0);
        assert_eq!(round(-0.0), -0.0);
    }

    #[test]
    fn a_number_spells_what_javascript_spells() {
        assert_eq!(text(1.0), "1");
        assert_eq!(text(-0.0), "0");
        assert_eq!(text(0.1 + 0.2), "0.30000000000000004");
        // JSON writes these as null; a drawing writes what `String` writes.
        assert_eq!(text(f64::NAN), "NaN");
        assert_eq!(text(f64::INFINITY), "Infinity");
        assert_eq!(text(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn a_value_reads_as_number_reads_it() {
        assert_eq!(parse("0x10"), 16.0);
        assert_eq!(parse(" 0X1f "), 31.0);
        assert_eq!(parse("0b101"), 5.0);
        assert_eq!(parse("0o17"), 15.0);
        assert_eq!(parse(""), 0.0);
        assert_eq!(parse("  "), 0.0);
        assert_eq!(parse("42"), 42.0);
        assert_eq!(parse("-4.5"), -4.5);
        assert_eq!(parse(".5"), 0.5);
        assert_eq!(parse("1e3"), 1000.0);
        assert_eq!(parse("-Infinity"), f64::NEG_INFINITY);
        assert!(parse("0x").is_nan());
        assert!(parse("12px").is_nan());
        assert!(parse("nonsense").is_nan());
        assert!(parse("1e").is_nan());
        assert!(parse("-0x10").is_nan());
    }
}
