// SPDX-License-Identifier: Apache-2.0
//! The index sections and the records they name (`snapshot/mod.rs`, `load_indexes`).

use super::Snapshot;
use super::sections::load_all;
use crate::EngineError;

impl Snapshot {
    pub(super) fn load_indexes(&mut self) -> Result<(), EngineError> {
        let live_tools = load_all(&mut self.live_tools)?;
        self.load_items(&live_tools)?;
        self.state.indexes.live_tools = live_tools.into_iter().collect();
        let open_text = load_all(&mut self.open_text)?;
        self.load_items(&open_text)?;
        self.state.indexes.open_text = open_text.into_iter().collect();
        let pending = load_all(&mut self.pending_interactions)?;
        for (key, _) in &pending {
            if !self.state.interactions.contains_key(key)
                && let Some(record) = self.interactions.read(key)?
            {
                self.state.interactions.insert(key.clone(), record);
            }
        }
        self.state.indexes.pending_interactions = pending.into_iter().collect();
        let running = load_all(&mut self.running_tasks)?;
        for (key, _) in &running {
            if !self.state.tasks.contains_key(key)
                && let Some(record) = self.tasks.read(key)?
            {
                self.state.tasks.insert(key.clone(), record);
            }
        }
        self.state.indexes.running_tasks = running.into_iter().collect();
        let keys = load_all(&mut self.agent_keys_by_id)?;
        self.state.indexes.agent_keys_by_id = keys.into_iter().collect();
        let children = load_all(&mut self.children_by_parent)?;
        self.state.indexes.children_by_parent = children.into_iter().collect();
        let spawn = load_all(&mut self.pending_spawn_links)?;
        self.state.indexes.pending_spawn_links = spawn.into_iter().collect();
        let links = load_all(&mut self.pending_item_links)?;
        self.state.indexes.pending_item_links = links.into_iter().collect();
        Ok(())
    }

    /// The items an index names, loaded into the state before core reads them by that key.
    fn load_items(&mut self, keys: &[(String, bool)]) -> Result<(), EngineError> {
        for (key, _) in keys {
            if !self.state.items.contains_key(key)
                && let Some(item) = self.items.read(key)?
            {
                self.state.items.insert(key.clone(), item);
            }
        }
        Ok(())
    }
}
