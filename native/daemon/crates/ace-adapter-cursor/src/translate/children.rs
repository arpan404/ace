// SPDX-License-Identifier: Apache-2.0
//! Child identities belong to task calls until native IDs arrive
//! (`children.ts`). No native resume is implied.

use std::collections::{BTreeMap, BTreeSet};

use super::envelope::{cat, native_identity, string, trim_text};
use super::text::{JsString, Value};
use super::{BudgetError, BudgetResult};

/// A live provider subagent routed by its spawning task call.
pub struct Child {
    pub key: JsString,
    pub parent: JsString,
    pub call: JsString,
    pub turn: JsString,
    pub native: Option<JsString>,
    pub background: bool,
    pub settled: bool,
    pub uncertain: bool,
    pub summary: bool,
    pub description: Option<JsString>,
}

impl Child {
    pub(crate) fn surviving(&self, agent: &JsString) -> Value {
        let title = match &self.description {
            Some(description) => description.clone(),
            None => JsString::from("Subagent"),
        };
        Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("background.started")),
            ),
            (JsString::from("agent"), Value::String(agent.clone())),
            (
                JsString::from("task"),
                Value::String(cat(&[&JsString::from("background:"), &self.call])),
            ),
            (JsString::from("kind"), Value::String(JsString::from("subagent"))),
            (JsString::from("title"), Value::String(title)),
            (JsString::from("childAgent"), Value::String(self.key.clone())),
            (JsString::from("item"), Value::String(self.call.clone())),
            (JsString::from("stoppable"), Value::Bool(false)),
        ])
    }
}

/// Task-call-owned children with native-id linking and pending tracking.
pub struct Children {
    pub calls: BTreeMap<JsString, Child>,
    pub(crate) native: BTreeMap<JsString, JsString>,
    pub(crate) pending_by_parent: BTreeMap<JsString, BTreeSet<JsString>>,
    limit: usize,
}

impl Children {
    pub fn new(limit: usize) -> Self {
        Children {
            calls: BTreeMap::new(),
            native: BTreeMap::new(),
            pending_by_parent: BTreeMap::new(),
            limit,
        }
    }

