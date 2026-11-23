// SPDX-License-Identifier: Apache-2.0
//! Order identity, never text equality (`transcript.ts`). Only the SDK delta
//! channel owns live content.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{BudgetError, BudgetResult};

struct Position {
    order: u64,
    text: Option<String>,
    thinking: Option<String>,
    field: Option<Field>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Text,
    Thinking,
}

/// The open items per agent, keyed by agent key with an order per field.
pub struct Transcript {
    prefix: String,
    limit: usize,
    positions: BTreeMap<String, Position>,
}

impl Transcript {
    pub fn new(prefix: String, limit: usize) -> Self {
        Transcript {
            prefix,
            limit,
            positions: BTreeMap::new(),
        }
    }

    pub fn append(&mut self, agent: &str, field: &str, text: &str) -> BudgetResult<Vec<Value>> {
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let limit = self.limit;
        let position = match self.positions.get_mut(agent) {
            Some(position) => position,
            None => {
                if self.positions.len() >= limit {
                    return Err(BudgetError::Exceeded);
                }
                self.positions.insert(
                    agent.to_owned(),
                    Position {
                        order: 0,
                        text: None,
                        thinking: None,
                        field: None,
                    },
                );
                self.positions.get_mut(agent).ok_or(BudgetError::Exceeded)?
            }
        };
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
            let agent_owned = agent.to_owned();
            facts.extend(self.boundary(&agent_owned));
            let position = self.positions.get_mut(agent).ok_or(BudgetError::Exceeded)?;
            position.order += 1;
            let item = format!("{}:{agent}:{field}:{}", self.prefix, position.order);
            if want == Field::Text {
                position.text = Some(item);
                position.field = Some(Field::Text);
                facts.push(json!({
                    "type": "item.upsert",
                    "agent": agent,
                    "item": position.text,
                    "draft": { "type": "message", "role": "assistant", "parts": [], "complete": false },
                }));
            } else {
                position.thinking = Some(item);
                position.field = Some(Field::Thinking);
                facts.push(json!({
                    "type": "item.upsert",
                    "agent": agent,
                    "item": position.thinking,
                    "draft": { "type": "reasoning", "text": "", "complete": false },
                }));
            }
        }
        let position = self.positions.get(agent).ok_or(BudgetError::Exceeded)?;
        let item = if want == Field::Text {
            position.text.clone()
        } else {
            position.thinking.clone()
        };
        if let Some(item) = item {
            facts.push(json!({
                "type": "item.delta",
                "agent": agent,
                "item": item,
                "field": field,
                "append": text,
            }));
        }
        Ok(facts)
    }

    pub fn boundary(&mut self, agent: &str) -> Vec<Value> {
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
            Some(item) => vec![json!({
                "type": "item.upsert",
                "agent": agent,
                "item": item,
                "draft": { "type": kind, "complete": true },
            })],
            None => Vec::new(),
        }
    }

    pub fn end(&mut self) -> Vec<Value> {
        let agents: Vec<String> = self.positions.keys().cloned().collect();
        let mut facts = Vec::new();
        for agent in &agents {
            facts.extend(self.boundary(agent));
        }
        facts
    }
}
