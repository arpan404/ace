// SPDX-License-Identifier: Apache-2.0
//! The translator's shared fact shapes: failed-run errors and the truthiness
//! the TypeScript reads (`translator.ts`).

use super::failure_kind::cursor_failure;
use super::text::{JsString, Value};

/// A failed run's error fact, spreading the classification under the message.
pub fn failed_run(code: &Value, message: &JsString, retryable: &Value) -> Value {
    let failure = cursor_failure(code, message, retryable);
    let mut error = vec![(
        JsString::from("kind"),
        Value::String(JsString::from(failure.kind)),
    )];
    if let Some(code) = failure.code {
        error.push((JsString::from("code"), Value::String(code)));
    }
    error.push((JsString::from("message"), Value::String(message.clone())));
    Value::from(error)
}

/// Whether a JSON value is truthy the way the TypeScript reads it.
pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(raw) => {
            let float: f64 = raw.value();
            float != 0.0 && !float.is_nan()
        }
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(_) => true,
    }
}
