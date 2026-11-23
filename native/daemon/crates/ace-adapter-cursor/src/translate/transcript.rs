// SPDX-License-Identifier: Apache-2.0
//! Order identity, never text equality (`transcript.ts`). Only the SDK delta
//! channel owns live content.

use std::collections::BTreeMap;

use super::json::{J, encode_units};
use super::{BudgetError, BudgetResult};

struct Position {
    order: u64,
    text: Option<Vec<u16>>,
    thinking: Option<Vec<u16>>,
    field: Option<Field>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Text,
    Thinking,
}

/// The open items per agent, keyed by agent key with an order per field.
pub struct Transcript {
    prefix: Vec<u16>,
    limit: usize,
    positions: BTreeMap<Vec<u16>, Position>,
}

impl Transcript {
    pub fn new(prefix: Vec<u16>, limit: usize) -> Self {
        Transcript {
            prefix,
            limit,
            positions: BTreeMap::new(),
        }
    }

    pub fn append(&mut self, agent: &[u16], field: &str, text: &[u16]) -> BudgetResult<Vec<J>> {
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let limit = self.limit;
        if !self.positions.contains_key(agent) {
            if self.positions.len() >= limit {
                return Err(BudgetError::Exceeded);
            }
            self.positions.insert(
                agent.to_vec(),
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
            let agent_units = agent.to_vec();
            facts.extend(self.boundary(&agent_units));
            let position = self.positions.get_mut(agent).ok_or(BudgetError::Exceeded)?;
            position.order += 1;
            let order = position.order.to_string();
            let order = order.encode_utf16().collect::<Vec<u16>>();
            let mut item = self.prefix.clone();
            item.push(u16::from(b':'));
            item.extend_from_slice(agent);
            item.push(u16::from(b':'));
            item.extend_from_slice(&field.encode_utf16().collect::<Vec<u16>>());
            item.push(u16::from(b':'));
            item.extend_from_slice(&order);
            if want == Field::Text {
                position.text = Some(item.clone());
                position.field = Some(Field::Text);
                facts.push(J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("item.upsert"))),
                    (encode_units("agent"), J::Str(agent.to_vec())),
                    (encode_units("item"), J::Str(item)),
                    (
                        encode_units("draft"),
                        J::Obj(vec![
                            (encode_units("type"), J::Str(encode_units("message"))),
                            (encode_units("role"), J::Str(encode_units("assistant"))),
                            (encode_units("parts"), J::Arr(Vec::new())),
                            (encode_units("complete"), J::Bool(false)),
                        ]),
                    ),
                ]));
            } else {
                position.thinking = Some(item.clone());
                position.field = Some(Field::Thinking);
                facts.push(J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("item.upsert"))),
                    (encode_units("agent"), J::Str(agent.to_vec())),
                    (encode_units("item"), J::Str(item)),
                    (
                        encode_units("draft"),
                        J::Obj(vec![
                            (encode_units("type"), J::Str(encode_units("reasoning"))),
                            (encode_units("text"), J::Str(Vec::new())),
                            (encode_units("complete"), J::Bool(false)),
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
            facts.push(J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("item.delta"))),
                (encode_units("agent"), J::Str(agent.to_vec())),
                (encode_units("item"), J::Str(item)),
                (
                    encode_units("field"),
                    J::Str(encode_units(if want == Field::Text {
                        "text"
                    } else {
                        "reasoning"
                    })),
                ),
                (encode_units("append"), J::Str(text.to_vec())),
            ]));
        }
        Ok(facts)
    }

    pub fn boundary(&mut self, agent: &[u16]) -> Vec<J> {
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
            Some(item) => vec![J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("item.upsert"))),
                (encode_units("agent"), J::Str(agent.to_vec())),
                (encode_units("item"), J::Str(item)),
                (
                    encode_units("draft"),
                    J::Obj(vec![
                        (encode_units("type"), J::Str(encode_units(kind))),
                        (encode_units("complete"), J::Bool(true)),
                    ]),
                ),
            ])],
            None => Vec::new(),
        }
    }

    pub fn end(&mut self) -> Vec<J> {
        let agents: Vec<Vec<u16>> = self.positions.keys().cloned().collect();
        let mut facts = Vec::new();
        for agent in &agents {
            facts.extend(self.boundary(agent));
        }
        facts
    }
}
