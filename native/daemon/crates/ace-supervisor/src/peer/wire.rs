// SPDX-License-Identifier: Apache-2.0
//! The JSON values a frame is made of and read from (`jsonrpc.ts`): an id keeps its exact
//! type, `params` is omitted only when it is undefined, and a line is serialized once.
use ace_json::{JsString, Map, Value};

use crate::jsonrpc::RpcId;

pub(super) fn id_of(value: &Value) -> Option<RpcId> {
    match value.get("id") {
        Some(Value::String(text)) => Some(RpcId::Text(text.clone())),
        Some(Value::Number(number)) => number.as_f64().map(RpcId::Number),
        _ => None,
    }
}

pub(super) fn method_of(value: &Value) -> Option<JsString> {
    match value.get("method") {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

pub(super) fn params_of(value: &Value) -> Option<Value> {
    value.get("params").cloned()
}

/// `#answer`'s reply value, success or failure.
pub(super) fn answer_value(server_id: &RpcId, result: Result<&Value, (f64, &str)>) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("id", id_value(server_id));
    match result {
        Ok(result) => map.insert("result", result.clone()),
        Err((code, message)) => {
            let mut error = Map::with_capacity(2);
            error.insert("code", Value::from(code));
            error.insert("message", Value::from(message));
            map.insert("error", Value::Object(error))
        }
    };
    Value::Object(map)
}

pub(super) fn id_value(id: &RpcId) -> Value {
    match id {
        RpcId::Text(text) => Value::String(text.clone()),
        RpcId::Number(number) => Value::from(*number),
    }
}

/// `JSON.stringify({jsonrpc, id, method, ...(params === undefined ? {} : {params})})`.
pub(super) fn request_value(id: &RpcId, method: &str, params: Option<&Value>) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("id", id_value(id));
    map.insert("method", Value::from(method));
    if let Some(params) = params {
        map.insert("params", params.clone());
    }
    Value::Object(map)
}

pub(super) fn notification_value(method: &str, params: Option<&Value>) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("method", Value::from(method));
    if let Some(params) = params {
        map.insert("params", params.clone());
    }
    Value::Object(map)
}

/// A frame's line for stdin, and the text a consumer publishes when the config asks for
/// it: one serialization, so the published frame is the bytes the pipe reads.
pub(super) fn wire_frame(value: &Value, keep_text: bool) -> (Option<String>, Vec<u8>) {
    let text = value.to_json();
    if keep_text {
        let mut wire = Vec::with_capacity(text.len() + 1);
        wire.extend_from_slice(text.as_bytes());
        wire.push(b'\n');
        return (Some(text), wire);
    }
    let mut wire = text.into_bytes();
    wire.push(b'\n');
    (None, wire)
}
