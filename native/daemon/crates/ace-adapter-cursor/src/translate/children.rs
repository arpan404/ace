// SPDX-License-Identifier: Apache-2.0
//! Child identities belong to task calls until native IDs arrive
//! (`children.ts`). No native resume is implied.

use std::collections::{BTreeMap, BTreeSet};

use super::envelope::{cat, native_identity, string, trim_text};
use super::json::{J, encode_units};
use super::{BudgetError, BudgetResult};

/// A live provider subagent routed by its spawning task call.
pub struct Child {
    pub key: Vec<u16>,
    pub parent: Vec<u16>,
    pub call: Vec<u16>,
    pub turn: Vec<u16>,
    pub native: Option<Vec<u16>>,
    pub background: bool,
    pub settled: bool,
    pub uncertain: bool,
    pub summary: bool,
    pub description: Option<Vec<u16>>,
}

impl Child {
    pub(crate) fn surviving(&self, agent: &[u16]) -> J {
        let title = match &self.description {
            Some(description) => description.clone(),
            None => encode_units("Subagent"),
        };
        J::Obj(vec![
            (
                encode_units("type"),
                J::Str(encode_units("background.started")),
            ),
            (encode_units("agent"), J::Str(agent.to_vec())),
            (
                encode_units("task"),
                J::Str(cat(&[&encode_units("background:"), &self.call])),
            ),
            (encode_units("kind"), J::Str(encode_units("subagent"))),
            (encode_units("title"), J::Str(title)),
            (encode_units("childAgent"), J::Str(self.key.clone())),
            (encode_units("item"), J::Str(self.call.clone())),
            (encode_units("stoppable"), J::Bool(false)),
        ])
    }
}

/// Task-call-owned children with native-id linking and pending tracking.
pub struct Children {
    pub calls: BTreeMap<Vec<u16>, Child>,
    pub(crate) native: BTreeMap<Vec<u16>, Vec<u16>>,
    pub(crate) pending_by_parent: BTreeMap<Vec<u16>, BTreeSet<Vec<u16>>>,
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
        call: &[u16],
        parent: &[u16],
        args: &J,
        cwd: &[u16],
    ) -> BudgetResult<Vec<J>> {
        if self.calls.contains_key(call) {
            let input = args;
            let native = native_identity(input.get("agentId").unwrap_or(&J::Null))?
                .or(native_identity(input.get("resume").unwrap_or(&J::Null))?);
            let existing = self.calls.get(call).ok_or(BudgetError::Exceeded)?;
            let (key, parent) = (existing.key.clone(), existing.parent.clone());
            return self.link_by_key(call, native.as_deref(), cwd, &key, &parent);
        }
        if self.calls.len() >= self.limit {
            return Err(BudgetError::Exceeded);
        }
        let input = args;
        let key = cat(&[&encode_units("child:"), call]);
        let native = native_identity(input.get("agentId").unwrap_or(&J::Null))?
            .or(native_identity(input.get("resume").unwrap_or(&J::Null))?);
        let description = string(input.get("description").unwrap_or(&J::Null))
            .map(trim_text)
            .filter(|text| !text.is_empty());
        let child = Child {
            key: key.clone(),
            parent: parent.to_vec(),
            call: call.to_vec(),
            turn: cat(&[&encode_units("task:"), call]),
            native: native.clone(),
            background: false,
            settled: false,
            uncertain: false,
            summary: false,
            description,
        };
        self.calls.insert(call.to_vec(), child);
        self.pending_by_parent
            .entry(parent.to_vec())
            .or_default()
            .insert(call.to_vec());
        if let Some(native) = &native {
            self.native.insert(native.clone(), key.clone());
        }
        let name =
            string(input.get("description").unwrap_or(&J::Null)).filter(|name| !name.is_empty());
        let model =
            string(input.get("model").unwrap_or(&J::Null)).filter(|model| !model.is_empty());
        let role = string(
            input
                .get("subagentType")
                .unwrap_or(&J::Null)
                .get("kind")
                .unwrap_or(&J::Null),
        )
        .filter(|role| !role.is_empty());
        let mut native_ref = vec![(encode_units("provider"), J::Str(encode_units("cursor")))];
        if let Some(native) = &native {
            native_ref.push((encode_units("nativeId"), J::Str(native.clone())));
        }
        let mut seen = vec![
            (encode_units("type"), J::Str(encode_units("agent.seen"))),
            (encode_units("agent"), J::Str(key.clone())),
            (encode_units("parent"), J::Str(parent.to_vec())),
            (encode_units("spawnedBy"), J::Str(call.to_vec())),
            (
                encode_units("origin"),
                J::Str(encode_units("provider_subagent")),
            ),
            (
                encode_units("fidelity"),
                J::Str(encode_units("placeholder")),
            ),
            (encode_units("cwd"), J::Str(cwd.to_vec())),
            (encode_units("native"), J::Obj(native_ref)),
        ];
        if let Some(name) = name {
            seen.push((encode_units("name"), J::Str(name.to_vec())));
        }
        if let Some(model) = model {
            seen.push((encode_units("model"), J::Str(model.to_vec())));
        }
        if let Some(role) = role {
            seen.push((encode_units("role"), J::Str(role.to_vec())));
        }
        Ok(vec![
            J::Obj(seen),
            J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("turn.started"))),
                (encode_units("agent"), J::Str(key)),
                (
                    encode_units("nativeTurnId"),
                    J::Str(cat(&[&encode_units("task:"), call])),
                ),
                (encode_units("trigger"), J::Str(encode_units("spawn"))),
            ]),
        ])
    }

    fn link_by_key(
        &mut self,
        call: &[u16],
        native: Option<&[u16]>,
        cwd: &[u16],
        child_key: &[u16],
        parent: &[u16],
    ) -> BudgetResult<Vec<J>> {
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
                .is_some_and(|linked| linked.as_slice() != child_key)
        {
            return Err(BudgetError::Exceeded);
        }
        let child = self.calls.get_mut(call).ok_or(BudgetError::Exceeded)?;
        child.native = Some(native.to_vec());
        child.summary = true;
        self.native.insert(native.to_vec(), child_key.to_vec());
        Ok(vec![J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("agent.seen"))),
            (encode_units("agent"), J::Str(child_key.to_vec())),
            (encode_units("parent"), J::Str(parent.to_vec())),
            (encode_units("spawnedBy"), J::Str(call.to_vec())),
            (
                encode_units("origin"),
                J::Str(encode_units("provider_subagent")),
            ),
            (encode_units("fidelity"), J::Str(encode_units("summary"))),
            (encode_units("cwd"), J::Str(cwd.to_vec())),
            (
                encode_units("native"),
                J::Obj(vec![
                    (encode_units("provider"), J::Str(encode_units("cursor"))),
                    (encode_units("nativeId"), J::Str(native.to_vec())),
                ]),
            ),
        ])])
    }

    pub fn link(
        &mut self,
        call: &[u16],
        native: Option<Vec<u16>>,
        cwd: &[u16],
    ) -> BudgetResult<Vec<J>> {
        let (key, parent) = match self.calls.get(call) {
            Some(child) => (child.key.clone(), child.parent.clone()),
            None => return Ok(Vec::new()),
        };
        self.link_by_key(call, native.as_deref(), cwd, &key, &parent)
    }
}
