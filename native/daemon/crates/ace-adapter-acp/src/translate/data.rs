// SPDX-License-Identifier: Apache-2.0
//! Dynamic provider data helpers (`data.ts`): read without copying,
//! build raw payloads with TypeScript field order.

use ace_json::{Map, Value};
use std::sync::LazyLock;

static EMPTY_MAP: LazyLock<Map> = LazyLock::new(Map::new);
static EMPTY_LIST: LazyLock<Vec<Value>> = LazyLock::new(Vec::new);

/// The value as an object, or the shared empty one.
pub fn object(value: &Value) -> &Map {
    match value {
        Value::Object(map) => map,
        _ => &EMPTY_MAP,
    }
}

/// The value as a string, or empty.
pub fn string(value: &Value) -> &str {
    match value {
        Value::String(text) => text.as_str(),
        _ => "",
    }
}

/// The value as an exact JavaScript string, lone surrogates included.
pub fn js_string(value: &Value) -> Option<&ace_json::JsString> {
    match value {
        Value::String(text) => Some(text),
        _ => None,
    }
}

/// The value as a list, or the shared empty one.
pub fn list(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items.as_slice(),
        _ => &EMPTY_LIST,
    }
}

/// A raw payload with TypeScript field order: type, data, then name.
pub fn raw(data: &Value, typ: &str, name: Option<&str>) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from(typ.to_owned()));
    map.insert("data".to_owned(), data.clone());
    if let Some(name) = name {
        map.insert("name".to_owned(), Value::from(name.to_owned()));
    }
    Value::Object(map)
}

/// An RPC id when the value is a string or a finite number.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RpcId {
    Str(String),
    Int(i64),
    FloatBits(u64),
}

impl RpcId {
    pub fn typeof_name(&self) -> &'static str {
        match self {
            RpcId::Str(_) => "string",
            RpcId::Int(_) | RpcId::FloatBits(_) => "number",
        }
    }

    pub fn display(&self) -> String {
        match self {
            RpcId::Str(text) => text.clone(),
            RpcId::Int(n) => n.to_string(),
            RpcId::FloatBits(bits) => {
                // `String(id)` in TypeScript: JavaScript number printing.
                let value = f64::from_bits(*bits);
                ace_json::Number::from_f64_lossy(value).to_string()
            }
        }
    }
}

/// Read an RPC id like the TypeScript `rpcId` helper.
pub fn rpc_id(value: &Value) -> Option<RpcId> {
    match value {
        Value::String(text) => Some(RpcId::Str(String::from(text.clone()))),
        Value::Number(number) => {
            if let Some(n) = number.as_i64() {
                Some(RpcId::Int(n))
            } else if let Some(n) = number.as_u64() {
                if n <= i64::MAX as u64 {
                    Some(RpcId::Int(n as i64))
                } else {
                    let float_value = n as f64;
                    if float_value.is_finite() {
                        Some(RpcId::FloatBits(float_value.to_bits()))
                    } else {
                        None
                    }
                }
            } else if let Some(f) = number.as_f64() {
                if f.is_finite() {
                    Some(RpcId::FloatBits(f.to_bits()))
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    }
}
