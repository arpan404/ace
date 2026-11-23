// SPDX-License-Identifier: Apache-2.0
//! The translator's known sessions (`native-state.ts`: agents).
//! Snapshots report sessions; ancestry claims resolve into links.

use crate::translate::data::{fields, get, n_in, s_in, truthy};
use crate::translate::state::{AgentMeta, NativeState, Out, StateError};
use crate::translate::usage::{Model, linked_model};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Serialize)]
struct AgentSeen<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<&'a str>,
    origin: &'static str,
    fidelity: &'static str,
    cwd: &'a str,
    native: NativeId<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<Model<'a>>,
}

#[derive(Serialize)]
struct NativeId<'a> {
    provider: &'static str,
    #[serde(rename = "nativeId")]
    native_id: &'a str,
}

#[derive(Serialize)]
struct AgentDisconnected<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
}

#[derive(Serialize)]
pub struct AgentLinked<'a> {
    #[serde(rename = "type")]
    pub typ: &'static str,
    pub agent: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "spawnedBy")]
    pub spawned_by: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Model<'a>>,
}

impl NativeState {
    /// Note a session the snapshots report, claiming an ancestry child.
    pub fn seen(&mut self, p: &Map<String, Value>, out: &mut Out<'_>) -> Result<(), StateError> {
        let id = if s_in(p, "id").is_empty() {
            s_in(p, "sessionID").to_owned()
        } else {
            s_in(p, "id").to_owned()
        };
        if id.is_empty() {
            return Ok(());
        }
        if self.root_native.is_empty() && truthy(get(p, "fork")) {
            return Ok(());
        }
        let parent = if id == self.root_native {
            String::new()
        } else {
            s_in(p, "parentID").to_owned()
        };
        if self.root_native.is_empty() && parent.is_empty() {
            self.root_native = id.clone();
        }
        if id != self.root_native
            && (parent.is_empty() || !self.agents.contains_key(&parent) || truthy(get(p, "fork")))
        {
            return Ok(());
        }
        if self.agents.len() >= 1024 && !self.agents.contains_key(&id) {
            return Err(StateError::Limit("agent"));
        }
        let directory = s_in(fields(get(p, "location")), "directory").to_owned();
        let claim = self.child_claims.shift_remove(&id);
        let fresh = crate::translate::usage::qualified_model(get(p, "model"));
        let kept = self.agents.get(&id).and_then(|meta| meta.model.clone());
        let model = fresh.or(kept);
        let agent = self.key(&id).to_owned();
        self.agents.insert(
            id.clone(),
            AgentMeta {
                parent: parent.clone(),
                directory: directory.clone(),
                model: model.clone(),
            },
        );
        self.idle
            .insert(id.clone(), n_in(fields(get(p, "time")), "idle"));
        let has_parent = !parent.is_empty();
        let parent_key = self.key(&parent).to_owned();
        out.fact(&AgentSeen {
            typ: "agent.seen",
            agent: &agent,
            parent: if has_parent { Some(&parent_key) } else { None },
            origin: if has_parent {
                "provider_subagent"
            } else {
                "root"
            },
            fidelity: "full",
            cwd: &directory,
            native: NativeId {
                provider: "opencode",
                native_id: &id,
            },
            name: match s_in(p, "title") {
                title if !title.is_empty() => Some(title),
                _ => None,
            },
            role: match s_in(p, "agent") {
                role if !role.is_empty() => Some(role),
                _ => None,
            },
            model: model.as_deref().map(Model::Borrowed),
        })?;
        if self.disconnected {
            out.fact(&AgentDisconnected {
                typ: "agent.disconnected",
                agent: &agent,
            })?;
        }
        if let Some(claim) = claim
            && claim.session == parent
        {
            self.finish_background(&format!("proof:{id}"), "completed", out)?;
            let linked = AgentLinked {
                typ: "agent.linked",
                agent: self.key(&id),
                parent: Some(self.key(&parent)),
                spawned_by: Some(claim.item.as_str()),
                background: Some(claim.background),
                model: None,
            };
            out.fact(&linked)?;
            if claim.background {
                self.child_dispatch(&id, &parent, &claim.item, claim.created, out)?;
            }
        }
        Ok(())
    }

    /// Select a session's model, linking its agent to it.
    pub fn select_model(
        &mut self,
        session: &str,
        value: &Value,
        out: &mut Out<'_>,
    ) -> Result<(), StateError> {
        let model = match crate::translate::usage::qualified_model(value) {
            Some(model) => model,
            None => return Ok(()),
        };
        let agent = self.key(session).to_owned();
        let known = match self.agents.get_mut(session) {
            Some(meta) => meta,
            None => return Ok(()),
        };
        known.model = Some(model);
        let model = match self
            .agents
            .get(session)
            .and_then(|meta| meta.model.as_deref())
        {
            Some(model) => model,
            None => return Ok(()),
        };
        out.fact(&linked_model(&agent, Model::Borrowed(model)))?;
        Ok(())
    }
}
