// SPDX-License-Identifier: Apache-2.0

//! Replies from `ace-screen-helper --computer` (`computer/wire.ts`). Parsed leniently: unknown
//! fields are kept, optional ones may be missing, so a newer helper never breaks an older
//! daemon. Only the envelope is read here — `id`, `ok`, `result` and `error`; a result's own
//! shape belongs to whoever asked for it.

use ace_json::Value;

/// One reply line, as the connection needs it (`wire.ts:128`-`:138`).
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    /// `{ id, ok: true, result }`; `result` is `null` when the helper sent none.
    Ok { id: String, result: Value },
    /// `{ id, ok: false, error: { code, message } }`.
    Failed {
        id: String,
        code: String,
        message: String,
    },
}

impl Reply {
    pub fn id(&self) -> &str {
        match self {
            Reply::Ok { id, .. } | Reply::Failed { id, .. } => id,
        }
    }

    /// The helper's result, for a cancelled or overrun request's error.
    pub fn result(&self) -> Option<Value> {
        match self {
            Reply::Ok { result, .. } => Some(result.clone()),
            Reply::Failed { .. } => None,
        }
    }
}

/// Decode one reply line; `None` when the line is not a reply at all (a stray log line, a
/// partial write, an `id` that is not a string).
pub fn decode_reply(text: &str) -> Option<Reply> {
    let value = ace_json::parse(text).ok()?;
    let object = value.as_object()?;
    let id = object.get("id").and_then(Value::as_str)?.to_owned();
    match object.get("ok") {
        Some(Value::Bool(true)) => Some(Reply::Ok {
            id,
            result: object.get("result").cloned().unwrap_or(Value::Null),
        }),
        Some(Value::Bool(false)) => {
            let error = object.get("error").and_then(Value::as_object)?;
            let code = error.get("code").and_then(Value::as_str)?.to_owned();
            let message = error.get("message").and_then(Value::as_str)?.to_owned();
            Some(Reply::Failed { id, code, message })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{Reply, decode_reply};
    use ace_json::{Value, json};

    #[test]
    fn a_reply_keeps_unknown_fields_and_its_result() {
        let text = r#"{"id":"7","ok":true,"result":{"apps":[]},"extra":{"kept":1}}"#;
        let Some(Reply::Ok { id, result }) = decode_reply(text) else {
            panic!("expected a result reply");
        };
        assert_eq!(id, "7");
        assert_eq!(result, json!({"apps": []}));
    }

    #[test]
    fn a_failure_carries_its_code_and_message() {
        let text = r#"{"id":"9","ok":false,"error":{"code":"no_access","message":"Accessibility is off."}}"#;
        assert_eq!(
            decode_reply(text),
            Some(Reply::Failed {
                id: "9".to_owned(),
                code: "no_access".to_owned(),
                message: "Accessibility is off.".to_owned(),
            })
        );
    }

    #[test]
    fn a_line_that_is_not_a_reply_is_dropped() {
        assert_eq!(decode_reply("not json"), None);
        assert_eq!(decode_reply(r#"{"id":7,"ok":true,"result":null}"#), None);
        assert_eq!(decode_reply(r#"{"id":"1","ok":true"#), None);
        assert_eq!(decode_reply(r#"{"ok":true,"result":null}"#), None);
        assert_eq!(decode_reply(r#"{"id":"1","ok":false}"#), None);
        // A missing `result` is `null`, as JSON.parse leaves it.
        assert_eq!(
            decode_reply(r#"{"id":"1","ok":true}"#),
            Some(Reply::Ok {
                id: "1".to_owned(),
                result: Value::Null,
            })
        );
    }
}
