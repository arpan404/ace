// SPDX-License-Identifier: Apache-2.0
//! JSON across the binding, through ace-json: frames arrive as `JSON.stringify` text and are
//! read without building trees beyond the `data` a translator folds; facts leave as one array
//! spliced from their canonical text. A frame that is not JSON throws a JavaScript
//! `SyntaxError`, as `JSON.parse` would. Nothing here recurses, so depth is bounded by memory.

use ace_json::{SyntaxError, Value};
use napi::{Env, Status};

/// Throw `error` as the `SyntaxError` `JSON.parse` throws, and the error that carries it out.
pub(crate) fn syntax_error(env: &Env, error: &SyntaxError) -> napi::Error {
    let message = error.to_string();
    env.throw_syntax_error(&message, None::<&str>);
    napi::Error::new(Status::PendingException, message)
}

/// `JSON.parse` of the frame.
pub(crate) fn parse(env: &Env, text: &str) -> napi::Result<Value> {
    ace_json::parse(text).map_err(|error| syntax_error(env, &error))
}

/// `JSON.stringify(values)`, into `out` (cleared first, capacity kept).
pub(crate) fn write_values(out: &mut String, values: &[Value]) {
    out.clear();
    out.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        ace_json::write_value(out, value);
    }
    out.push(']');
}
