// SPDX-License-Identifier: Apache-2.0
//! Streaming shell output and surviving-call fences (`tool-events.ts`,
//! output and preserve).

use std::collections::BTreeSet;

use super::BudgetResult;
use super::children::Children;
use super::envelope::{Envelope, cat, native_identity, string};
use super::json::{J, encode_units};
use super::tool_events::ToolEvents;
use super::tools::tool_kind;
use super::transcript::Transcript;

impl ToolEvents {
    #[allow(clippy::too_many_arguments)]
    pub fn output(
        &mut self,
        body: &J,
        agent: &[u16],
        namespace: &[u16],
        event: &Envelope,
        envelope: &J,
        transcript: &mut Transcript,
        children: &mut Children,
        operation: Option<&[u16]>,
        segment: i64,
        cwd: &[u16],
        notice: &mut dyn FnMut(&[u16], &J, &str) -> J,
    ) -> BudgetResult<Vec<J>> {
        let id = native_identity(body.get("callId").unwrap_or(&J::Null))?;
        let text = string(body.get("text").unwrap_or(&J::Null)).unwrap_or(&[]);
        let Some(id) = id else { return Ok(Vec::new()) };
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let key = cat(&[namespace, &encode_units(":call:"), &id]);
        let mut facts = Vec::new();
        if !self.calls.contains_key(&key) {
            let mut started = vec![
                (
                    encode_units("type"),
                    J::Str(encode_units("tool-call-started")),
                ),
                (encode_units("callId"), J::Str(id.clone())),
            ];
            if let Some(tool_call) = body.get("toolCall") {
                started.push((encode_units("toolCall"), tool_call.clone()));
            }
            facts.extend(self.translate(
                &J::Obj(started),
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
        facts.push(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("item.delta"))),
            (encode_units("agent"), J::Str(owner)),
            (encode_units("item"), J::Str(key)),
            (encode_units("field"), J::Str(encode_units("output"))),
            (encode_units("append"), J::Str(text.to_vec())),
        ]));
        Ok(facts)
    }

    pub fn preserve(&mut self, owner: Option<&[u16]>) -> Vec<J> {
        let mut facts = Vec::new();
        let owners: Vec<Vec<u16>> = match owner {
            Some(owner) => vec![owner.to_vec()],
            None => self.pending_by_owner.keys().cloned().collect(),
        };
        for key in owners {
            let pending: Vec<Vec<u16>> = self
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
                facts.push(J::Obj(vec![
                    (
                        encode_units("type"),
                        J::Str(encode_units("background.started")),
                    ),
                    (encode_units("agent"), J::Str(agent)),
                    (
                        encode_units("task"),
                        J::Str(cat(&[&encode_units("surviving:"), &item])),
                    ),
                    (encode_units("kind"), J::Str(encode_units(kind))),
                    (
                        encode_units("title"),
                        J::Str(cat(&[&encode_units("Unresolved SDK "), &name])),
                    ),
                    (encode_units("item"), J::Str(item.clone())),
                    (encode_units("stoppable"), J::Bool(false)),
                ]));
                facts.push(J::Obj(vec![
                    (
                        encode_units("type"),
                        J::Str(encode_units("background.ended")),
                    ),
                    (
                        encode_units("task"),
                        J::Str(cat(&[&encode_units("surviving:"), &item])),
                    ),
                    (encode_units("status"), J::Str(encode_units("unknown"))),
                    (encode_units("uncertain"), J::Bool(true)),
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