    pub fn ensure(
        &mut self,
        call: &JsString,
        parent: &JsString,
        args: &Value,
        cwd: &JsString,
    ) -> BudgetResult<Vec<Value>> {
        if self.calls.contains_key(call) {
            let input = args;
            let native = native_identity(input.get("agentId").unwrap_or(&Value::Null))?
                .or(native_identity(input.get("resume").unwrap_or(&Value::Null))?);
            let existing = self.calls.get(call).ok_or(BudgetError::Exceeded)?;
            let (key, parent) = (existing.key.clone(), existing.parent.clone());
            return self.link_by_key(call, native.as_ref(), cwd, &key, &parent);
        }
        if self.calls.len() >= self.limit {
            return Err(BudgetError::Exceeded);
        }
        let input = args;
        let key = cat(&[&JsString::from("child:"), call]);
        let native = native_identity(input.get("agentId").unwrap_or(&Value::Null))?
            .or(native_identity(input.get("resume").unwrap_or(&Value::Null))?);
        let description = string(input.get("description").unwrap_or(&Value::Null))
            .map(trim_text)
            .filter(|text| !text.is_empty());
        let child = Child {
            key: key.clone(),
            parent: parent.clone(),
            call: call.clone(),
            turn: cat(&[&JsString::from("task:"), call]),
            native: native.clone(),
            background: false,
            settled: false,
            uncertain: false,
            summary: false,
            description,
        };
        self.calls.insert(call.clone(), child);
        self.pending_by_parent
            .entry(parent.clone())
            .or_default()
            .insert(call.clone());
        if let Some(native) = &native {
            self.native.insert(native.clone(), key.clone());
        }
        let name =
            string(input.get("description").unwrap_or(&Value::Null)).filter(|name| !name.is_empty());
        let model =
            string(input.get("model").unwrap_or(&Value::Null)).filter(|model| !model.is_empty());
        let role = string(
            input
                .get("subagentType")
                .unwrap_or(&Value::Null)
                .get("kind")
                .unwrap_or(&Value::Null),
        )
        .filter(|role| !role.is_empty());
        let mut native_ref = vec![(JsString::from("provider"), Value::String(JsString::from("cursor")))];
        if let Some(native) = &native {
            native_ref.push((JsString::from("nativeId"), Value::String(native.clone())));
        }
        let mut seen = vec![
            (JsString::from("type"), Value::String(JsString::from("agent.seen"))),
            (JsString::from("agent"), Value::String(key.clone())),
            (JsString::from("parent"), Value::String(parent.clone())),
            (JsString::from("spawnedBy"), Value::String(call.clone())),
            (
                JsString::from("origin"),
                Value::String(JsString::from("provider_subagent")),
            ),
            (
                JsString::from("fidelity"),
                Value::String(JsString::from("placeholder")),
            ),
            (JsString::from("cwd"), Value::String(cwd.clone())),
            (JsString::from("native"), Value::from(native_ref)),
        ];
        if let Some(name) = name {
            seen.push((JsString::from("name"), Value::String(name.clone())));
        }
        if let Some(model) = model {
            seen.push((JsString::from("model"), Value::String(model.clone())));
        }
        if let Some(role) = role {
            seen.push((JsString::from("role"), Value::String(role.clone())));
        }
        Ok(vec![
            Value::from(seen),
            Value::from(vec![
                (JsString::from("type"), Value::String(JsString::from("turn.started"))),
                (JsString::from("agent"), Value::String(key)),
                (
                    JsString::from("nativeTurnId"),
                    Value::String(cat(&[&JsString::from("task:"), call])),
                ),
                (JsString::from("trigger"), Value::String(JsString::from("spawn"))),
            ]),
        ])
    }

    fn link_by_key(
        &mut self,
        call: &JsString,
        native: Option<&JsString>,
        cwd: &JsString,
        child_key: &JsString,
        parent: &JsString,
    ) -> BudgetResult<Vec<Value>> {
        let Some(native) = native else {
            return Ok(Vec::new());
        };
        let child = self.calls.get(call).ok_or(BudgetError::Exceeded)?;
        if child.native.as_ref() == Some(native) {
            return Ok(Vec::new());
        }
        if child.native.is_some()
            || self
                .native
                .get(native)
                .is_some_and(|linked| linked != child_key)
        {
            return Err(BudgetError::Exceeded);
        }
        let child = self.calls.get_mut(call).ok_or(BudgetError::Exceeded)?;
        child.native = Some(native.clone());
        child.summary = true;
        self.native.insert(native.clone(), child_key.clone());
        Ok(vec![Value::from(vec![
            (JsString::from("type"), Value::String(JsString::from("agent.seen"))),
            (JsString::from("agent"), Value::String(child_key.clone())),
            (JsString::from("parent"), Value::String(parent.clone())),
            (JsString::from("spawnedBy"), Value::String(call.clone())),
            (
                JsString::from("origin"),
                Value::String(JsString::from("provider_subagent")),
            ),
            (JsString::from("fidelity"), Value::String(JsString::from("summary"))),
            (JsString::from("cwd"), Value::String(cwd.clone())),
            (
                JsString::from("native"),
                Value::from(vec![
                    (JsString::from("provider"), Value::String(JsString::from("cursor"))),
                    (JsString::from("nativeId"), Value::String(native.clone())),
                ]),
            ),
        ])])
    }

    pub fn link(
        &mut self,
        call: &JsString,
        native: Option<JsString>,
        cwd: &JsString,
    ) -> BudgetResult<Vec<Value>> {
        let (key, parent) = match self.calls.get(call) {
            Some(child) => (child.key.clone(), child.parent.clone()),
            None => return Ok(Vec::new()),
        };
        self.link_by_key(call, native.as_ref(), cwd, &key, &parent)
    }
}
