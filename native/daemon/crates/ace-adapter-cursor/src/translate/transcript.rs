// SPDX-License-Identifier: Apache-2.0
//! Order identity, never text equality (`transcript.ts`). Only the SDK delta
//! channel owns live content.

use std::collections::BTreeMap;

use super::text::{JsString, Value};
use super::{BudgetError, BudgetResult};

struct Position {
    order: u64,
    text: Option<JsString>,
    thinking: Option<JsString>,
    field: Option<Field>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Text,
    Thinking,
}

/// The open items per agent, keyed by agent key with an order per field.
pub struct Transcript {
    prefix: JsString,
    limit: usize,
    positions: BTreeMap<JsString, Position>,
}

impl Transcript {
    pub fn new(prefix: JsString, limit: usize) -> Self {
        Transcript {
            prefix,
            limit,
            positions: BTreeMap::new(),
        }
    }

    pub fn append(
        &mut self,
        agent: &JsString,
        field: &str,
        text: &JsString,
    ) -> BudgetResult<Vec<Value>> {
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let limit = self.limit;
        if !self.positions.contains_key(agent) {
            if self.positions.len() >= limit {
                return Err(BudgetError::Exceeded);
            }
            self.positions.insert(
                agent.clone(),
                Position {
                    order: 0,
                    text: None,
                    thinking: None,
                    field: None,
                },
            );
        }
        let position = self.positions.get_mut(agent).ok_or(BudgetError::Exceeded)?;
        let mut facts = Vec::new();
        let want = if field == "text" {
            Field::Text
        } else {
            Field::Thinking
        };
        let current = if want == Field::Text {
            position.text.as_ref()
        } else {
            position.thinking.as_ref()
        };
        if position.field != Some(want) || current.is_none() {
            let agent_units = agent.clone();
            facts.extend(self.boundary(&agent_units));
            let position = self.positions.get_mut(agent).ok_or(BudgetError::Exceeded)?;
            position.order += 1;
            let order = position.order.to_string();
            let order = order.encode_utf16().collect::<JsString>();
            let mut item = self.prefix.clone();
            item.push_str(":");
            item.push_js(agent);
            item.push_str(":");
            item.push_js(&field.encode_utf16().collect::<JsString>());
            item.push_str(":");
            item.push_js(&order);
            if want == Field::Text {
                position.text = Some(item.clone());
                position.field = Some(Field::Text);
                facts.push(Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("item.upsert")),
                    ),
                    (JsString::from("agent"), Value::String(agent.clone())),
                    (JsString::from("item"), Value::String(item)),
                    (
                        JsString::from("draft"),
                        Value::from(vec![
                            (
                                JsString::from("type"),
                                Value::String(JsString::from("message")),
                            ),
                            (
                                JsString::from("role"),
                                Value::String(JsString::from("assistant")),
                            ),
                            (
                                JsString::from("parts"),
                                Value::Array(ace_json::Array::new()),
                            ),
                            (JsString::from("complete"), Value::Bool(false)),
                        ]),
                    ),
                ]));
            } else {
                position.thinking = Some(item.clone());
                position.field = Some(Field::Thinking);
                facts.push(Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("item.upsert")),
                    ),
                    (JsString::from("agent"), Value::String(agent.clone())),
                    (JsString::from("item"), Value::String(item)),
                    (
                        JsString::from("draft"),
                        Value::from(vec![
                            (
                                JsString::from("type"),
                                Value::String(JsString::from("reasoning")),
                            ),
                            (JsString::from("text"), Value::String(JsString::new())),
                            (JsString::from("complete"), Value::Bool(false)),
                        ]),
                    ),
                ]));
            }
        }
        let position = self.positions.get(agent).ok_or(BudgetError::Exceeded)?;
        let item = if want == Field::Text {
            position.text.clone()
        } else {
            position.thinking.clone()
        };
        if let Some(item) = item {
            facts.push(Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("item.delta")),
                ),
                (JsString::from("agent"), Value::String(agent.clone())),
                (JsString::from("item"), Value::String(item)),
                (
                    JsString::from("field"),
                    Value::String(JsString::from(if want == Field::Text {
                        "text"
                    } else {
                        "reasoning"
                    })),
                ),
                (JsString::from("append"), Value::String(text.clone())),
            ]));
        }
        Ok(facts)
    }

    pub fn boundary(&mut self, agent: &JsString) -> Vec<Value> {
        let position = match self.positions.get_mut(agent) {
            Some(position) => position,
            None => return Vec::new(),
        };
        let (item, kind) = match position.field {
            Some(Field::Thinking) => (position.thinking.take(), "reasoning"),
            Some(Field::Text) => (position.text.take(), "message"),
            None => (None, "message"),
        };
        position.field = None;
        match item {
            Some(item) => vec![Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("item.upsert")),
                ),
                (JsString::from("agent"), Value::String(agent.clone())),
                (JsString::from("item"), Value::String(item)),
                (
                    JsString::from("draft"),
                    Value::from(vec![
                        (JsString::from("type"), Value::String(JsString::from(kind))),
                        (JsString::from("complete"), Value::Bool(true)),
                    ]),
                ),
            ])],
            None => Vec::new(),
        }
    }

    pub fn end(&mut self) -> Vec<Value> {
        let agents: Vec<JsString> = self.positions.keys().cloned().collect();
        let mut facts = Vec::new();
        for agent in &agents {
            facts.extend(self.boundary(agent));
        }
        facts
    }
}
