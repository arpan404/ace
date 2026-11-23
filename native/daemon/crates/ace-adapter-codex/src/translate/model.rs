// SPDX-License-Identifier: Apache-2.0
//! Model confirmation: the agent's model, linked when it changes.

use ace_core::RawFact;
use serde_json::{Map, Value};

use super::facts::fact;
use super::state::Agent;

pub fn confirm_model(agent: &mut Agent, value: Option<&Value>, facts: &mut Vec<RawFact>) {
    let model = match value {
        Some(Value::String(s)) if !s.is_empty() && s.encode_utf16().count() <= 256 => s.clone(),
        _ => return,
    };
    if agent.model.as_deref() == Some(model.as_str()) {
        return;
    }
    agent.model = Some(model.clone());
    let mut body = Map::with_capacity(2);
    body.insert("agent".to_owned(), Value::String(agent.key.clone()));
    body.insert("model".to_owned(), Value::String(model));
    facts.push(fact("agent.linked", body));
}
