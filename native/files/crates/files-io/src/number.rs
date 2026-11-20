// SPDX-License-Identifier: Apache-2.0

//! Numbers as JavaScript prints them.
//!
//! A version string is compared byte for byte with the one the daemon prints, and its timestamp
//! fields are JavaScript numbers, so each one has to come out with the digits node prints.

/// A JavaScript number in string form.
///
/// A version component is a non-negative integer or a millisecond timestamp, so it stays inside
/// the range where ECMAScript and Rust both print plain decimal digits (1e-6 up to 1e21).
/// Outside it JavaScript switches to exponent form, which is reproduced for completeness.
///
/// Inside that range both print the shortest decimal that reads back as the same number, with
/// one exception: a number exactly halfway between two such decimals. A file modified at
/// 1911493843000.78125 milliseconds reports that timestamp, and both `1911493843000.7812` and
/// `1911493843000.7813` read back as it. JavaScript prints the one with the even last digit,
/// Rust the one larger in magnitude, so a halfway value is printed again at the places where it
/// halves. Versions are compared as strings, so one differing digit makes every save guarded
/// from the other side conflict.
pub(crate) fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let mut text = format!("{value:e}");
        if let Some(exponent) = text.find('e') {
            let positive = !text[exponent + 1..].starts_with('-');
            if positive {
                text.insert(exponent + 1, '+');
            }
        }
        return text;
    }
    let shortest = format!("{magnitude}");
    let text = match halfway_places(magnitude) {
        Some(places) if places == decimal_places(&shortest) => format!("{magnitude:.places$}"),
        _ => shortest,
    };
    if value < 0.0 {
        format!("-{text}")
    } else {
        text
    }
}

/// The decimal place where `magnitude` sits exactly halfway between two decimals.
///
/// A non-integer float is an odd number over a power of two, and its decimal digits end at that
/// power: 1911493843000.78125 is an odd number over 2^5, so it ends at the fifth place and lies
/// halfway between the two decimals one place shorter. An integer is halfway at no decimal place.
fn halfway_places(magnitude: f64) -> Option<usize> {
    let bits = magnitude.to_bits();
    let field = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    let (significand, exponent) = if field == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1u64 << 52), field - 1075)
    };
    if significand == 0 {
        return None;
    }
    let exponent = exponent + significand.trailing_zeros() as i32;
    usize::try_from(-exponent - 1).ok()
}

/// The number of digits a printed decimal has after the point.
fn decimal_places(text: &str) -> usize {
    text.split_once('.')
        .map_or(0, |(_, fraction)| fraction.len())
}
