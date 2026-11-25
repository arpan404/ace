// SPDX-License-Identifier: Apache-2.0
//! The small pure helpers an effect is built from: a port's one-field payload, an error frame's
//! message, the login URL check, and the rule that tells stray output from a broken JSON-RPC
//! line.

use ace_json::{JsString, Map, Value};

use super::super::error::SessionError;
use super::MAX_LOGIN_URL;

/// A one-field object, as a port's payload.
pub(super) fn port_json(field: &str, text: &str) -> String {
    let mut object = Map::with_capacity(1);
    object.insert(field, Value::String(JsString::from(text)));
    Value::Object(object).to_json()
}

/// `HostErrorBody.safeParse(frame.body)`: the message an error frame carries.
pub(super) fn error_body(body: &Value) -> Option<String> {
    match body.get("message") {
        Some(Value::String(message)) => Some(message.as_str().to_owned()),
        _ => None,
    }
}

/// `login-url` (`host.ts:172`-`:177`): https, at most 8,192 UTF-16 units.
pub(super) fn login_url(params: Option<&Value>) -> Result<String, SessionError> {
    let Some(Value::String(url)) = params.and_then(|params| params.get("url")) else {
        return Err(SessionError::UnsafeLoginUrl);
    };
    if url.len_utf16() > MAX_LOGIN_URL || !url.as_str().starts_with("https://") {
        return Err(SessionError::UnsafeLoginUrl);
    }
    Ok(url.as_str().to_owned())
}

/// `/"jsonrpc"\s*:/`: text that may hold a JSON-RPC message, which an unterminated native write
/// can join (`host.ts:19`).
pub(super) fn may_hold_rpc_message(line: &str) -> bool {
    fn is_js_space(text: char) -> bool {
        matches!(
            text,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    }
    const NEEDLE: &str = "\"jsonrpc\"";
    let mut rest = line;
    while let Some(at) = rest.find(NEEDLE) {
        let after = rest.get(at + NEEDLE.len()..).unwrap_or("");
        if after.trim_start_matches(is_js_space).starts_with(':') {
            return true;
        }
        rest = after;
    }
    false
}
