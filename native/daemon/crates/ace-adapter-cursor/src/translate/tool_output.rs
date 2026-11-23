// SPDX-License-Identifier: Apache-2.0
//! Streaming shell output and surviving-call fences (`tool-events.ts`,
//! output and preserve).

use std::collections::BTreeSet;

use super::BudgetResult;
use super::children::Children;
use super::envelope::{Envelope, cat, native_identity, string};
use super::text::{JsString, Value};
use super::tool_events::ToolEvents;
use super::tools::tool_kind;
use super::transcript::Transcript;

impl ToolEvents {
    #[allow(clippy::too_many_arguments)]
    pub fn output(
        &mut self,
        body: &Value,
        agent: &JsString,
        namespace: &JsString,
        event: &Envelope,
        envelope: &Value,
        transcript: &mut Transcript,
        children: &mut Children,
        operation: Option<&JsString>,
        segment: i64,
        cwd: &JsString,
        notice: &mut dyn FnMut(&JsString, &Value, &str) -> Value,
    ) -> BudgetResult<Vec<Value>> {
        let id = native_identity(body.get("callId").unwrap_or(&Value::Null))?;
        let text = string(body.get("text").unwrap_or(&Value::Null)).unwrap_or(JsString::empty());
        let Some(id) = id else { return Ok(Vec::new()) };
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let key = cat(&[namespace, &JsString::from(":call:"), &id]);
        let mut facts = Vec::new();
        if !self.calls.contains_key(&key) {
            let mut started = vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("tool-call-started")),
                ),
                (JsString::from("callId"), Value::String(id.clone())),
            ];
            if let Some(tool_call) = body.get("toolCall") {
                started.push((JsString::from("toolCall"), tool_call.clone()));
            }
            facts.extend(self.translate(
                &Value::from(started),
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
        facts.push(Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("item.delta")),
            ),
            (JsString::from("agent"), Value::String(owner)),
            (JsString::from("item"), Value::String(key)),
            (
                JsString::from("field"),
                Value::String(JsString::from("output")),
            ),
            (JsString::from("append"), Value::String(text.clone())),
        ]));
        Ok(facts)
    }

    pub fn preserve(&mut self, owner: Option<&JsString>) -> Vec<Value> {
        let mut facts = Vec::new();
        let owners: Vec<JsString> = match owner {
            Some(owner) => vec![owner.clone()],
            None => self.pending_by_owner.keys().cloned().collect(),
        };
        for key in owners {
            let pending: Vec<JsString> = self
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
                facts.push(Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("background.started")),
                    ),
                    (JsString::from("agent"), Value::String(agent)),
                    (
                        JsString::from("task"),
                        Value::String(cat(&[&JsString::from("surviving:"), &item])),
                    ),
                    (JsString::from("kind"), Value::String(JsString::from(kind))),
                    (
                        JsString::from("title"),
                        Value::String(cat(&[&JsString::from("Unresolved SDK "), &name])),
                    ),
                    (JsString::from("item"), Value::String(item.clone())),
                    (JsString::from("stoppable"), Value::Bool(false)),
                ]));
                facts.push(Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("background.ended")),
                    ),
                    (
                        JsString::from("task"),
                        Value::String(cat(&[&JsString::from("surviving:"), &item])),
                    ),
                    (
                        JsString::from("status"),
                        Value::String(JsString::from("unknown")),
                    ),
                    (JsString::from("uncertain"), Value::Bool(true)),
                ]));
            }
            if self
                .pending_by_owner
                .get(&key)
                .is_some_and(BTreeSet::is_empty)
            {
                self.pending_by_owner.remove(&key);
            }
        }
        facts
    }
}
