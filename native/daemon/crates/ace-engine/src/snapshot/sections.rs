// SPDX-License-Identifier: Apache-2.0
//! The record section names (E5.3 step 4). Section names are contract: every name here is a
//! row's `section` in `engine_state_records` and `engine_state_appends`, and the TypeScript
//! engine reads the same rows. `persistence.ts:107`-`:141`, `agent metadata` at `:58`.
//!
//! Also the snapshot's adopt step: copying the state's values for the keys a batch touched into
//! their sections, and reconciling the enumerated index sections with the state.

use super::Snapshot;
use crate::EngineError;
use crate::records::Records;
use indexmap::IndexMap;

/// A thread's record sections, in the TypeScript constructor's order.
pub const SECTIONS: [&str; 17] = [
    "agents",
    "items",
    "itemMetadata",
    "runs",
    "interactions",
    "tasks",
    "interactionHistory",
    "taskHistory",
    "itemLinks",
    "liveTools",
    "openText",
    "pendingInteractions",
    "runningTasks",
    "agentKeysById",
    "childrenByParent",
    "pendingSpawnLinks",
    "pendingItemLinks",
];

/// An agent's `nativeRuns` live in their own section, `nativeRuns:<agentKey>` (`:58`).
pub fn native_runs(key: &str) -> String {
    format!("nativeRuns:{key}")
}

/// The `nativeRuns:` prefix.
pub const NATIVE_RUNS_PREFIX: &str = "nativeRuns:";

impl Snapshot {
    /// Load the records a batch names into the state before the core folds it, so a reopened
    /// thread folds onto its stored agent, item, run, interaction and task rather than creating
    /// a placeholder. The lazy sections stay the one record cache: this only reads the keys the
    /// batch names, and [`Snapshot::adopt`] hands them back after the fold.
    pub fn hydrate(&mut self, touched: &super::touched::Touched) -> Result<(), EngineError> {
        for key in touched.agents.iter() {
            // A fact names the agent key; an event names its id. Either resolves to the key.
            let key = match self.state.indexes.agent_keys_by_id.get(key) {
                Some(key) => key.clone(),
                None => key.clone(),
            };
            if self.state.agents.contains_key(&key) {
                continue;
            }
            if let Some(mut record) = self.agents.read(&key)? {
                // The agent's runs live in their own section (`persistence.ts:50`-`:60`), and
                // the runs those ids name are loaded with them: a restarted turn's `turn.ended`
                // must find its run, not create a second one.
                if record.native_runs.is_some() {
                    // The run ids stay in their section (a thread's runs grow with its turn
                    // count); a fact that names one loads it (`hydrate_native_run`).
                    let runs = self.native_runs(&key)?;
                    let ids: Vec<String> = record
                        .active_run
                        .iter()
                        .chain(record.last_run.iter())
                        .cloned()
                        .collect();
                    for run_id in ids {
                        if !self.state.runs.contains_key(&run_id)
                            && let Some(run) = self.runs.read(&run_id)?
                        {
                            self.state.runs.insert(run_id, run);
                        }
                    }
                    record.native_runs = Some(runs);
                } else {
                    // A turn started without a native id leaves only `active_run`: the end must
                    // still find the stored run after a restart.
                    let ids: Vec<String> = record
                        .active_run
                        .iter()
                        .chain(record.last_run.iter())
                        .cloned()
                        .collect();
                    for run_id in ids {
                        if !self.state.runs.contains_key(&run_id)
                            && let Some(run) = self.runs.read(&run_id)?
                        {
                            self.state.runs.insert(run_id, run);
                        }
                    }
                }
                self.state.agents.insert(key, record);
            }
        }
        for key in touched.items.iter() {
            if self.state.items.contains_key(key) {
                continue;
            }
            if let Some(item) = self.items.read(key)? {
                self.state.items.insert(key.clone(), item);
            }
        }
        for key in touched.runs.iter() {
            if self.state.runs.contains_key(key) {
                continue;
            }
            if let Some(run) = self.runs.read(key)? {
                self.state.runs.insert(key.clone(), run);
            }
        }
        for key in touched.interactions.iter() {
            if self.state.interactions.contains_key(key) {
                continue;
            }
            if let Some(interaction) = self.interactions.read(key)? {
                self.state.interactions.insert(key.clone(), interaction);
            }
        }
        for key in touched.tasks.iter() {
            if self.state.tasks.contains_key(key) {
                continue;
            }
            if let Some(task) = self.tasks.read(key)? {
                self.state.tasks.insert(key.clone(), task);
            }
        }
        Ok(())
    }

