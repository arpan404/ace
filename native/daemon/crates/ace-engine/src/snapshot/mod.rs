// SPDX-License-Identifier: Apache-2.0
//! The snapshot (E5.3 step 5, `persistence.ts:19`-`:296`): a decoded thread state whose record
//! sections are [`Records`] over the repository's shared budget, plus the `itemMetadata`
//! section, which starts empty (`:93`-`:104`).

pub mod appends;
pub mod deadlines;
pub mod decode;
pub mod header;
pub mod metadata;
pub mod reads;
pub mod sections;
pub mod stream;
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
use crate::snapshot::sections::load_all;

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
    /// enumerates them exactly as the TypeScript proxies do. The records those keys name are
    /// loaded with them, because core reads `items`/`interactions`/`tasks` by an index key it
    /// enumerated (a restarted thread's open thought must close when its turn ends).
    fn load_indexes(&mut self) -> Result<(), EngineError> {
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

    /// The item the metadata section or the transcript holds (`streamItem`, `:282`).
    pub fn stream_item(&mut self, key: &str) -> Result<Option<Item>, EngineError> {
        if let Some(metadata) = self.metadata.read(key)? {
            return Ok(Some(metadata));
        }
        Ok(self.state.items.get(key).cloned())
    }

    /// The `nativeRuns:<agentKey>` section's records, created on first use and released if the
    /// snapshot already is (`:54`-`:60`).
    pub(crate) fn native_runs(
        &mut self,
        key: &str,
    ) -> Result<IndexMap<String, String>, EngineError> {
        let name = sections::native_runs(key);
        if !self.native_runs.contains_key(key) {
            let cache = records::section(&self.budget);
            let mut dictionary = Records::new(
                Arc::clone(&self.conn),
                &self.budget,
                self.state.thread_id.clone(),
                spec(&name, decode::decode_record::<String>, cache),
                IndexMap::new(),
                None,
                None,
            );
            if self.released {
                dictionary.release();
            }
            self.native_runs.insert(key.to_owned(), dictionary);
        }
        let Some(dictionary) = self.native_runs.get_mut(key) else {
            return Ok(IndexMap::new());
        };
        let mut runs = IndexMap::new();
        for run_key in dictionary.keys()? {
            if let Some(run_id) = dictionary.read(&run_key)? {
                runs.insert(run_key, run_id);
            }
        }
        Ok(runs)
    }

    /// Write only the agents this batch changed: `encode` runs per touched record, as the
    /// TypeScript's does, so the section is never rewritten whole.
    fn sync_native_runs(&mut self) -> Result<(), EngineError> {
        let changed: Vec<String> = self
            .agents
            .changes()
            .into_iter()
            .filter_map(|(key, change)| {
                matches!(change, ace_core::section::Change::Written(_)).then_some(key)
            })
            .collect();
        for key in changed {
            let Some(runs) = self
                .state
                .agents
                .get(&key)
                .and_then(|record| record.native_runs.clone())
            else {
                continue;
            };
            if !self.native_runs.contains_key(&key) {
                self.native_runs(&key)?;
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

#[cfg(test)]
mod tests {
    use crate::State;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_thought_still_streaming_at_restart_closes_when_its_turn_ends() {
        // `open-text-restart.process`: a reasoning item the provider streamed before the daemon
        // restarted closes when the stored run's turn ends, and leaves the open-text index.
        let conn = home("opentext", &header("opentext"));
        let store = Shell::store(&conn);
        let mut before = State::default();
        before.repo.probe_passthrough = true;
        before
            .apply(
                &store,
                "opentext",
                r#"[{"type":"turn.started","agent":"root","nativeTurnId":"t1","trigger":"user"},{"type":"item.delta","agent":"root","item":"thought","field":"reasoning","append":"Re"}]"#,
                2.0,
                None,
            )
            .unwrap();
        drop(before);
        // A restart: a fresh engine reads the stored rows.
        let mut after = State::default();
        after.repo.probe_passthrough = true;
        after
            .apply(
                &store,
                "opentext",
                r#"[{"type":"turn.ended","agent":"root","nativeTurnId":"t1","outcome":"interrupted"}]"#,
                3.0,
                None,
            )
            .unwrap();
        let snapshot = after.repo.require_state(&store, "opentext").unwrap();
        let item = snapshot
            .borrow_mut()
            .items
            .read("thought")
            .unwrap()
            .expect("the streamed thought");
        let ace_core::items::Item::Reasoning { text, .. } = &item else {
            panic!("a reasoning item");
        };
        assert_eq!(text.as_str(), "Re");
        assert!(item.complete(), "the ended turn closed the thought");
        assert!(
            snapshot.borrow().state.indexes.open_text.is_empty(),
            "nothing is still streaming"
        );
        let runs: Vec<String> = snapshot
            .borrow()
            .state
            .runs
            .values()
            .map(|run| run.state.clone())
            .collect();
        assert_eq!(runs, vec!["interrupted".to_owned()]);
    }
}

#[cfg(test)]
mod reload_tests {
    use crate::State;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_restarted_turn_ends_the_run_it_started_rather_than_creating_a_second_one() {
        // The run ids come from the state's allocation service; the second engine must find the
        // stored run by its native turn id, or the turn ends a new one and the original stays
        // active.
        let conn = home("runs", &header("runs"));
        let store = Shell::store(&conn);
        let mut before = State::default();
        before.repo.probe_passthrough = true;
        before
            .apply(
                &store,
                "runs",
                r#"[{"type":"turn.started","agent":"root","trigger":"user","nativeTurnId":"turn-1"}]"#,
                1.0,
                None,
            )
            .unwrap();
        let started = before.repo.require_state(&store, "runs").unwrap();
        let first: Vec<String> = started.borrow().state.runs.keys().cloned().collect();
        assert_eq!(first.len(), 1, "one run for one turn");
        drop(started);
        drop(before);
        let mut after = State::default();
        after.repo.probe_passthrough = true;
        after
            .apply(
                &store,
                "runs",
                r#"[{"type":"turn.ended","agent":"root","nativeTurnId":"turn-1","outcome":"interrupted"}]"#,
                2.0,
                None,
            )
            .unwrap();
        let snapshot = after.repo.require_state(&store, "runs").unwrap();
        let runs: Vec<(String, String, Option<String>)> = snapshot
            .borrow()
            .state
            .runs
            .iter()
            .map(|(key, run)| (key.clone(), run.state.clone(), run.native_id.clone()))
            .collect();
        assert_eq!(runs.len(), 1, "the stored run is the one that ended");
        assert_eq!(runs[0].0, first[0]);
        assert_eq!(runs[0].1, "interrupted");
        assert_eq!(runs[0].2.as_deref(), Some("turn-1"));
    }
}
