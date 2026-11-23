// SPDX-License-Identifier: Apache-2.0
//! The translator's shared fact shapes: failed-run errors and the truthiness
//! the TypeScript reads (`translator.ts`).

use super::failure_kind::cursor_failure;
use super::json::{J, encode_units};

/// A failed run's error fact, spreading the classification under the message.
pub fn failed_run(code: &J, message: &[u16], retryable: &J) -> J {
    let failure = cursor_failure(code, message, retryable);
    let mut error = vec![(encode_units("kind"), J::Str(encode_units(failure.kind)))];
    if let Some(code) = failure.code {
        error.push((encode_units("code"), J::Str(code)));
    }
    error.push((encode_units("message"), J::Str(message.to_vec())));
    J::Obj(error)
}

/// Whether a JSON value is truthy the way the TypeScript reads it.
pub fn is_truthy(value: &J) -> bool {
    match value {
        J::Null => false,
        J::Bool(flag) => *flag,
        J::Num(raw) => {
            let float: f64 = raw.parse().unwrap_or(f64::NAN);
            float != 0.0 && !float.is_nan()
        }
        J::Str(text) => !text.is_empty(),
        J::Arr(items) => !items.is_empty(),
        J::Obj(_) => true,
    }
}