    /// Load the run a fact's native turn id names, so a replayed `turn.started` finds it and does
    /// not create a duplicate active run (`runs.rs:89`).
    pub fn hydrate_native_run(&mut self, agent: &str, native_id: &str) -> Result<(), EngineError> {
        let key = match self.state.agents.get(agent) {
            Some(_) => agent.to_owned(),
            None => match self.state.indexes.agent_keys_by_id.get(agent) {
                Some(key) => key.clone(),
                None => return Ok(()),
            },
        };
        if !self.state.agents.contains_key(&key)
            && let Some(record) = self.agents.read(&key)?
        {
            self.state.agents.insert(key.clone(), record);
        }
        let run_id = self
            .state
            .agents
            .get(&key)
            .and_then(|record| record.native_runs.as_ref())
            .and_then(|runs| runs.get(native_id))
            .cloned();
        let Some(run_id) = run_id else {
            return Ok(());
        };
        if !self.state.runs.contains_key(&run_id)
            && let Some(run) = self.runs.read(&run_id)?
        {
            self.state.runs.insert(run_id, run);
        }
        Ok(())
    }

    /// Copy the state's current values for the keys a batch touched into their sections, which
    /// is what the TypeScript's record proxies see as the fold mutates them in place. A value
    /// fetched for writing but left unchanged writes nothing (persist compares the base JSON).
    ///
    /// The facts and events name ids (`agent.id`, `item.id`); the sections are keyed by the
    /// native key the fold chose. Each map is looked up by both, so a root agent whose id was
    /// generated still adopts under its key.
    pub fn adopt(&mut self, touched: &super::touched::Touched) -> Result<(), EngineError> {
        let agent_by_id: std::collections::HashMap<String, String> = self
            .state
            .agents
            .iter()
            .map(|(key, record)| (record.agent.id.clone(), key.clone()))
            .collect();
        for agent in &touched.agents {
            let key = if self.state.agents.contains_key(agent) {
                Some(agent.clone())
            } else {
                self.state
                    .indexes
                    .agent_keys_by_id
                    .get(agent)
                    .cloned()
                    .or_else(|| agent_by_id.get(agent).cloned())
            };
            if let Some(key) = key {
                let value = self.state.agents.get(&key).cloned();
                self.agents.adopt(&key, value);
            }
        }
        let item_by_id: std::collections::HashMap<String, String> = self
            .state
            .items
            .iter()
            .map(|(key, item)| (item.id().to_owned(), key.clone()))
            .collect();
        for item in &touched.items {
            let key = if self.state.items.contains_key(item) {
                Some(item.clone())
            } else {
                item_by_id.get(item).cloned()
            };
            if let Some(key) = key {
                // An appended key's full record predates the chunk: the patch carries the text,
                // and writing the item's grown value too would store it twice.
                if self.items.is_appended(&key) && !self.items.has_replacement(&key) {
                    continue;
                }
                let value = self.state.items.get(&key).cloned();
                self.items.adopt(&key, value);
            }
        }
        for run in &touched.runs {
            let value = self.state.runs.get(run).cloned();
            self.runs.adopt(run, value);
        }
        for interaction in &touched.interactions {
            let value = self.state.interactions.get(interaction).cloned();
            self.interactions.adopt(interaction, value);
        }
        for task in &touched.tasks {
            let value = self.state.tasks.get(task).cloned();
            self.tasks.adopt(task, value);
        }
        adopt_index(&mut self.live_tools, &self.state.indexes.live_tools)?;
        adopt_index(&mut self.open_text, &self.state.indexes.open_text)?;
        adopt_index(
            &mut self.pending_interactions,
            &self.state.indexes.pending_interactions,
        )?;
        adopt_index(&mut self.running_tasks, &self.state.indexes.running_tasks)?;
        adopt_index(
            &mut self.agent_keys_by_id,
            &self.state.indexes.agent_keys_by_id,
        )?;
        adopt_index(
            &mut self.children_by_parent,
            &self.state.indexes.children_by_parent,
        )?;
        adopt_index(
            &mut self.pending_spawn_links,
            &self.state.indexes.pending_spawn_links,
        )?;
        adopt_index(
            &mut self.pending_item_links,
            &self.state.indexes.pending_item_links,
        )?;
        Ok(())
    }
}

/// Reconcile one enumerated index section with the state's map: every stored key the state no
/// longer holds is deleted, and every state key is adopted.
fn adopt_index<T: Clone + PartialEq + serde::Serialize + 'static>(
    dictionary: &mut Records<T>,
    target: &IndexMap<String, T>,
) -> Result<(), EngineError> {
    let keys = dictionary.keys()?;
    for key in keys {
        if !target.contains_key(&key) {
            dictionary.delete(&key);
        }
    }
    for (key, value) in target {
        dictionary.adopt(key, Some(value.clone()));
    }
    Ok(())
}

pub(super) fn load_all<T: Clone + serde::Serialize + 'static>(
    dictionary: &mut Records<T>,
) -> Result<Vec<(String, T)>, EngineError> {
    let keys = dictionary.keys()?;
    let mut values = Vec::with_capacity(keys.len());
    for key in keys {
        if let Some(value) = dictionary.read(&key)? {
            values.push((key, value));
        }
    }
    Ok(values)
}
