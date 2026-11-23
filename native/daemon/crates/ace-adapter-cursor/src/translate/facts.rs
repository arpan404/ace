// SPDX-License-Identifier: Apache-2.0
//! The translator's shared fact shapes: failed-run errors and the truthiness
//! the TypeScript reads (`translator.ts`).

use serde_json::{Map, Value};

use super::failure_kind::cursor_failure;

/// A failed run's error fact, spreading the classification under the message.
pub fn failed_run(code: &Value, message: &str, retryable: &Value) -> Value {
    let failure = cursor_failure(code, message, retryable);
    let mut error = Map::new();
    error.insert("kind".to_owned(), Value::String(failure.kind.to_owned()));
    if let Some(code) = failure.code {
        error.insert("code".to_owned(), Value::String(code));
    }
    error.insert("message".to_owned(), Value::String(message.to_owned()));
    Value::Object(error)
}

/// Whether a JSON value is truthy the way the TypeScript reads it.
pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                int != 0
            } else if let Some(uint) = number.as_u64() {
                uint != 0
            } else {
                number
                    .as_f64()
                    .is_some_and(|float| float != 0.0 && !float.is_nan())
            }
        }
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(_) => true,
    }
}
