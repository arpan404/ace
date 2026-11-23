// SPDX-License-Identifier: Apache-2.0
//! Cumulative shell output snapshots (`shell-output.ts`).

use crate::translate::data::object;
use crate::translate::state::TranslationState;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Debug, Clone)]
struct Stream {
    length: usize,
    head: String,
    tail: String,
}

const EDGE: usize = 256;

fn digest(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let result = hasher.finalize();
    let mut out = String::with_capacity(result.len() * 2);
    for byte in result {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn head(text: &str, length: usize) -> String {
    let end = std::cmp::min(EDGE, length);
    digest(text.get(..end).unwrap_or(text))
}

fn tail(text: &str, length: usize) -> String {
    let start = length.saturating_sub(EDGE);
    let end = std::cmp::min(length, text.len());
    digest(text.get(start..end).unwrap_or(""))
}

/// What one native output stream has published.
#[derive(Default)]
pub struct ShellOutput {
    streams: HashMap<String, HashMap<String, Stream>>,
}

impl ShellOutput {
    pub fn append(
        &mut self,
        state: &mut TranslationState,
        tool_key: &str,
        update: &Value,
        facts: &mut Vec<Value>,
    ) {
        let output = object(update.get("rawOutput").unwrap_or(&Value::Null));
        let mut snapshots: Vec<(String, String)> = Vec::new();
        if let Some(Value::String(combined)) = output.get("combinedOutput") {
            snapshots.push(("combined".to_owned(), combined.clone()));
        } else {
            for name in ["stdout", "stderr"] {
                if let Some(Value::String(text)) = output.get(name) {
                    snapshots.push((name.to_owned(), text.clone()));
                }
            }
        }
        if snapshots.is_empty() {
            return;
        }
        let streams = self.streams.entry(tool_key.to_owned()).or_default();
        let mut append_text = String::new();
        // Resolve owner and tool details before borrowing facts.
        let owner_key = state
            .tools
            .get(tool_key)
            .map(|tool| tool.owner_key.clone())
            .unwrap_or_default();
        for (name, text) in snapshots {
            let length = streams.get(&name).map(|s| s.length).unwrap_or(0);
            let continues = match streams.get(&name) {
                None => true,
                Some(stream) => {
                    text.len() >= length
                        && head(&text, length) == stream.head
                        && tail(&text, length) == stream.tail
                }
            };
            if continues && text.len() == length {
                continue;
            }
            if !continues {
                state.notice(
                    facts,
                    update.get("rawOutput").unwrap_or(&Value::Null),
                    "shell/output-replacement",
                    Some("Shell output replaced earlier text; the replacement is retained in raw data."),
                    Some(&owner_key),
                );
                continue;
            }
            append_text.push_str(text.get(length..).unwrap_or(""));
            streams.insert(
                name,
                Stream {
                    length: text.len(),
                    head: head(&text, text.len()),
                    tail: tail(&text, text.len()),
                },
            );
        }
        if !append_text.is_empty() {
            let mut fact = serde_json::Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::String("item.delta".to_owned()));
            fact.insert("agent".to_owned(), Value::String(owner_key));
            let item_key = state
                .tools
                .get(tool_key)
                .map(|tool| tool.key.clone())
                .unwrap_or_default();
            fact.insert("item".to_owned(), Value::String(item_key));
            fact.insert("field".to_owned(), Value::String("output".to_owned()));
            fact.insert("append".to_owned(), Value::String(append_text));
            facts.push(Value::Object(fact));
        }
    }
}
