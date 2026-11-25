// SPDX-License-Identifier: Apache-2.0
//! The snapshot (E5.3 step 5, `persistence.ts:19`-`:296`): a decoded thread state whose record
//! sections are [`Records`] over the repository's shared budget, plus the `itemMetadata`
//! section, which starts empty (`:93`-`:104`).

pub mod appends;
pub mod deadlines;
pub mod decode;
pub mod header;
pub mod metadata;
pub mod sections;
pub mod touched;
pub mod version;

use ace_core::state::{AgentRecord, ItemLink, ThreadState};
use ace_core::{
    entity_model::{BackgroundTask, Interaction},
    items::Item,
    runs::Run,
};
use ace_json::Value;
use indexmap::IndexMap;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use crate::EngineError;
use crate::records::{self, RecordBudget, Records, SectionSpec};
use crate::snapshot::header::header_json;

/// One resident snapshot: the state plus one dictionary per record section.
pub struct Snapshot {
    pub state: ThreadState,
    /// The header the state was decoded from, whose key order and unknown fields the next
    /// header keeps.
    original: Option<Value>,
    pub(crate) agents: Records<AgentRecord>,
    pub(crate) items: Records<Item>,
    pub(crate) metadata: Records<Item>,
    pub(crate) runs: Records<Run>,
    pub(crate) interactions: Records<Interaction>,
    pub(crate) tasks: Records<BackgroundTask>,
    pub(crate) interaction_history: Records<Interaction>,
    pub(crate) task_history: Records<BackgroundTask>,
    pub(crate) item_links: Records<ItemLink>,
    pub(crate) live_tools: Records<bool>,
    pub(crate) open_text: Records<bool>,
    pub(crate) pending_interactions: Records<bool>,
    pub(crate) running_tasks: Records<bool>,
    pub(crate) agent_keys_by_id: Records<String>,
    pub(crate) children_by_parent: Records<IndexMap<String, bool>>,
    pub(crate) pending_spawn_links: Records<IndexMap<String, bool>>,
    pub(crate) pending_item_links: Records<bool>,
    /// `nativeRuns:<agentKey>` sections an agent's serialization registers (`:58`).
    pub(crate) native_runs: HashMap<String, Records<String>>,
    pub(crate) budget: Rc<RefCell<RecordBudget>>,
    pub(crate) conn: Arc<ace_store::Connection>,
    pub(crate) deadlines: Option<ace_core::deadlines::DeadlineIndex>,
    deadline_observed_at: Option<i64>,
    released: bool,
}

fn spec<T>(
    name: impl Into<String>,
    decode: fn(&Value) -> Result<T, EngineError>,
    cache: records::BudgetSection,
) -> SectionSpec<T> {
    SectionSpec {
        name: name.into(),
        decode,
        cache,
    }
}

