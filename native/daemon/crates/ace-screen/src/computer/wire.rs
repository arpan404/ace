// SPDX-License-Identifier: Apache-2.0

//! Replies from `ace-screen-helper --computer` (`computer/wire.ts`). Parsed leniently: unknown
//! fields are kept, optional ones may be missing, so a newer helper never breaks an older
//! daemon. Only the envelope is read here — `id`, `ok`, `result` and `error`; a result's own
//! shape belongs to whoever asked for it, and a line that is neither shape keeps its `raw`
//! instead of failing the connection (`wire.ts:131`-`:138`).

use ace_json::{JsString, Value};

/// One reply line, as the connection needs it (`wire.ts:128`-`:138`).
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    /// `{ id, ok: true, result }`; `result` is `null` when the helper sent none.
    Ok {
        id: JsString,
        result: Value,
        /// The whole line, unknown fields included.
        raw: Value,
    },
    /// `{ id, ok: false, error: { code, message } }`.
    Failed {
        id: JsString,
        code: JsString,
        message: JsString,
        /// The whole line, unknown fields included.
        raw: Value,
    },
    /// An envelope with a string `id` that neither shape names (a newer helper's variant, or a
    /// malformed `ok`): kept whole, and never mistaken for a reply to this request.
    Unknown { id: JsString, raw: Value },
}

impl Reply {
    pub fn id(&self) -> &JsString {
        match self {
            Reply::Ok { id, .. } | Reply::Failed { id, .. } | Reply::Unknown { id, .. } => id,
        }
    }

    /// The helper's result, for a cancelled or overrun request's error.
    pub fn result(&self) -> Option<Value> {
        match self {
            Reply::Ok { result, .. } => Some(result.clone()),
            _ => None,
        }
    }

    /// The line as it came, unknown fields included.
    pub fn raw(&self) -> &Value {
        match self {
            Reply::Ok { raw, .. } | Reply::Failed { raw, .. } | Reply::Unknown { raw, .. } => raw,
        }
    }
}

/// A string value as it parsed, lone surrogates and all (`as_str()` would replace them).
fn string_of(value: &Value) -> Option<JsString> {
    match value {
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

/// Decode one reply line; `None` when the line is not a reply at all (a stray log line, a
/// partial write, an `id` that is not a string).
pub fn decode_reply(text: &str) -> Option<Reply> {
    let value = ace_json::parse(text).ok()?;
    let object = value.as_object()?;
    let id = object.get("id").and_then(string_of)?;
    match object.get("ok") {
        Some(Value::Bool(true)) => Some(Reply::Ok {
            id,
            result: object.get("result").cloned().unwrap_or(Value::Null),
            raw: value,
        }),
        Some(Value::Bool(false)) => {
            let error = object.get("error").and_then(Value::as_object);
            let code = error
                .and_then(|error| error.get("code"))
                .and_then(string_of);
            let message = error
                .and_then(|error| error.get("message"))
                .and_then(string_of);
            match (code, message) {
                (Some(code), Some(message)) => Some(Reply::Failed {
                    id,
                    code,
                    message,
                    raw: value,
                }),
                _ => Some(Reply::Unknown { id, raw: value }),
            }
        }
        _ => Some(Reply::Unknown { id, raw: value }),
    }
}

#[cfg(test)]
// The `wire` unit cases: the envelope a helper replies with, unknown fields kept
// (`computer/wire.ts:128`-`:138`; the cases `test/computer` drives through the connection).
mod tests {
    use super::{Reply, decode_reply};
    use ace_json::{Value, json};

    #[test]
    fn a_reply_keeps_unknown_fields_and_its_result() {
        let text = r#"{"id":"7","ok":true,"result":{"apps":[]},"extra":{"kept":1}}"#;
        let Some(Reply::Ok { id, result, raw }) = decode_reply(text) else {
            panic!("expected a result reply");
        };
        assert_eq!(id.as_str(), "7");
        assert_eq!(result, json!({"apps": []}));
        assert_eq!(
            raw.get("extra"),
            Some(&json!({"kept": 1})),
            "the line is kept whole, not rebuilt from what this port knows"
        );
    }

    #[test]
    fn a_failure_carries_its_code_and_message() {
        let text = r#"{"id":"9","ok":false,"error":{"code":"no_access","message":"Accessibility is off.","detail":{"kept":true}}}"#;
        let Some(Reply::Failed {
            id,
            code,
            message,
            raw,
        }) = decode_reply(text)
        else {
            panic!("expected a failure reply");
        };
        assert_eq!(id.as_str(), "9");
        assert_eq!(code.as_str(), "no_access");
        assert_eq!(message.as_str(), "Accessibility is off.");
        assert_eq!(raw.pointer("/error/detail"), Some(&json!({"kept": true})));
    }

    #[test]
    fn a_line_that_is_not_a_reply_is_dropped() {
        assert_eq!(decode_reply("not json"), None);
        assert_eq!(decode_reply(r#"{"id":7,"ok":true,"result":null}"#), None);
        assert_eq!(decode_reply(r#"{"id":"1","ok":true"#), None);
        assert_eq!(decode_reply(r#"{"ok":true,"result":null}"#), None);
        // A missing `result` is `null`, as JSON.parse leaves it.
        assert_eq!(
            decode_reply(r#"{"id":"1","ok":true}"#),
            Some(Reply::Ok {
                id: "1".into(),
                result: Value::Null,
                raw: json!({ "id": "1", "ok": true }),
            })
        );
    }

    #[test]
    fn a_variant_this_port_does_not_name_is_kept_whole() {
        let text = r#"{"id":"3","ok":"maybe","newField":1}"#;
        let Some(Reply::Unknown { id, raw }) = decode_reply(text) else {
            panic!("expected an unknown reply");
        };
        assert_eq!(id.as_str(), "3");
        assert_eq!(raw.get("ok").and_then(Value::as_str), Some("maybe"));
        assert_eq!(raw.get("newField"), Some(&json!(1)));
        // A failure without both strings is the same case, not a connection failure.
        assert!(matches!(
            decode_reply(r#"{"id":"4","ok":false,"error":{"code":"x"}}"#),
            Some(Reply::Unknown { .. })
        ));
    }

    #[test]
    fn a_lone_surrogate_in_a_message_survives() {
        let Some(Reply::Failed { message, .. }) =
            decode_reply(r#"{"id":"1","ok":false,"error":{"code":"c","message":"\ud800"}}"#)
        else {
            panic!("expected a failure reply");
        };
        assert_eq!(message.units().collect::<Vec<u16>>(), vec![0xd800]);
    }
}
