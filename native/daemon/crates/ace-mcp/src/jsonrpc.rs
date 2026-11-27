// SPDX-License-Identifier: Apache-2.0
//! JSON-RPC 2.0 as the MCP server reads and writes it (`@modelcontextprotocol/server`'s
//! `Message` and `ReplyEnvelope`, pinned by `stdio-bridge.ts:14`–`:24`).
//!
//! A request's method is 1 to 256 characters (UTF-16 units, as `.length` counts) and its id is a
//! string of at most 256 or a finite number. Anything else is `Invalid Request`; bytes that are
//! not JSON are `Parse error`. Replies keep the TypeScript's key order: `jsonrpc`, `id`, then
//! `result` or `error`.

use ace_json::{JsString, Map, Value};

/// Messages the server sends for a request it cannot read.
pub const PARSE_ERROR: i64 = -32_700;
pub const INVALID_REQUEST: i64 = -32_600;
pub const METHOD_NOT_FOUND: i64 = -32_601;
pub const INVALID_PARAMS: i64 = -32_602;
pub const INTERNAL_ERROR: i64 = -32_603;
/// A tool call outside the caller's scope (`scope-challenge.ts:87`).
pub const FORBIDDEN: i64 = -32_003;

/// The longest method or string id, in UTF-16 units (`Message`, `stdio-bridge.ts:14`).
pub const MAX_METHOD_UNITS: usize = 256;
pub const MAX_ID_UNITS: usize = 256;

/// A request id: a string of at most 256 units, or a finite number.
#[derive(Debug, Clone, PartialEq)]
pub enum Id {
    Number(f64),
    String(String),
}

impl Id {
    /// Reads a request's id; `None` when it is not one the protocol allows.
    pub fn from_value(value: &Value) -> Option<Id> {
        match value {
            Value::String(text) => {
                let units = text.as_str().encode_utf16().count();
                (units <= MAX_ID_UNITS).then(|| Id::String(text.as_str().to_owned()))
            }
            Value::Number(number) => number
                .as_f64()
                .filter(|value| value.is_finite())
                .map(Id::Number),
            _ => None,
        }
    }

    /// The id as the wire carries it.
    pub fn to_value(&self) -> Value {
        match self {
            Id::Number(value) => Value::from(*value),
            Id::String(text) => Value::String(JsString::from(text.as_str())),
        }
    }

    /// Equality as a JavaScript `Map` key: `1` and `"1"` are different callers.
    pub fn key(&self) -> String {
        match self {
            Id::Number(value) => format!("n:{value}"),
            Id::String(text) => format!("s:{text}"),
        }
    }
}

/// One JSON-RPC error.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> RpcError {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(code: i64, message: impl Into<String>, data: Value) -> RpcError {
        RpcError {
            code,
            message: message.into(),
            data: Some(data),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::with_capacity(3);
        map.insert("code", Value::from(self.code as f64));
        map.insert(
            "message",
            Value::String(JsString::from(self.message.as_str())),
        );
        if let Some(data) = &self.data {
            map.insert("data", data.clone());
        }
        Value::Object(map)
    }
}

/// One message, as either side of the wire writes it.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request {
        id: Id,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
    /// A reply, which the server only reads when it acts as a client (the stdio bridge).
    Response {
        id: Option<Id>,
        result: Value,
    },
    Error {
        id: Option<Id>,
        error: RpcError,
    },
}

