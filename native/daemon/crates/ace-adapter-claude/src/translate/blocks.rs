// SPDX-License-Identifier: Apache-2.0
//! Message block identities (the port of `blocks.ts`).
//! Stable child identities contain only ids, hashes and stream indices,
//! never payloads.

use serde_json::Value;
use std::collections::HashMap;

use super::json::{object, str_of};

pub struct MessageBlocks {
    pub id: String,
    pub next: i64,
    pub identities: HashMap<String, i64>,
}

#[derive(Clone)]
pub struct BlockSlot {
    pub kind: String,
    pub item: String,
}

pub struct StreamState {
    pub id: String,
    pub blocks: HashMap<i64, BlockSlot>,
    pub unmatched: HashMap<String, Vec<i64>>,
    pub cursors: HashMap<String, i64>,
}

pub struct MessageIndex {
    root: String,
    root_message: Option<MessageBlocks>,
    children: HashMap<String, HashMap<String, MessageBlocks>>,
}

impl MessageIndex {
    pub fn new(root: &str) -> Self {
        MessageIndex {
            root: root.to_owned(),
            root_message: None,
            children: HashMap::new(),
        }
    }

    pub fn with_message<R>(
        &mut self,
        agent: &str,
        id: &str,
        run: impl FnOnce(&mut MessageBlocks) -> R,
    ) -> R {
        if agent == self.root {
            if self
                .root_message
                .as_ref()
                .map(|m| m.id.as_str() != id)
                .unwrap_or(true)
            {
                self.root_message = Some(MessageBlocks {
                    id: id.to_owned(),
                    next: 0,
                    identities: HashMap::new(),
                });
            }
            if let Some(slot) = self.root_message.as_mut() {
                return run(slot);
            }
            self.root_message = Some(MessageBlocks {
                id: id.to_owned(),
                next: 0,
                identities: HashMap::new(),
            });
            if let Some(slot) = self.root_message.as_mut() {
                return run(slot);
            }
            // Both inserts failed only if the map rejects allocation;
            // fall through to a detached block so translation continues.
            let mut detached = MessageBlocks {
                id: id.to_owned(),
                next: 0,
                identities: HashMap::new(),
            };
            return run(&mut detached);
        }
        let messages = self.children.entry(agent.to_owned()).or_default();
        let slot = messages
            .entry(id.to_owned())
            .or_insert_with(|| MessageBlocks {
                id: id.to_owned(),
                next: 0,
                identities: HashMap::new(),
            });
        run(slot)
    }

    pub fn end_root(&mut self) {
        self.root_message = None;
    }

    pub fn clear(&mut self) {
        self.end_root();
        self.children.clear();
    }
}

pub fn match_block(
    current: &mut MessageBlocks,
    block: &Value,
    index: i64,
    uuid: &str,
    stream: Option<&mut StreamState>,
) -> i64 {
    let identity = if uuid.is_empty() {
        format!("{index}:{}", fingerprint(block))
    } else {
        format!("{uuid}:{index}")
    };
    if let Some(prior) = current.identities.get(&identity) {
        return *prior;
    }
    let kind = str_of(object(block).get("type").unwrap_or(&Value::Null));
    let streamed = match stream {
        Some(s) => {
            let cursor = s.cursors.get(&kind).copied().unwrap_or(0);
            match s
                .unmatched
                .get(&kind)
                .and_then(|v| v.get(cursor as usize))
                .copied()
            {
                Some(idx) => {
                    s.cursors.insert(kind.clone(), cursor + 1);
                    Some(idx)
                }
                None => None,
            }
        }
        None => None,
    };
    let result = streamed.unwrap_or(current.next);
    if result + 1 > current.next {
        current.next = result + 1;
    }
    current.identities.insert(identity, result);
    result
}

fn fingerprint(block: &Value) -> String {
    let obj = object(block);
    let mut value = String::new();
    for key in ["type", "id", "text", "thinking", "signature"] {
        value.push_str(str_of(obj.get(key).unwrap_or(&Value::Null)).as_str());
        value.push('\0');
    }
    let len = value.len();
    let mut first: u32 = 2_166_135_261;
    let mut second: u32 = 5381;
    for byte in value.bytes() {
        first = first.wrapping_mul(16_777_619) ^ (byte as u32);
        // Math.imul(second, 33) ^ byte: 32-bit wrap.
        second = second.wrapping_mul(33) ^ (byte as u32);
    }
    format!("{len}:{}:{}", first, second)
}
