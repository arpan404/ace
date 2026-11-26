// SPDX-License-Identifier: Apache-2.0
//! Status rules for active runs and work held open by background children.

use super::StatusResolver;
use crate::emit::get;
use crate::items::{Item, item_created_at};
use crate::state::AgentRecord;
use crate::status::AgentStatus;
use crate::status_inputs::suppresses_active_silence;

impl StatusResolver<'_> {
    pub(super) fn derive_active(
        &mut self,
        record: &AgentRecord,
        key: &str,
        depth: usize,
    ) -> AgentStatus {
        let agent_id = record.agent.id.clone();
        let live_children = self.live_children(&agent_id, depth);
        let waits: Vec<crate::status_inputs::WaitEntry> = self
            .inputs
            .waits_by_agent
            .get(&agent_id)
            .cloned()
            .unwrap_or_default();
        if !waits.is_empty() {
            let mut refs = Vec::new();
            for child in &live_children {
                let awaited = waits.iter().any(|wait| {
                    wait.targets.is_empty() || wait.targets.iter().any(|target| target == child)
                });
                if awaited && let Some(child_record) = get(&self.state.agents, child) {
                    refs.push(child_record.agent.id.clone());
                }
            }
            return AgentStatus::blocked("subagents", refs, None);
        }
        let tools: Vec<&Item> = self
            .inputs
            .tools_by_agent
            .get(&agent_id)
            .cloned()
            .unwrap_or_default();
        let mut foreground: Vec<String> = Vec::new();
        for item in tools.iter() {
            if let Item::ToolCall { call, .. } = item {
                if !matches!(
                    &call.detail,
                    crate::item_model::ToolDetail::AgentSpawn { .. }
                ) {
                    continue;
                }
                let child_id = match &call.detail {
                    crate::item_model::ToolDetail::AgentSpawn { child_agent_id, .. } => {
                        child_agent_id.clone()
                    }
                    _ => None,
                };
                let Some(child_id) = child_id else {
                    continue;
                };
                let child_key = match get(self.inputs.by_id, &child_id) {
                    Some(key) => key.clone(),
                    None => continue,
                };
                let child_record = match get(&self.state.agents, &child_key) {
                    Some(record) => record,
                    None => continue,
                };
                if child_record.agent.background || !self.holds_completion(&child_key, depth) {
                    continue;
                }
                foreground.push(child_record.agent.id.clone());
            }
        }
        let mut newest: Option<&Item> = None;
        let mut newest_key: (i64, i64) = (i64::MIN, i64::MIN);
        for item in tools.iter() {
            let Item::ToolCall { call, .. } = item else {
                continue;
            };
            let is_foreground = match &call.detail {
                crate::item_model::ToolDetail::AgentSpawn { child_agent_id, .. } => child_agent_id
                    .as_ref()
                    .is_some_and(|id| foreground.iter().any(|known| known == id)),
                _ => false,
            };
            if is_foreground {
                continue;
            }
            let item_key = (call.started_at, item_created_at(item));
            if newest.is_none() || item_key >= newest_key {
                newest = Some(*item);
                newest_key = item_key;
            }
        }
        if let Some(Item::ToolCall { call, .. }) = newest {
            return AgentStatus::working("tool", Some(call.id.clone()), None);
        }
        if !foreground.is_empty() {
            let mut refs = foreground;
            refs.sort();
            refs.dedup();
            return AgentStatus::blocked("subagents", refs, None);
        }
        let signal = self.inputs.last_subtree_signal.read(key);
        if self.state.config.liveness.as_deref() != Some("transport")
            && !suppresses_active_silence(
                &self.inputs.waiting_owners,
                &agent_id,
                live_children.len(),
            )
            && (self.now - signal) as f64 > self.state.config.silence_ms
        {
            return AgentStatus::unresponsive(signal);
        }
        AgentStatus::working(&record.activity, None, record.detail.clone())
    }

    pub(super) fn background_refs(
        &mut self,
        agent: &crate::state::Agent,
        depth: usize,
    ) -> Vec<String> {
        let tasks: Vec<(String, Option<String>)> = self
            .inputs
            .tasks_by_agent
            .get(&agent.id)
            .map(|items| {
                items
                    .iter()
                    .map(|task| (task.id.clone(), task.child_agent_id.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut refs: Vec<String> = tasks.iter().map(|(id, _)| id.clone()).collect();
        let live_children = self.live_children(&agent.id, depth);
        for child in &live_children {
            let covered = tasks.iter().any(|(_, child_id)| {
                child_id.as_ref().is_some_and(|child_id| {
                    get(&self.state.agents, child)
                        .map(|record| &record.agent.id == child_id)
                        .unwrap_or(false)
                })
            });
            if !covered && let Some(record) = get(&self.state.agents, child) {
                refs.push(record.agent.id.clone());
            }
        }
        refs
    }
}
