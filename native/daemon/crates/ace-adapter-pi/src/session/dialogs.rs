// SPDX-License-Identifier: Apache-2.0
//! The `Response` and `Dialog` shapes of `native.ts:14`–`:42`, read as lenient
//! `ace-json` lookups instead of serde structs. Unknown fields are kept in the
//! frame and ignored here, exactly as the zod schemas' `looseObject` did.

use crate::translate::native::is_blocking_dialog_method;
use ace_json::{JsString, Map, Value};

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
    pub fn parse(value: &Value) -> Option<Response> {
        let map = value.as_object()?;
        if map.get("type")?.as_str()? != "response" {
            return None;
        }
        let id = map.get("id")?.as_str()?.to_owned();
        let command = map.get("command")?.as_str()?.to_owned();
        let success = map.get("success")?.as_bool()?;
        let data = map.get("data").map(ace_json::to_string);
        let error = match map.get("error") {
            Some(value) => Some(value.as_str()?.to_owned()),
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
    pub id: String,
    /// `None` when Pi set no timeout, as `d.timeout === undefined`.
    pub timeout: Option<f64>,
}

impl Dialog {
    /// `Dialog.safeParse(value)`. `title` defaults to "Pi extension"; the wire
    /// does not store it, but a present `title` must still be a string.
    pub fn parse(value: &Value) -> Option<Dialog> {
        let map = value.as_object()?;
        if map.get("type")?.as_str()? != "extension_ui_request" {
            return None;
        }
        let id = map.get("id")?.as_str()?;
        if id.is_empty() {
            return None;
        }
        let method = map.get("method")?.as_str()?;
        if !is_blocking_dialog_method(method) {
            return None;
        }
        if let Some(title) = map.get("title") {
            title.as_str()?;
        }
        if let Some(message) = map.get("message") {
            message.as_str()?;
        }
        if let Some(options) = map.get("options") {
            for option in options.as_array()? {
                option.as_str()?;
            }
        }
        let timeout = match map.get("timeout") {
            Some(value) => {
                let ms = value.as_f64()?;
                if ms < 0.0 {
                    return None;
                }
                Some(ms)
            }
            None => None,
        };
        if let Some(prefill) = map.get("prefill") {
            prefill.as_str()?;
        }
        Some(Dialog {
            id: id.to_owned(),
            timeout,
        })
    }
}

/// `obj(payload.data).type` when it is a string.
pub fn type_of(value: &Value) -> Option<&str> {
    value.as_object()?.get("type")?.as_str()
}

/// `obj(payload.data).method` when it is a string.
pub fn method_of(value: &Value) -> Option<&str> {
    value.as_object()?.get("method")?.as_str()
}

/// `str(obj(payload.data).message)`: the string, else empty (which never parses).
pub fn message_of(value: &Value) -> Option<&str> {
    value.as_object()?.get("message")?.as_str()
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

/// `JSON.stringify({type: "dialog_expired", id})`, key order included.
pub fn dialog_expired(id: &str) -> String {
    let mut map = Map::with_capacity(2);
    map.insert("type", Value::String(JsString::from("dialog_expired")));
    map.insert("id", Value::String(JsString::from(id)));
    ace_json::to_string(&Value::Object(map))
}

/// `JSON.stringify(text)`: the quoted form a stderr frame carries.
pub fn quoted(text: &str) -> String {
    ace_json::to_string(&Value::String(JsString::from(text)))
}