impl Snapshot {
    /// Wrap every section of a decoded state in a dictionary over the shared budget.
    pub fn new(
        conn: Arc<ace_store::Connection>,
        budget: &Rc<RefCell<RecordBudget>>,
        state: ThreadState,
        original: Option<Value>,
    ) -> Result<Snapshot, EngineError> {
        let thread = state.thread_id.clone();
        let mk = |_name: &'static str, budget: &Rc<RefCell<RecordBudget>>| records::section(budget);
        let agents_cache = mk(sections::SECTIONS[0], budget);
        let items_cache = mk(sections::SECTIONS[1], budget);
        let metadata_cache = mk(sections::SECTIONS[2], budget);
        let runs_cache = mk(sections::SECTIONS[3], budget);
        let interactions_cache = mk(sections::SECTIONS[4], budget);
        let tasks_cache = mk(sections::SECTIONS[5], budget);
        let interaction_history_cache = mk(sections::SECTIONS[6], budget);
        let task_history_cache = mk(sections::SECTIONS[7], budget);
        let item_links_cache = mk(sections::SECTIONS[8], budget);
        let live_tools_cache = mk(sections::SECTIONS[9], budget);
        let open_text_cache = mk(sections::SECTIONS[10], budget);
        let pending_interactions_cache = mk(sections::SECTIONS[11], budget);
        let running_tasks_cache = mk(sections::SECTIONS[12], budget);
        let agent_keys_cache = mk(sections::SECTIONS[13], budget);
        let children_cache = mk(sections::SECTIONS[14], budget);
        let spawn_links_cache = mk(sections::SECTIONS[15], budget);
        let item_links_pending_cache = mk(sections::SECTIONS[16], budget);

        let agents = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[0],
                decode::decode_record::<AgentRecord>,
                agents_cache,
            ),
            state.agents.clone(),
            None,
            Some(Box::new(|_key: &str, record: &AgentRecord| {
                let mut copy = record.clone();
                if copy.native_runs.is_some() {
                    // The runs live in their own section (`persistence.ts:72`-`:76`).
                    copy.native_runs = Some(IndexMap::new());
                }
                ace_json::ser::to_string(&copy)
                    .map_err(|error| EngineError::Records(error.to_string()))
            })),
        );
        let mut items = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[1],
                decode::decode_record::<Item>,
                items_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        items.begin();
        let metadata = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[2],
                decode::decode_record::<Item>,
                metadata_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let runs = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[3],
                decode::decode_record::<Run>,
                runs_cache,
            ),
            state.runs.clone(),
            None,
            None,
        );
        let interactions = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[4],
                decode::decode_record::<Interaction>,
                interactions_cache,
            ),
            state.interactions.clone(),
            None,
            None,
        );
        let tasks = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[5],
                decode::decode_record::<BackgroundTask>,
                tasks_cache,
            ),
            state.tasks.clone(),
            None,
            None,
        );
        let interaction_history = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[6],
                decode::decode_record::<Interaction>,
                interaction_history_cache,
            ),
            state.interaction_history.clone(),
            None,
            None,
        );
        let task_history = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[7],
                decode::decode_record::<BackgroundTask>,
                task_history_cache,
            ),
            state.task_history.clone(),
            None,
            None,
        );
        let item_links = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[8],
                decode::decode_record::<ItemLink>,
                item_links_cache,
            ),
            state.item_links.clone(),
            None,
            None,
        );
        let live_tools = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[9],
                decode::decode_record::<bool>,
                live_tools_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let open_text = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[10],
                decode::decode_record::<bool>,
                open_text_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let pending_interactions = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[11],
                decode::decode_record::<bool>,
                pending_interactions_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let running_tasks = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[12],
                decode::decode_record::<bool>,
                running_tasks_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let agent_keys_by_id = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[13],
                decode::decode_record::<String>,
                agent_keys_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let children_by_parent = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[14],
                decode::decode_record::<IndexMap<String, bool>>,
                children_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let pending_spawn_links = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[15],
                decode::decode_record::<IndexMap<String, bool>>,
                spawn_links_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let pending_item_links = Records::new(
            Arc::clone(&conn),
            budget,
            thread.clone(),
            spec(
                sections::SECTIONS[16],
                decode::decode_record::<bool>,
                item_links_pending_cache,
            ),
            IndexMap::new(),
            None,
            None,
        );
        let mut snapshot = Snapshot {
            state,
            original,
            agents,
            items,
            metadata,
            runs,
            interactions,
            tasks,
            interaction_history,
            task_history,
            item_links,
            live_tools,
            open_text,
            pending_interactions,
            running_tasks,
            agent_keys_by_id,
            children_by_parent,
            pending_spawn_links,
            pending_item_links,
            native_runs: HashMap::new(),
            budget: Rc::clone(budget),
            conn,
            deadlines: None,
            deadline_observed_at: None,
            released: false,
        };
        snapshot.load_indexes()?;
        Ok(snapshot)
    }

    /// The index sections are the live set, not the transcript: every key is loaded, so core
    /// enumerates them exactly as the TypeScript proxies do.
    fn load_indexes(&mut self) -> Result<(), EngineError> {
        let live_tools = load_all(&mut self.live_tools)?;
        self.state.indexes.live_tools = live_tools.into_iter().collect();
        let open_text = load_all(&mut self.open_text)?;
        self.state.indexes.open_text = open_text.into_iter().collect();
        let pending = load_all(&mut self.pending_interactions)?;
        self.state.indexes.pending_interactions = pending.into_iter().collect();
        let running = load_all(&mut self.running_tasks)?;
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

    /// The `thread_state.state` JSON (`:240`).
    pub fn header(&self) -> Result<String, EngineError> {
        header_json(&self.state, self.original.as_ref())
    }

    /// `begin` (`:266`): tracking on.
    pub fn begin(&mut self) {
        self.items.begin();
        self.agents.begin();
    }

    /// Persist every touched section (`:285`). Agent serialization may register another section.
    pub fn persist(&mut self) -> Result<(), EngineError> {
        eprintln!(
            "PERSIST agents={} items={} runs={} metadata={}",
            self.agents.has_changes(),
            self.items.has_changes(),
            self.runs.has_changes(),
            self.metadata.has_changes()
        );
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

    /// Copy the state's current values for the keys a batch touched into their sections, which
    /// is what the TypeScript's record proxies see as the fold mutates them in place. A value
    /// fetched for writing but left unchanged writes nothing (persist compares the base JSON).
    ///
    /// The facts and events name ids (`agent.id`, `item.id`); the sections are keyed by the
    /// native key the fold chose. Each map is looked up by both, so a root agent whose id was
    /// generated still adopts under its key.
    pub fn adopt(&mut self, touched: &touched::Touched) -> Result<(), EngineError> {
        eprintln!(
            "ADOPT agents={:?} items={:?} runs={:?}",
            touched.agents, touched.items, touched.runs
        );
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
                eprintln!("ADOPT agent {agent} -> {key} present={}", value.is_some());
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
                let value = self.state.items.get(&key).cloned();
                eprintln!("ADOPT item {item} -> {key} present={}", value.is_some());
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

    /// The item the metadata section or the transcript holds (`streamItem`, `:282`).
    pub fn stream_item(&mut self, key: &str) -> Result<Option<Item>, EngineError> {
        if let Some(metadata) = self.metadata.read(key)? {
            return Ok(Some(metadata));
        }
        Ok(self.state.items.get(key).cloned())
    }

    /// Give every agent's `nativeRuns` their own section before the agents are encoded.
    fn sync_native_runs(&mut self) -> Result<(), EngineError> {
        let agents: Vec<(String, AgentRecord)> = self
            .state
            .agents
            .iter()
            .filter(|(_, record)| record.native_runs.is_some())
            .map(|(key, record)| (key.clone(), record.clone()))
            .collect();
        for (key, record) in agents {
            let Some(runs) = record.native_runs else {
                continue;
            };
            if !self.native_runs.contains_key(&key) {
                let name = sections::native_runs(&key);
                let cache = records::section(&self.budget);
                let dictionary = Records::new(
                    Arc::clone(&self.conn),
                    &self.budget,
                    self.state.thread_id.clone(),
                    spec(&name, decode::decode_record::<String>, cache),
                    IndexMap::new(),
                    None,
                    None,
                );
                if self.released {
                    let mut dictionary = dictionary;
                    dictionary.release();
                    self.native_runs.insert(key.clone(), dictionary);
                } else {
                    self.native_runs.insert(key.clone(), dictionary);
                }
            }
            if let Some(dictionary) = self.native_runs.get_mut(&key) {
                for (run_key, run_id) in runs {
                    dictionary.write(&run_key, run_id);
                }
            }
        }
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

fn load_all<T: Clone + serde::Serialize + 'static>(
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
