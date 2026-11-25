// SPDX-License-Identifier: Apache-2.0
//! The snapshot's transaction lifecycle (`persistence.ts:156`-`:160`, `:263`-`:296`): begin,
//! persist, committed, flush and release.

use super::Snapshot;
use crate::EngineError;

impl Snapshot {
    pub fn begin(&mut self) {
        self.items.begin();
        self.agents.begin();
    }

    /// Persist every touched section (`:285`). Agent serialization may register another section.
    pub fn persist(&mut self) -> Result<(), EngineError> {
        self.sync_native_runs()?;
        self.agents.persist()?;
        self.items.persist()?;
        self.metadata.persist()?;
        self.runs.persist()?;
        self.interactions.persist()?;
        self.tasks.persist()?;
        self.interaction_history.persist()?;
        self.task_history.persist()?;
        self.item_links.persist()?;
        self.live_tools.persist()?;
        self.open_text.persist()?;
        self.pending_interactions.persist()?;
        self.running_tasks.persist()?;
        self.agent_keys_by_id.persist()?;
        self.children_by_parent.persist()?;
        self.pending_spawn_links.persist()?;
        self.pending_item_links.persist()?;
        let keys: Vec<String> = self.native_runs.keys().cloned().collect();
        for key in keys {
            if let Some(runs) = self.native_runs.get_mut(&key) {
                runs.persist()?;
            }
        }
        Ok(())
    }

    /// `committed` (`:289`): every section's overlay clears.
    pub fn committed(&mut self) {
        self.agents.committed();
        self.items.committed();
        self.metadata.committed();
        self.runs.committed();
        self.interactions.committed();
        self.tasks.committed();
        self.interaction_history.committed();
        self.task_history.committed();
        self.item_links.committed();
        self.live_tools.committed();
        self.open_text.committed();
        self.pending_interactions.committed();
        self.running_tasks.committed();
        self.agent_keys_by_id.committed();
        self.children_by_parent.committed();
        self.pending_spawn_links.committed();
        self.pending_item_links.committed();
        for runs in self.native_runs.values_mut() {
            runs.committed();
        }
        self.forget_transcript();
    }

    /// After a commit the transcript lives in the sections and the store, never twice: the state
    /// keeps only the live set (open text and live tools), so a long thread's items are bounded
    /// by the shared budget instead of growing with its history.
    fn forget_transcript(&mut self) {
        let keep: std::collections::HashSet<String> = self
            .state
            .indexes
            .open_text
            .keys()
            .chain(self.state.indexes.live_tools.keys())
            .cloned()
            .collect();
        self.state.items.retain(|key, _| keep.contains(key));
    }

    /// `flush` (`:294`).
    pub fn flush(&mut self) -> Result<(), EngineError> {
        self.persist()?;
        self.committed();
        Ok(())
    }

    /// `release` (`:154`): permanent. A dictionary opened after this is released as it is made.
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        self.agents.release();
        self.items.release();
        self.metadata.release();
        self.runs.release();
        self.interactions.release();
        self.tasks.release();
        self.interaction_history.release();
        self.task_history.release();
        self.item_links.release();
        self.live_tools.release();
        self.open_text.release();
        self.pending_interactions.release();
        self.running_tasks.release();
        self.agent_keys_by_id.release();
        self.children_by_parent.release();
        self.pending_spawn_links.release();
        self.pending_item_links.release();
        for runs in self.native_runs.values_mut() {
            runs.release();
        }
    }

    /// Whether this snapshot was released.
    pub fn is_released(&self) -> bool {
        self.released
    }
}
