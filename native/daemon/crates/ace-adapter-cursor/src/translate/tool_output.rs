// SPDX-License-Identifier: Apache-2.0
//! Streaming shell output and surviving-call fences (`tool-events.ts`,
//! output and preserve).

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::BudgetResult;
use super::children::Children;
use super::envelope::{Envelope, native_identity, string};
use super::tool_events::ToolEvents;
use super::tools::tool_kind;
use super::transcript::Transcript;

impl ToolEvents {
    #[allow(clippy::too_many_arguments)]
    pub fn output(
        &mut self,
        body: &Map<String, Value>,
        agent: &str,
        namespace: &str,
        event: &Envelope,
        envelope: &Value,
        transcript: &mut Transcript,
        children: &mut Children,
        operation: Option<&str>,
        segment: i64,
        cwd: &str,
        notice: &mut dyn FnMut(&str, &Value, &str) -> Value,
    ) -> BudgetResult<Vec<Value>> {
        let id = native_identity(body.get("callId").unwrap_or(&Value::Null))?;
        let text = string(body.get("text").unwrap_or(&Value::Null)).unwrap_or("");
        let Some(id) = id else { return Ok(Vec::new()) };
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let key = format!("{namespace}:call:{id}");
        let mut facts = Vec::new();
        if !self.calls.contains_key(&key) {
            let mut started = Map::new();
            started.insert(
                "type".to_owned(),
                Value::String("tool-call-started".to_owned()),
            );
            started.insert("callId".to_owned(), Value::String(id.clone()));
            if let Some(tool_call) = body.get("toolCall") {
                started.insert("toolCall".to_owned(), tool_call.clone());
            }
            facts.extend(self.translate(
                &started,
                agent,
                namespace,
                Some(event),
                envelope,
                transcript,
                children,
                operation,
                segment,
                cwd,
                notice,
            )?);
        }
        let Some(tool) = self.calls.get_mut(&key) else {
            return Ok(facts);
        };
        if tool_kind(&tool.name) != "shell" || tool.terminal {
            return Ok(facts);
        }
        tool.output = true;
        let owner = tool.agent.clone();
        facts.push(json!({
            "type": "item.delta",
            "agent": owner,
            "item": key,
            "field": "output",
            "append": text,
        }));
        Ok(facts)
    }

    pub fn preserve(&mut self, owner: Option<&str>) -> Vec<Value> {
        let mut facts = Vec::new();
        let owners: Vec<String> = match owner {
            Some(owner) => vec![owner.to_owned()],
            None => self.pending_by_owner.keys().cloned().collect(),
        };
        for key in owners {
            let pending: Vec<String> = self
                .pending_by_owner
                .get(&key)
                .map(|pending| pending.iter().cloned().collect())
                .unwrap_or_default();
            for item in pending {
                let ready = self.calls.get(&item).is_some_and(|tool| {
                    !tool.terminal && !tool.surviving && tool_kind(&tool.name) != "agent.spawn"
                });
                if !ready {
                    continue;
                }
                let tool = match self.calls.get_mut(&item) {
                    Some(tool) => tool,
                    None => continue,
                };
                tool.surviving = true;
                let (agent, name) = (tool.agent.clone(), tool.name.clone());
                if let Some(set) = self.pending_by_owner.get_mut(&key) {
                    set.remove(&item);
                }
                let kind = if tool_kind(&name) == "shell" {
                    "shell"
                } else {
                    "other"
                };
                facts.push(json!({
                    "type": "background.started",
                    "agent": agent,
                    "task": format!("surviving:{item}"),
                    "kind": kind,
                    "title": format!("Unresolved SDK {name}"),
                    "item": item,
                    "stoppable": false,
                }));
                facts.push(json!({
                    "type": "background.ended",
                    "task": format!("surviving:{item}"),
                    "status": "unknown",
                    "uncertain": true,
                }));
            }
            if self
                .pending_by_owner
                .get(&key)
                .is_some_and(HashSet::is_empty)
            {
                self.pending_by_owner.remove(&key);
            }
        }
        facts
    }
}

/// Slice text to whole characters within so many UTF-16 code units.
pub(crate) fn utf16_slice(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    String::from_utf16_lossy(&units[..max])
}
