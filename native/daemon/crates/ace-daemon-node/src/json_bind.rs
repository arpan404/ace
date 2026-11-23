// SPDX-License-Identifier: Apache-2.0
//! JSON across the binding, through ace-json: frames arrive as `JSON.stringify` text and are
//! read without building trees beyond the `data` a translator folds; facts leave as one array
//! spliced from their canonical text. A frame that is not JSON throws a JavaScript
//! `SyntaxError`, as `JSON.parse` would. Nothing here recurses, so depth is bounded by memory.

use std::borrow::Cow;

use ace_json::{RawRef, SyntaxError, Value};
use napi::{Env, Status};

/// Throw `error` as the `SyntaxError` `JSON.parse` throws, and the error that carries it out.
pub(crate) fn syntax_error(env: &Env, error: &SyntaxError) -> napi::Error {
    let message = error.to_string();
    env.throw_syntax_error(&message, None::<&str>);
    napi::Error::new(Status::PendingException, message)
}

/// The frame's JSON, validated once and borrowed.
pub(crate) fn frame<'a>(env: &Env, text: &'a str) -> napi::Result<RawRef<'a>> {
    ace_json::parse_raw(text).map_err(|error| syntax_error(env, &error))
}

/// A frame field's string.
pub(crate) fn text_field<'a>(frame: RawRef<'a>, key: &str) -> Option<Cow<'a, str>> {
    frame.get(key).and_then(|value| value.as_str())
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
