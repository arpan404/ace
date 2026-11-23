// SPDX-License-Identifier: Apache-2.0
//! Fact and diagnostic builders: the JSON must be field for field what the
//! TypeScript emits, since core validates it.

use ace_core::Fact;
use serde_json::{Map, Value};

/// Build a fact: `type` first, then the body's fields in insertion order.
pub fn fact(fact_type: &str, body: Map<String, Value>) -> Fact {
    let data = serde_json::value::to_raw_value(&Value::Object(body)).unwrap_or_default();
    Fact {
        fact_type: fact_type.to_owned(),
        data,
    }
}

pub fn empty_body() -> Map<String, Value> {
    Map::new()
}

pub fn with_agent(mut body: Map<String, Value>, agent: &str) -> Map<String, Value> {
    body.insert("agent".to_owned(), Value::String(agent.to_owned()));
    body
}

/// `raw(type, data, name?)`: one raw payload keeping the redacted encoding.
pub fn raw_payload(payload_type: &str, data: &Value, name: Option<&str>) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::String(payload_type.to_owned()));
    if let Some(name) = name {
        map.insert("name".to_owned(), Value::String(name.to_owned()));
    }
    map.insert("data".to_owned(), data.clone());
    Value::Object(map)
}

pub fn signal_fact(agent: Option<&str>) -> Fact {
    let mut body = Map::new();
    if let Some(agent) = agent {
        body.insert("agent".to_owned(), Value::String(agent.to_owned()));
    }
    fact("signal", body)
}
