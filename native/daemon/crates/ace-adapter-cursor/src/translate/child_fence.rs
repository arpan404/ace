// SPDX-License-Identifier: Apache-2.0
//! Child settlement, observation and surviving-child fences (`children.ts`,
//! second half).

use std::collections::BTreeSet;

use super::children::Children;
use super::envelope::{cat, is, native_identity};
use super::json::{J, encode_units};
use super::{BudgetError, BudgetResult};

impl Children {
    pub fn result(
        &mut self,
        call: &[u16],
        result: &J,
        failed: bool,
        cwd: &[u16],
    ) -> BudgetResult<Vec<J>> {
        if !matches!(self.calls.get(call), Some(child) if !child.settled) {
            return Ok(Vec::new());
        }
        let value = result.get("value").unwrap_or(&J::Null);
        let native = native_identity(value.get("agentId").unwrap_or(&J::Null))?;
        let mut facts = Vec::new();
        facts.extend(self.link(call, native, cwd)?);
        let has_steps = matches!(
            value.get("conversationSteps"),
            Some(J::Arr(steps)) if !steps.is_empty()
        );
        if has_steps {
            facts.extend(self.observe(call, cwd));
        }
        let background = matches!(value.get("isBackground"), Some(J::Bool(true)));
        if background {
            let make_background = self.calls.get(call).is_some_and(|child| !child.background);
            if make_background {
                let child = self.calls.get_mut(call).ok_or(BudgetError::Exceeded)?;
                child.background = true;
                let parent = child.parent.clone();
                let surviving = child.surviving(&parent);
                let key = child.key.clone();
                facts.push(J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("agent.linked"))),
                    (encode_units("agent"), J::Str(key)),
                    (encode_units("background"), J::Bool(true)),
                ]));
                facts.push(surviving);
            }
        } else if failed || is(result.get("status").unwrap_or(&J::Null), "success") {
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
            facts.push(J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("turn.ended"))),
                (encode_units("agent"), J::Str(key)),
                (encode_units("nativeTurnId"), J::Str(turn)),
                (
                    encode_units("outcome"),
                    J::Str(encode_units(if failed { "failed" } else { "completed" })),
                ),
            ]));
            if background {
                let mut status = encode_units("completed");
                if failed {
                    status = encode_units("failed");
                }
                facts.push(J::Obj(vec![
                    (
                        encode_units("type"),
                        J::Str(encode_units("background.ended")),
                    ),
                    (
                        encode_units("task"),
                        J::Str(cat(&[&encode_units("background:"), call])),
                    ),
                    (encode_units("status"), J::Str(status)),
                ]));
            }
        }
        Ok(facts)
    }

    /// One-level live or returned task content establishes summary fidelity.
    pub fn observe(&mut self, call: &[u16], cwd: &[u16]) -> Vec<J> {
        let Some(child) = self.calls.get_mut(call) else {
            return Vec::new();
        };
        if child.summary {
            return Vec::new();
        }
        child.summary = true;
        let mut native_ref = vec![(encode_units("provider"), J::Str(encode_units("cursor")))];
        if let Some(native) = child.native.clone() {
            native_ref.push((encode_units("nativeId"), J::Str(native)));
        }
        let (key, parent, spawned, cwd_units) = (
            child.key.clone(),
            child.parent.clone(),
            child.call.clone(),
            cwd.to_vec(),
        );
        vec![J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("agent.seen"))),
            (encode_units("agent"), J::Str(key)),
            (encode_units("parent"), J::Str(parent)),
            (encode_units("spawnedBy"), J::Str(spawned)),
            (
                encode_units("origin"),
                J::Str(encode_units("provider_subagent")),
            ),
            (encode_units("fidelity"), J::Str(encode_units("summary"))),
            (encode_units("cwd"), J::Str(cwd_units)),
            (encode_units("native"), J::Obj(native_ref)),
        ])]
    }

    pub fn preserve_owned(&mut self, parent: &[u16]) -> Vec<J> {
        self.preserve_children(Some(parent))
    }

    pub fn preserve(&mut self) -> Vec<J> {
        self.preserve_children(None)
    }

    fn preserve_children(&mut self, parent: Option<&[u16]>) -> Vec<J> {
        let mut facts = Vec::new();
        let parents: Vec<Vec<u16>> = match parent {
            Some(parent) => vec![parent.to_vec()],
            None => self.pending_by_parent.keys().cloned().collect(),
        };
        for key in parents {
            let pending: Vec<Vec<u16>> = self
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
                facts.push(J::Obj(vec![
                    (
                        encode_units("type"),
                        J::Str(encode_units("background.ended")),
                    ),
                    (
                        encode_units("task"),
                        J::Str(cat(&[&encode_units("background:"), &call])),
                    ),
                    (encode_units("status"), J::Str(encode_units("unknown"))),
                    (encode_units("uncertain"), J::Bool(true)),
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
        let settled: Vec<Vec<u16>> = self
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
