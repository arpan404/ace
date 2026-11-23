// SPDX-License-Identifier: Apache-2.0
//! Child identities belong to task calls until native IDs arrive
//! (`children.ts`). No native resume is implied.

use std::collections::{BTreeMap, HashSet};

use serde_json::{Value, json};

use super::envelope::{native_identity, object, string};
use super::{BudgetError, BudgetResult};

/// A live provider subagent routed by its spawning task call.
pub struct Child {
    pub key: String,
    pub parent: String,
    pub call: String,
    pub turn: String,
    pub native: Option<String>,
    pub background: bool,
    pub settled: bool,
    pub uncertain: bool,
    pub summary: bool,
    pub description: Option<String>,
}

impl Child {
    fn surviving(&self, agent: &str) -> Value {
        json!({
            "type": "background.started",
            "agent": agent,
            "task": format!("background:{}", self.call),
            "kind": "subagent",
            "title": self.description.clone().unwrap_or_else(|| "Subagent".to_owned()),
            "childAgent": self.key,
            "item": self.call,
            "stoppable": false,
        })
    }
}

/// Task-call-owned children with native-id linking and pending tracking.
pub struct Children {
    pub(crate) calls: BTreeMap<String, Child>,
    native: BTreeMap<String, String>,
    pending_by_parent: BTreeMap<String, HashSet<String>>,
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
        call: &str,
        parent: &str,
        args: &Value,
        cwd: &str,
    ) -> BudgetResult<Vec<Value>> {
        if let Some(child) = self.calls.get(call) {
            let input = object(args);
            let native = native_identity(input.get("agentId").unwrap_or(&Value::Null))?.or(
                native_identity(input.get("resume").unwrap_or(&Value::Null))?,
            );
            return self.link_by_key(
                call,
                native.as_deref(),
                cwd,
                &child.key.clone(),
                &child.parent.clone(),
            );
        }
        if self.calls.len() >= self.limit {
            return Err(BudgetError::Exceeded);
        }
        let input = object(args);
        let key = format!("child:{call}");
        let native = native_identity(input.get("agentId").unwrap_or(&Value::Null))?.or(
            native_identity(input.get("resume").unwrap_or(&Value::Null))?,
        );
        let description = string(input.get("description").unwrap_or(&Value::Null))
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty());
        let child = Child {
            key: key.clone(),
            parent: parent.to_owned(),
            call: call.to_owned(),
            turn: format!("task:{call}"),
            native: native.clone(),
            background: false,
            settled: false,
            uncertain: false,
            summary: false,
            description,
        };
        self.calls.insert(call.to_owned(), child);
        self.pending_by_parent
            .entry(parent.to_owned())
            .or_default()
            .insert(call.to_owned());
        if let Some(native) = &native {
            self.native.insert(native.clone(), key.clone());
        }
        let name = string(input.get("description").unwrap_or(&Value::Null));
        let model = string(input.get("model").unwrap_or(&Value::Null));
        let role = string(
            object(input.get("subagentType").unwrap_or(&Value::Null))
                .get("kind")
                .unwrap_or(&Value::Null),
        );
        let mut seen = json!({
            "type": "agent.seen",
            "agent": key,
            "parent": parent,
            "spawnedBy": call,
            "origin": "provider_subagent",
            "fidelity": "placeholder",
            "cwd": cwd,
            "native": { "provider": "cursor" },
        });
        if let Some(native) = &native {
            seen["native"]["nativeId"] = Value::String(native.clone());
        }
        if let Some(name) = name {
            seen["name"] = Value::String(name.to_owned());
        }
        if let Some(model) = model {
            seen["model"] = Value::String(model.to_owned());
        }
        if let Some(role) = role {
            seen["role"] = Value::String(role.to_owned());
        }
        Ok(vec![
            seen,
            json!({ "type": "turn.started", "agent": key, "nativeTurnId": format!("task:{call}"), "trigger": "spawn" }),
        ])
    }

    fn link_by_key(
        &mut self,
        call: &str,
        native: Option<&str>,
        cwd: &str,
        child_key: &str,
        parent: &str,
    ) -> BudgetResult<Vec<Value>> {
        let Some(native) = native else {
            return Ok(Vec::new());
        };
        let child = self.calls.get(call).ok_or(BudgetError::Exceeded)?;
        if child.native.as_deref() == Some(native) {
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
        child.native = Some(native.to_owned());
        child.summary = true;
        self.native.insert(native.to_owned(), child_key.to_owned());
        Ok(vec![json!({
            "type": "agent.seen",
            "agent": child_key,
            "parent": parent,
            "spawnedBy": call,
            "origin": "provider_subagent",
            "fidelity": "summary",
            "cwd": cwd,
            "native": { "provider": "cursor", "nativeId": native },
        })])
    }

    pub fn link(
        &mut self,
        call: &str,
        native: Option<String>,
        cwd: &str,
    ) -> BudgetResult<Vec<Value>> {
        let (key, parent) = match self.calls.get(call) {
            Some(child) => (child.key.clone(), child.parent.clone()),
            None => return Ok(Vec::new()),
        };
        self.link_by_key(call, native.as_deref(), cwd, &key, &parent)
    }

    pub fn result(
        &mut self,
        call: &str,
        result: &Value,
        failed: bool,
        cwd: &str,
    ) -> BudgetResult<Vec<Value>> {
        if !matches!(self.calls.get(call), Some(child) if !child.settled) {
            return Ok(Vec::new());
        }
        let value = object(object(result).get("value").unwrap_or(&Value::Null));
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
        let background = value.get("isBackground") == Some(&Value::Bool(true));
        if background {
            let make_background = self.calls.get(call).is_some_and(|child| !child.background);
            if make_background {
                let child = self.calls.get_mut(call).ok_or(BudgetError::Exceeded)?;
                child.background = true;
                let seen_agent = child.parent.clone();
                let surviving = child.surviving(&seen_agent);
                facts.push(
                    json!({ "type": "agent.linked", "agent": child.key, "background": true }),
                );
                facts.push(surviving);
            }
        } else if failed
            || object(result).get("status") == Some(&Value::String("success".to_owned()))
        {
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
            facts.push(json!({
                "type": "turn.ended",
                "agent": key,
                "nativeTurnId": turn,
                "outcome": if failed { "failed" } else { "completed" },
            }));
            if background {
                facts.push(json!({
                    "type": "background.ended",
                    "task": format!("background:{call}"),
                    "status": if failed { "failed" } else { "completed" },
                }));
            }
        }
        Ok(facts)
    }

    /// One-level live or returned task content establishes summary fidelity.
    pub fn observe(&mut self, call: &str, cwd: &str) -> Vec<Value> {
        let Some(child) = self.calls.get_mut(call) else {
            return Vec::new();
        };
        if child.summary {
            return Vec::new();
        }
        child.summary = true;
        let mut seen = json!({
            "type": "agent.seen",
            "agent": child.key,
            "parent": child.parent,
            "spawnedBy": child.call,
            "origin": "provider_subagent",
            "fidelity": "summary",
            "cwd": cwd,
            "native": { "provider": "cursor" },
        });
        if let Some(native) = &child.native {
            seen["native"]["nativeId"] = Value::String(native.clone());
        }
        vec![seen]
    }

    pub fn preserve_owned(&mut self, parent: &str) -> Vec<Value> {
        self.preserve_children(Some(parent))
    }

    pub fn preserve(&mut self) -> Vec<Value> {
        self.preserve_children(None)
    }

    fn preserve_children(&mut self, parent: Option<&str>) -> Vec<Value> {
        let mut facts = Vec::new();
        let parents: Vec<String> = match parent {
            Some(parent) => vec![parent.to_owned()],
            None => self.pending_by_parent.keys().cloned().collect(),
        };
        for key in parents {
            let pending: Vec<String> = self
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
                let seen_agent = child.parent.clone();
                let surviving = child.surviving(&seen_agent);
                facts.push(surviving);
                facts.push(json!({
                    "type": "background.ended",
                    "task": format!("background:{call}"),
                    "status": "unknown",
                    "uncertain": true,
                }));
                if let Some(set) = self.pending_by_parent.get_mut(&key) {
                    set.remove(&call);
                }
            }
            if self
                .pending_by_parent
                .get(&key)
                .is_some_and(HashSet::is_empty)
            {
                self.pending_by_parent.remove(&key);
            }
        }
        facts
    }

    pub fn trim(&mut self) {
        let settled: Vec<String> = self
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
