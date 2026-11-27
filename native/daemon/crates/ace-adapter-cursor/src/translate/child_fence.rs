// SPDX-License-Identifier: Apache-2.0
//! Child settlement, observation and surviving-child fences (`children.ts`,
//! second half).

use std::collections::BTreeSet;

use super::children::Children;
use super::envelope::{cat, is, native_identity};
use super::text::{JsString, Value};
use super::{BudgetError, BudgetResult};

impl Children {
    pub fn result(
        &mut self,
        call: &JsString,
        result: &Value,
        failed: bool,
        cwd: &JsString,
    ) -> BudgetResult<Vec<Value>> {
        if !matches!(self.calls.get(call), Some(child) if !child.settled) {
            return Ok(Vec::new());
        }
        let value = result.get("value").unwrap_or(&Value::Null);
        let native = native_identity(value.get("agentId").unwrap_or(&Value::Null))?;
        let mut facts = Vec::new();
        facts.extend(self.link(call, native, cwd)?);
        let has_steps = matches!(
            value.get("conversationSteps"),
            Some(Value::Array(steps)) if !steps.is_empty()
        );
        if has_steps {
            facts.extend(self.observe(call, cwd));
        }
        let background = matches!(value.get("isBackground"), Some(Value::Bool(true)));
        if background {
            let make_background = self.calls.get(call).is_some_and(|child| !child.background);
            if make_background {
                let child = self.calls.get_mut(call).ok_or(BudgetError::Exceeded)?;
                child.background = true;
                let parent = child.parent.clone();
                let surviving = child.surviving(&parent);
                let key = child.key.clone();
                facts.push(Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("agent.linked")),
                    ),
                    (JsString::from("agent"), Value::String(key)),
                    (JsString::from("background"), Value::Bool(true)),
                ]));
                facts.push(surviving);
            }
        } else if failed || is(result.get("status").unwrap_or(&Value::Null), "success") {
            let child = self.calls.get_mut(call).ok_or(BudgetError::Exceeded)?;
            child.settled = true;
            let (key, turn, parent, background) = (
                child.key.clone(),
                child.turn.clone(),
                child.parent.clone(),
                child.background,
            );
            if let Some(pending) = self.pending_by_parent.get_mut(&parent) {
                pending.remove(call);
                if pending.is_empty() {
                    self.pending_by_parent.remove(&parent);
                }
            }
            facts.push(Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("turn.ended")),
                ),
                (JsString::from("agent"), Value::String(key)),
                (JsString::from("nativeTurnId"), Value::String(turn)),
                (
                    JsString::from("outcome"),
                    Value::String(JsString::from(if failed { "failed" } else { "completed" })),
                ),
            ]));
            if background {
                let mut status = JsString::from("completed");
                if failed {
                    status = JsString::from("failed");
                }
                facts.push(Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("background.ended")),
                    ),
                    (
                        JsString::from("task"),
                        Value::String(cat(&[&JsString::from("background:"), call])),
                    ),
                    (JsString::from("status"), Value::String(status)),
                ]));
            }
        }
        Ok(facts)
    }

    /// One-level live or returned task content establishes summary fidelity.
    pub fn observe(&mut self, call: &JsString, cwd: &JsString) -> Vec<Value> {
        let Some(child) = self.calls.get_mut(call) else {
            return Vec::new();
        };
        if child.summary {
            return Vec::new();
        }
        child.summary = true;
        let mut native_ref = vec![(
            JsString::from("provider"),
            Value::String(JsString::from("cursor")),
        )];
        if let Some(native) = child.native.clone() {
            native_ref.push((JsString::from("nativeId"), Value::String(native)));
        }
        let (key, parent, spawned, cwd_units) = (
            child.key.clone(),
            child.parent.clone(),
            child.call.clone(),
            cwd.clone(),
        );
        vec![Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("agent.seen")),
            ),
            (JsString::from("agent"), Value::String(key)),
            (JsString::from("parent"), Value::String(parent)),
            (JsString::from("spawnedBy"), Value::String(spawned)),
            (
                JsString::from("origin"),
                Value::String(JsString::from("provider_subagent")),
            ),
            (
                JsString::from("fidelity"),
                Value::String(JsString::from("summary")),
            ),
            (JsString::from("cwd"), Value::String(cwd_units)),
            (JsString::from("native"), Value::from(native_ref)),
        ])]
    }

    pub fn preserve_owned(&mut self, parent: &JsString) -> Vec<Value> {
        self.preserve_children(Some(parent))
    }

    pub fn preserve(&mut self) -> Vec<Value> {
        self.preserve_children(None)
    }

    fn preserve_children(&mut self, parent: Option<&JsString>) -> Vec<Value> {
        let mut facts = Vec::new();
        let parents: Vec<JsString> = match parent {
            Some(parent) => vec![parent.clone()],
            None => self.pending_by_parent.keys().cloned().collect(),
        };
        for key in parents {
            let pending: Vec<JsString> = self
                .pending_by_parent
                .get(&key)
                .map(|pending| pending.iter().cloned().collect())
                .unwrap_or_default();
            for call in pending {
                let ready = self
                    .calls
                    .get(&call)
                    .is_some_and(|child| !child.settled && !child.uncertain);
                if !ready {
                    continue;
                }
                let Some(child) = self.calls.get_mut(&call) else {
                    continue;
                };
                child.uncertain = true;
                child.background = true;
                let parent = child.parent.clone();
                let surviving = child.surviving(&parent);
                facts.push(surviving);
                facts.push(Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("background.ended")),
                    ),
                    (
                        JsString::from("task"),
                        Value::String(cat(&[&JsString::from("background:"), &call])),
                    ),
                    (
                        JsString::from("status"),
                        Value::String(JsString::from("unknown")),
                    ),
                    (JsString::from("uncertain"), Value::Bool(true)),
                ]));
                if let Some(set) = self.pending_by_parent.get_mut(&key) {
                    set.remove(&call);
                }
            }
            if self
                .pending_by_parent
                .get(&key)
                .is_some_and(BTreeSet::is_empty)
            {
                self.pending_by_parent.remove(&key);
            }
        }
        facts
    }

    pub fn trim(&mut self) {
        let settled: Vec<JsString> = self
            .calls
            .iter()
            .filter(|(_, child)| child.settled)
            .map(|(call, _)| call.clone())
            .collect();
        for call in settled {
            if let Some(child) = self.calls.remove(&call)
                && let Some(native) = child.native
            {
                self.native.remove(&native);
            }
        }
    }
}
