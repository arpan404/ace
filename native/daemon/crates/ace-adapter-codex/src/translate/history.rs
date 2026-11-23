// SPDX-License-Identifier: Apache-2.0
//! History assembly: rebuild a thread snapshot from bounded history notes.

use std::collections::HashMap;

use ace_json::{Map, Value};

use super::helpers::{list_of, obj_map, str_empty};

struct Read {
    read: f64,
    turns: Vec<Value>,
}

pub struct HistoryAssembly {
    reads: HashMap<String, Read>,
}

impl HistoryAssembly {
    pub fn new() -> Self {
        Self {
            reads: HashMap::new(),
        }
    }

    pub fn add(&mut self, note: &Map) {
        let thread = str_empty(note.get("threadId")).to_owned();
        let read = match note.get("read") {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            _ => return,
        };
        if thread.is_empty() {
            return;
        }
        let entry = self.reads.entry(thread).or_insert_with(|| Read {
            read,
            turns: Vec::new(),
        });
        if entry.read != read {
            entry.read = read;
            entry.turns.clear();
        }
        for value in list_of(note.get("turns")) {
            let turn = obj_map(value);
            let id = str_empty(turn.get("id")).to_owned();
            let last_is_same = entry.turns.last().is_some_and(|last| {
                let last_map = obj_map(last);
                !id.is_empty() && str_empty(last_map.get("id")) == id
            });
            if last_is_same {
                if let Some(last) = entry.turns.last_mut() {
                    let mut merged_items = list_of(obj_map(last).get("items")).to_vec();
                    merged_items.extend(list_of(turn.get("items")).iter().cloned());
                    if let Value::Object(last_map) = last {
                        last_map.insert("items".to_owned(), Value::from(merged_items));
                    }
                }
            } else {
                entry.turns.push(Value::Object(turn.clone()));
            }
        }
    }

    pub fn complete(&mut self, note: &Map) -> Value {
        let thread = note.get("thread").map(obj_map).cloned().unwrap_or_default();
        let id = str_empty(thread.get("id")).to_owned();
        let entry = self.reads.remove(&id);
        let history_number = match note.get("history") {
            Some(Value::Number(n)) => n.as_f64(),
            _ => None,
        };
        let history = match (entry, history_number) {
            (Some(entry), Some(want)) if entry.read == want => entry.turns,
            _ => Vec::new(),
        };
        let mut out = thread;
        let mut turns = history;
        turns.extend(list_of(out.get("turns")).iter().cloned());
        out.insert("turns".to_owned(), Value::from(turns));
        Value::Object(out)
    }
}

impl Default for HistoryAssembly {
    fn default() -> Self {
        Self::new()
    }
}

/// An opening reply that excluded turns: metadata, no turns or status to act on.
pub fn metadata_only(thread: &Map) -> Value {
    let mut out = Map::new();
    for (key, value) in thread {
        if key != "turns" && key != "status" {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}
