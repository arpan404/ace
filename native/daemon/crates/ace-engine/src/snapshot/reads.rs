// SPDX-License-Identifier: Apache-2.0
//! The snapshot's point reads (E5.3 step 6): the values the actor's synchronous questions read,
//! loaded through the lazy sections so a read costs the change, never the transcript.
//!
//! These are the Rust shapes of the TypeScript's proxy reads: `state.items[key]` loads the item
//! from its section on first touch, and every later read of the same key is the loaded value.

use std::collections::HashSet;

use ace_core::entity_model::BackgroundTask;
use ace_core::item_model::ToolDetail;
use ace_core::items::Item;
use ace_core::status::ThreadStatus;

use super::Snapshot;
use crate::EngineError;
use crate::repository::collaborators::QuiescenceView;

impl Snapshot {
    /// One task, loaded from its section when the state does not hold it yet.
    pub fn task(&mut self, key: &str) -> Result<Option<BackgroundTask>, EngineError> {
        if let Some(task) = self.state.tasks.get(key) {
            return Ok(Some(task.clone()));
        }
        let Some(task) = self.tasks.read(key)? else {
            return Ok(None);
        };
        self.state.tasks.insert(key.to_owned(), task.clone());
        Ok(Some(task))
    }

    /// The thread's root agent id: `state.agents[state.rootKey]?.agent.id` (`index.ts:857`).
    pub fn root_agent_id(&self) -> Option<String> {
        self.state
            .root_key
            .as_ref()
            .and_then(|key| self.state.agents.get(key))
            .map(|record| record.agent.id.clone())
    }

    /// Whether the thread's status is `done` (`actor.ts:541`).
    pub fn is_done(&self) -> bool {
        matches!(self.state.status, ThreadStatus::Done)
    }

    /// Work left running after a done turn (a dev server, ADR 0109): `indexes.runningTasks`
    /// with a task whose `ambient` is `false` (`actor.ts:538`-`:541`).
    pub fn left_running(&mut self) -> Result<bool, EngineError> {
        let keys: Vec<String> = self.state.indexes.running_tasks.keys().cloned().collect();
        for key in keys {
            if let Some(task) = self.task(&key)?
                && task.ambient == serde_json::Value::Bool(false)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `hasRunningForegroundCommand` (`core/src/steering.ts:26`): the root agent's live shell
    /// call that no background task holds.
    pub fn running_foreground_command(&mut self) -> Result<bool, EngineError> {
        let Some(root) = self.root_agent_id() else {
            return Ok(false);
        };
        let live: Vec<String> = self.state.indexes.live_tools.keys().cloned().collect();
        if live.is_empty() {
            return Ok(false);
        }
        let mut background: HashSet<String> = HashSet::new();
        let running: Vec<String> = self.state.indexes.running_tasks.keys().cloned().collect();
        for key in running {
            if let Some(call) = self.task(&key)?.and_then(|task| task.tool_call_id) {
                background.insert(call);
            }
        }
        for key in live {
            let item = match self.state.items.get(&key) {
                Some(item) => Some(item.clone()),
                None => self.items.read(&key)?,
            };
            let Some(Item::ToolCall { call, .. }) = item else {
                continue;
            };
            let shell = matches!(call.detail, ToolDetail::Shell { .. });
            if call.agent_id == root
                && call.status == "running"
                && shell
                && !background.contains(&call.id)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// What `quiescent` reads (`transition-history.ts:8`), copied out so no snapshot borrow is
    /// held across the collaborator call.
    pub fn quiescence_view(&mut self) -> Result<QuiescenceView, EngineError> {
        let mut provider_work = !self.state.uncertain_tasks.is_empty();
        if !provider_work {
            let keys: Vec<String> = self.state.indexes.running_tasks.keys().cloned().collect();
            for key in keys {
                let task = self.task(&key)?;
                // A missing record reads as provider work: `undefined !== "ace"`.
                if task.as_ref().and_then(|task| task.owner.as_deref()) != Some("ace") {
                    provider_work = true;
                    break;
                }
            }
        }
        Ok(QuiescenceView {
            provider_queue: self.state.queue_sources.provider > 0,
            live_tools: self.state.indexes.live_tools.len(),
            pending_interactions: self.state.indexes.pending_interactions.len(),
            provider_work,
        })
    }
}
