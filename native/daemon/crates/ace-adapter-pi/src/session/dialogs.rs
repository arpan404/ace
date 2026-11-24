// SPDX-License-Identifier: Apache-2.0
//! The `Response` and `Dialog` shapes of `native.ts:14`–`:42`, read as lenient
//! `ace-json` lookups on the raw frame instead of serde structs. Unknown fields
//! are ignored here and kept in the frame, as the zod `looseObject` schemas did.
//!
//! Dialog ids keep JavaScript string identity: they are `JsString`s, so a lone
//! surrogate is not collapsed into U+FFFD and two distinct dialogs stay two.

use std::borrow::Cow;

use ace_json::{JsString, Kind, RawRef, Value};

use crate::translate::native::is_blocking_dialog_method;

/// A validated `Response`: `{type: "response", id, command, success, data?, error?}`.
#[derive(Debug, Clone)]
pub struct Response {
    pub id: String,
    pub command: String,
    pub success: bool,
    /// `data` as `JSON.stringify` writes it; `None` when absent.
    pub data: Option<String>,
    /// The rejection message Pi sent, when it sent one.
    pub error: Option<String>,
}

impl Response {
    /// `Response.safeParse(value)`. `None` when any required field has the wrong
    /// kind; the caller then leaves the frame for the translator alone.
    pub fn parse(raw: RawRef<'_>) -> Option<Response> {
        if raw.kind() != Kind::Object || field(raw, "type")?.as_ref() != "response" {
            return None;
        }
        let id = field(raw, "id")?.into_owned();
        let command = field(raw, "command")?.into_owned();
        let success = raw.get("success")?.as_bool()?;
        let data = raw.get("data").map(|value| {
            let mut text = String::new();
            value.write_to(&mut text);
            text
        });
        let error = match raw.get("error") {
            Some(value) => Some(value.as_str()?.into_owned()),
            None => None,
        };
        Some(Response {
            id,
            command,
            success,
            data,
            error,
        })
    }
}

/// A validated `Dialog`: a blocking `extension_ui_request`.
#[derive(Debug, Clone)]
pub struct Dialog {
    /// The id as JavaScript holds it, lone surrogates included.
    pub id: JsString,
    /// `None` when Pi set no timeout, as `d.timeout === undefined`.
    pub timeout: Option<f64>,
}

impl Dialog {
    /// `Dialog.safeParse(value)`. `title` defaults to "Pi extension"; the wire
    /// does not store it, but a present `title` must still be a string.
    pub fn parse(raw: RawRef<'_>) -> Option<Dialog> {
        if raw.kind() != Kind::Object || field(raw, "type")?.as_ref() != "extension_ui_request" {
            return None;
        }
        let id = raw.get("id")?.as_js_string()?;
        if id.is_empty() {
            return None;
        }
        let method = field(raw, "method")?;
        if !is_blocking_dialog_method(method.as_ref()) {
            return None;
        }
        if let Some(title) = raw.get("title") {
            title.as_js_string()?;
        }
        if let Some(message) = raw.get("message") {
            message.as_js_string()?;
        }
        if let Some(options) = raw.get("options") {
            if options.kind() != Kind::Array {
                return None;
            }
            for option in options.items() {
                option.as_js_string()?;
            }
        }
        let timeout = match raw.get("timeout") {
            Some(value) => {
                let ms = value.as_f64()?;
                if ms < 0.0 {
                    return None;
                }
                Some(ms)
            }
            None => None,
        };
        if let Some(prefill) = raw.get("prefill") {
            prefill.as_js_string()?;
        }
        Some(Dialog { id, timeout })
    }
}

/// The string field `key`, when it is a JSON string.
fn field<'a>(raw: RawRef<'a>, key: &str) -> Option<Cow<'a, str>> {
    raw.get(key)?.as_str()
}

/// `obj(payload.data).type === expected`.
pub fn type_is(raw: RawRef<'_>, expected: &str) -> bool {
    raw.kind() == Kind::Object && field(raw, "type").is_some_and(|value| value == expected)
}

/// `obj(payload.data).method === expected`.
pub fn method_is(raw: RawRef<'_>, expected: &str) -> bool {
    raw.kind() == Kind::Object && field(raw, "method").is_some_and(|value| value == expected)
}

/// `isBlockingDialogMethod(obj(payload.data).method)`.
pub fn blocking_method(raw: RawRef<'_>) -> bool {
    field(raw, "method").is_some_and(|method| is_blocking_dialog_method(method.as_ref()))
}

/// `str(obj(payload.data).message)`: the string, else empty (which never parses).
pub fn message_of(raw: RawRef<'_>) -> Option<Cow<'_, str>> {
    field(raw, "message")
}

/// The rollback acknowledgement carried by an extension `notify`:
/// `{type: "ace_rollback", id, success: boolean}`. `None` for anything else,
/// including a message that is not JSON.
pub fn rollback_ack(message: &str, id: &str) -> Option<bool> {
    let value = ace_json::parse(message).ok()?;
    let map = value.as_object()?;
    if map.get("type")?.as_str()? != "ace_rollback" {
        return None;
    }
    if map.get("id")?.as_str()? != id {
        return None;
    }
    map.get("success")?.as_bool()
}

/// The timer key for a dialog: `dialog:<id>`, with the id JSON-escaped (no
/// surrounding quotes) so two lone-surrogate ids stay distinct keys.
pub fn dialog_key(id: &JsString) -> String {
    let quoted = ace_json::to_string(&Value::String(id.clone()));
    let inner = quoted
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(&quoted);
    format!("dialog:{inner}")
}

/// The dialog id a `dialog:<id>` timer key names.
pub fn dialog_id(key: &str) -> Option<JsString> {
    let encoded = key.strip_prefix("dialog:")?;
    match ace_json::parse(&format!("\"{encoded}\"")) {
        Ok(Value::String(id)) => Some(id),
        _ => None,
    }
}

/// `JSON.stringify({type: "dialog_expired", id})`, key order included.
pub fn dialog_expired(id: &JsString) -> String {
    let mut map = ace_json::Map::with_capacity(2);
    map.insert("type", Value::String(JsString::from("dialog_expired")));
    map.insert("id", Value::String(id.clone()));
    ace_json::to_string(&Value::Object(map))
}

/// `JSON.stringify(text)`: the quoted form a stderr frame carries.
pub fn quoted(text: &str) -> String {
    ace_json::to_string(&Value::String(JsString::from(text)))
}
