// SPDX-License-Identifier: Apache-2.0
//! Answer echoes: match the next exact-text echo in the answered thread.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::helpers::{obj_map, str_empty};

fn digest_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let out = hasher.finalize();
    let mut s = String::with_capacity(out.len() * 2);
    for b in out {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

struct Pending {
    thread: String,
    key: String,
    text_hash: String,
    origin: Value,
}

pub struct AnswerEchoes {
    pending: VecDeque<Pending>,
    matched: HashMap<String, Value>,
    matched_order: VecDeque<String>,
}

impl AnswerEchoes {
    pub fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            matched: HashMap::new(),
            matched_order: VecDeque::new(),
        }
    }

    pub fn note(&mut self, data: &Value) {
        let map = obj_map(data);
        let thread = str_empty(map.get("threadId")).to_owned();
        let key = str_empty(map.get("interaction")).to_owned();
        let event = str_empty(map.get("event"));
        if event == "interaction-answer-failed" {
            if let Some(index) = self
                .pending
                .iter()
                .position(|entry| entry.thread == thread && entry.key == key)
            {
                self.pending.remove(index);
            }
            return;
        }
        if event != "interaction-answer" {
            return;
        }
        if thread.is_empty() || utf16_len(&thread) > 1024 || utf16_len(&key) > 1024 {
            if thread.is_empty() {
                return;
            }
            if utf16_len(&thread) > 1024 || utf16_len(&key) > 1024 {
                return;
            }
        }
        let text = match map.get("text") {
            Some(Value::String(s)) => s.clone(),
            _ => return,
        };
        let interaction_id = match map.get("interactionId") {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        if self.pending.len() >= 256 {
            self.pending.pop_front();
        }
        let mut origin_map = serde_json::Map::with_capacity(2);
        origin_map.insert(
            "kind".to_owned(),
            Value::String("interaction_answer".to_owned()),
        );
        if let Some(id) = interaction_id {
            origin_map.insert("interactionId".to_owned(), Value::String(id));
        }
        self.pending.push_back(Pending {
            thread,
            key,
            text_hash: digest_hex(&text),
            origin: Value::Object(origin_map),
        });
    }

    pub fn matches(&mut self, thread: &str, item: &str, text: &str) -> Option<Value> {
        if utf16_len(thread) > 1024 || utf16_len(item) > 1024 {
            return None;
        }
        let identity = serde_json::to_string(&vec![thread, item])
            .unwrap_or_default()
            .to_string();
        if let Some(previous) = self.matched.get(&identity) {
            return Some(previous.clone());
        }
        let hash = digest_hex(text);
        let index = self
            .pending
            .iter()
            .position(|entry| entry.thread == thread && entry.text_hash == hash)?;
        let entry = self.pending.remove(index)?;
        if self.matched.len() >= 1024
            && let Some(oldest) = self.matched_order.pop_front()
        {
            self.matched.remove(&oldest);
        }
        self.matched_order.push_back(identity.clone());
        self.matched.insert(identity.clone(), entry.origin.clone());
        self.matched.get(&identity).cloned()
    }
}

impl Default for AnswerEchoes {
    fn default() -> Self {
        Self::new()
    }
}
