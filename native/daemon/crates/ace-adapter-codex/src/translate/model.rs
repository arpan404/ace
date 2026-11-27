// SPDX-License-Identifier: Apache-2.0
//! Model confirmation: the agent's model, linked when it changes.

use ace_core::RawFact;
use ace_json::{JsString, Map, Value};

use super::facts::fact;
use super::state::Agent;

/// A model from `model.ts` that can be linked to an agent.
pub(super) fn bounded_model(value: &Value) -> Option<&JsString> {
    value
        .as_js_str()
        .filter(|text| !text.is_empty() && text.len_code_points() <= 256)
}

pub fn confirm_model(agent: &mut Agent, value: Option<&Value>, facts: &mut Vec<RawFact>) {
    let Some(model) = value.and_then(bounded_model).cloned() else {
        return;
    };
    if agent.model.as_deref() == Some(model.as_str()) {
        return;
    }
    agent.model = Some(String::from(model.clone()));
    let mut body = Map::with_capacity(2);
    body.insert("agent".to_owned(), Value::from(agent.key.clone()));
    body.insert("model".to_owned(), Value::String(model));
    facts.push(fact("agent.linked", body));
}

#[cfg(test)]
mod length_tests {
    use super::*;

    #[test]
    fn an_agent_links_a_model_of_up_to_256_emoji() {
        for length in [256, 257] {
            let value = Value::from("😀".repeat(length));
            let mut agent = Agent::new("agent".to_owned(), None, true);
            let mut facts = Vec::new();
            confirm_model(&mut agent, Some(&value), &mut facts);
            assert_eq!(facts.len(), usize::from(length == 256));
            if let Some(fact) = facts.first() {
                assert_eq!(
                    ace_json::parse(fact.data.get()).expect("fact").get("model"),
                    Some(&value)
                );
            }
        }
    }
}
