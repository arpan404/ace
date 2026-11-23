// SPDX-License-Identifier: Apache-2.0
//! Numbers as JavaScript holds them: one f64. `1`, `1.0` and `1e0` are the same number, an
//! integer above 2^53 rounds as it does in JavaScript, and the text written is
//! `Number.prototype.toString`'s (shortest round-trip digits), with `-0` as `0` and the
//! non-finite values as `null`, as `JSON.stringify` writes them.

use std::fmt;

/// A JavaScript number.
#[derive(Clone, Copy, Debug, Default)]
pub struct Number(f64);

/// 2^63 and 2^64 as f64: the exclusive upper bounds of i64 and u64.
const I64_END: f64 = 9_223_372_036_854_775_808.0;
const U64_END: f64 = 18_446_744_073_709_551_616.0;

impl Number {
    /// A finite number; `None` for NaN and the infinities, which JSON cannot carry.
    pub fn from_f64(value: f64) -> Option<Number> {
        value.is_finite().then_some(Number(value))
    }

    /// Any f64, as JavaScript arithmetic may produce it; non-finite values write as `null`.
    pub const fn from_f64_lossy(value: f64) -> Number {
        Number(value)
    }

    pub fn as_f64(&self) -> Option<f64> {
        Some(self.0)
    }

    pub fn value(&self) -> f64 {
        self.0
    }

    /// The number as an i64 when it is an integer in range (`Number.isInteger`, any notation).
    pub fn as_i64(&self) -> Option<i64> {
        let value = self.0;
        (value.fract() == 0.0 && (-I64_END..I64_END).contains(&value)).then_some(value as i64)
    }

    /// The number as a u64 when it is a non-negative integer in range.
    pub fn as_u64(&self) -> Option<u64> {
        let value = self.0;
        (value.fract() == 0.0 && (0.0..U64_END).contains(&value)).then_some(value as u64)
    }

    pub fn is_i64(&self) -> bool {
        self.as_i64().is_some()
    }

    pub fn is_u64(&self) -> bool {
        self.as_u64().is_some()
    }

    /// Whether the number is not an integer. JavaScript has one number type; this is the
    /// closest reading of serde_json's "is a float".
    pub fn is_f64(&self) -> bool {
        self.0.fract() != 0.0 || !self.0.is_finite()
    }

    pub fn is_finite(&self) -> bool {
        self.0.is_finite()
    }
}

/// `JSON.stringify` of a number: `Number.prototype.toString` for finite values, else `null`.
pub fn write_number(out: &mut String, value: f64) {
    if !value.is_finite() {
        out.push_str("null");
    } else if value == 0.0 {
        // Covers -0, which JavaScript prints as "0".
        out.push('0');
    } else if value.fract() == 0.0 && value.abs() < 1e15 {
        // Exact integers below 1e15 print as their digits; a plain integer write is the same
        // text and faster than the shortest-digits search.
        let mut digits = itoa_buffer();
        out.push_str(format_int(&mut digits, value as i64));
    } else {
        let mut buffer = ryu_js::Buffer::new();
        out.push_str(buffer.format_finite(value));
    }
}

fn itoa_buffer() -> [u8; 20] {
    [0u8; 20]
}

fn format_int(buffer: &mut [u8; 20], value: i64) -> &str {
    let negative = value < 0;
    let mut rest = value.unsigned_abs();
    let mut start = buffer.len();
    loop {
        start -= 1;
        if let Some(slot) = buffer.get_mut(start) {
            *slot = b'0' + (rest % 10) as u8;
        }
        rest /= 10;
        if rest == 0 {
            break;
        }
    }
    if negative {
        start -= 1;
        if let Some(slot) = buffer.get_mut(start) {
            *slot = b'-';
        }
    }
    buffer
        .get(start..)
        .and_then(|digits| std::str::from_utf8(digits).ok())
        .unwrap_or("0")
}

impl PartialEq for Number {
    /// JavaScript's `===` on numbers: `0 === -0`, `NaN !== NaN`.
    fn eq(&self, other: &Number) -> bool {
        self.0 == other.0
    }
}

impl fmt::Display for Number {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut out = String::new();
        write_number(&mut out, self.0);
        f.write_str(&out)
    }
}

macro_rules! from_int {
    ($($t:ty),*) => {$(
        impl From<$t> for Number {
            /// As JavaScript's `Number(n)`: integers beyond 2^53 round to the nearest f64.
            fn from(value: $t) -> Number {
                Number(value as f64)
            }
        }
    )*};
}

from_int!(u8, u16, u32, u64, usize, i8, i16, i32, i64, isize);

impl From<f64> for Number {
    fn from(value: f64) -> Number {
        Number(value)
    }
}

impl From<f32> for Number {
    fn from(value: f32) -> Number {
        Number(f64::from(value))
    }
}
