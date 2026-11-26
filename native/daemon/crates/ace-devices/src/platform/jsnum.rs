// SPDX-License-Identifier: Apache-2.0
//! JavaScript's numbers in the markup ace writes: `Math.round` (a half towards positive
//! infinity) and `Number.prototype.toString`, so a picture's coordinates spell what the
//! TypeScript spelled.

use ace_json::write_number;

/// `Math.round(value)`, which rounds a half towards positive infinity where `f64::round`
/// rounds away from zero. `-0` becomes `0` when written.
pub fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// A number in JavaScript's format: `1` for 1.0, `0` for -0, `1.5e-7` where it applies.
pub fn text(value: f64) -> String {
    let mut out = String::new();
    write_number(&mut out, value);
    out
}

/// `Math.round(value * 10^places) / 10^places`, in JavaScript's format.
pub fn rounded(value: f64, places: u32) -> String {
    let scale = 10f64.powi(places as i32);
    text(round(value * scale) / scale)
}
