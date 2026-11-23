// SPDX-License-Identifier: Apache-2.0
//! Dynamic provider data helpers (`data.ts`): read without copying,
//! build raw payloads with TypeScript field order.

use serde_json::{Map, Value};
use std::sync::LazyLock;

static EMPTY_MAP: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
static EMPTY_LIST: LazyLock<Vec<Value>> = LazyLock::new(Vec::new);

/// The value as an object, or the shared empty one.
pub fn object(value: &Value) -> &Map<String, Value> {
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
    map.insert("type".to_owned(), Value::String(typ.to_owned()));
    map.insert("data".to_owned(), data.clone());
    if let Some(name) = name {
        map.insert("name".to_owned(), Value::String(name.to_owned()));
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
                let value = f64::from_bits(*bits);
                // Match JavaScript number to string for ids: integers print without decimal.
                if value.fract() == 0.0 && value.abs() < 1e21 {
                    format!("{}", value as i64)
                } else {
                    format!("{value}")
                }
            }
        }
    }
}

/// Read an RPC id like the TypeScript `rpcId` helper.
pub fn rpc_id(value: &Value) -> Option<RpcId> {
    match value {
        Value::String(text) => Some(RpcId::Str(text.clone())),
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

#[cfg(test)]
mod tests {
    use super::{RpcId, list, object, raw, rpc_id, string};
    use serde_json::json;

    #[test]
    fn non_objects_read_as_empty_without_copying_shape() {
        assert_eq!(object(&json!([1])).len(), 0);
        assert_eq!(string(&json!(3)), "");
        assert_eq!(list(&json!("x")).len(), 0);
        assert_eq!(string(&json!("hi")), "hi");
    }

    #[test]
    fn raw_orders_type_data_then_name() {
        let payload = raw(&json!({"a": 1}), "session/update", Some("n"));
        let text = serde_json::to_string(&payload).unwrap_or_default();
        assert_eq!(
            text,
            r#"{"type":"session/update","data":{"a":1},"name":"n"}"#
        );
    }

    #[test]
    fn rpc_ids_accept_strings_and_finite_numbers_only() {
        assert_eq!(rpc_id(&json!("a")), Some(RpcId::Str("a".to_owned())));
        assert_eq!(rpc_id(&json!(2)), Some(RpcId::Int(2)));
        assert_eq!(rpc_id(&json!(true)), None);
    }
}