impl Message {
    /// Parses one JSON value as JSON-RPC 2.0. A malformed envelope is an invalid request.
    pub fn from_value(value: &Value) -> Result<Message, RpcError> {
        let Some(object) = value.as_object() else {
            return Err(RpcError::new(INVALID_REQUEST, "Invalid Request"));
        };
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(RpcError::new(INVALID_REQUEST, "Invalid Request"));
        }
        let id = match object.get("id") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let Some(id) = Id::from_value(value) else {
                    return Err(RpcError::new(INVALID_REQUEST, "Invalid Request"));
                };
                Some(id)
            }
        };
        if let Some(method_value) = object.get("method") {
            let Some(method) = method_value.as_str() else {
                return Err(RpcError::new(INVALID_REQUEST, "Invalid Request"));
            };
            let units = method.encode_utf16().count();
            if units == 0 || units > MAX_METHOD_UNITS {
                return Err(RpcError::new(INVALID_REQUEST, "Invalid Request"));
            }
            let params = object
                .get("params")
                .cloned()
                .filter(|value| !value.is_null());
            return Ok(match id {
                Some(id) => Message::Request {
                    id,
                    method: method.to_owned(),
                    params,
                },
                None => Message::Notification {
                    method: method.to_owned(),
                    params,
                },
            });
        }
        if let Some(error) = object.get("error") {
            let Some(code) = error.get("code").and_then(Value::as_f64) else {
                return Err(RpcError::new(INVALID_REQUEST, "Invalid Request"));
            };
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let data = error.get("data").cloned();
            return Ok(Message::Error {
                id,
                error: RpcError {
                    code: code as i64,
                    message,
                    data,
                },
            });
        }
        if let Some(result) = object.get("result") {
            return Ok(Message::Response {
                id,
                result: result.clone(),
            });
        }
        Err(RpcError::new(INVALID_REQUEST, "Invalid Request"))
    }

    /// Parses one body as JSON-RPC 2.0: `Parse error` over `-32_700` for bytes that are not JSON.
    pub fn parse(body: &[u8]) -> Result<Message, RpcError> {
        let text =
            std::str::from_utf8(body).map_err(|_| RpcError::new(PARSE_ERROR, "Parse error"))?;
        let value = ace_json::parse(text).map_err(|_| RpcError::new(PARSE_ERROR, "Parse error"))?;
        Message::from_value(&value)
    }

    /// A reply to `id` with `result`.
    pub fn reply(id: &Id, result: Value) -> Value {
        let mut map = Map::with_capacity(3);
        map.insert("jsonrpc", Value::from("2.0"));
        map.insert("id", id.to_value());
        map.insert("result", result);
        Value::Object(map)
    }

    /// A reply to `id` with `error`.
    pub fn failure(id: Option<&Id>, error: RpcError) -> Value {
        let mut map = Map::with_capacity(3);
        map.insert("jsonrpc", Value::from("2.0"));
        map.insert(
            "id",
            match id {
                Some(id) => id.to_value(),
                None => Value::Null,
            },
        );
        map.insert("error", error.to_value());
        Value::Object(map)
    }

    /// A server-initiated notification.
    pub fn notification(method: &str, params: Value) -> Value {
        let mut map = Map::with_capacity(3);
        map.insert("jsonrpc", Value::from("2.0"));
        map.insert("method", Value::from(method));
        map.insert("params", params);
        Value::Object(map)
    }
}

#[cfg(test)]
mod tests {
    // Ported from the message rules `stdio-bridge.ts:14`–`:24` pins and the HTTP cases
    // "rejects hostile origins, malformed requests and oversized bodies".
    use super::*;
    use ace_json::parse;

    fn json(text: &str) -> Value {
        parse(text).expect("json")
    }

    #[test]
    fn a_request_needs_jsonrpc_2_0_an_id_and_a_method_of_one_to_256_units() {
        let request = Message::from_value(&json(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}",
        ))
        .expect("request");
        assert_eq!(
            request,
            Message::Request {
                id: Id::Number(1.0),
                method: "tools/list".to_owned(),
                params: None
            }
        );
        for bad in [
            "{\"id\":1,\"method\":\"tools/list\"}",
            "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"tools/list\"}",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"\"}",
            "{\"jsonrpc\":\"2.0\",\"id\":true,\"method\":\"tools/list\"}",
            "{\"jsonrpc\":\"2.0\",\"id\":[],\"method\":\"tools/list\"}",
        ] {
            assert_eq!(
                Message::from_value(&json(bad)).unwrap_err(),
                RpcError::new(INVALID_REQUEST, "Invalid Request"),
                "{bad}"
            );
        }
        let long = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"method\":\"m\"}}",
            "i".repeat(256)
        );
        assert!(Message::from_value(&json(&long)).is_ok());
        let too_long = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":\"{}\",\"method\":\"m\"}}",
            "i".repeat(257)
        );
        assert!(Message::from_value(&json(&too_long)).is_err());
        let long_method = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"{}\"}}",
            "m".repeat(257)
        );
        assert!(Message::from_value(&json(&long_method)).is_err());
    }

    #[test]
    fn a_message_without_an_id_is_a_notification() {
        let message = Message::from_value(&json(
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":1}}",
        ))
        .expect("message");
        assert!(
            matches!(message, Message::Notification { method, .. } if method == "notifications/cancelled")
        );
    }

    #[test]
    fn bytes_that_are_not_json_are_a_parse_error() {
        assert_eq!(
            Message::parse(b"{").unwrap_err(),
            RpcError::new(PARSE_ERROR, "Parse error")
        );
        assert_eq!(
            Message::parse(b"{}").unwrap_err(),
            RpcError::new(INVALID_REQUEST, "Invalid Request")
        );
    }

    #[test]
    fn a_reply_keeps_the_typescripts_key_order_and_an_id_of_either_kind() {
        assert_eq!(
            ace_json::to_string(&Message::reply(&Id::Number(1.0), json("{\"tools\":[]}"))),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}"
        );
        assert_eq!(
            ace_json::to_string(&Message::reply(&Id::String("a".to_owned()), Value::Null)),
            "{\"jsonrpc\":\"2.0\",\"id\":\"a\",\"result\":null}"
        );
        assert_eq!(
            ace_json::to_string(&Message::failure(
                None,
                RpcError::new(METHOD_NOT_FOUND, "Method not found")
            )),
            "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}"
        );
    }
}
