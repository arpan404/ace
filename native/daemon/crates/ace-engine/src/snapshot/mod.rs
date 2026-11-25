// SPDX-License-Identifier: Apache-2.0
//! The snapshot (E5.3 step 5, `persistence.ts:19`-`:296`): a decoded thread state whose record
//! sections are [`Records`] over the repository's shared budget, plus the `itemMetadata`
//! section, which starts empty (`:93`-`:104`).

pub mod appends;
pub mod deadlines;
pub mod decode;
pub mod header;
pub mod indexes;
pub mod lifecycle;
pub mod metadata;
pub mod native_runs;
pub mod own;
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
    /// The `thread_state.state` JSON (`:240`).
    pub fn header(&self) -> Result<String, EngineError> {
        header_json(&self.state, self.original.as_ref())
    }

    /// The item the metadata section or the transcript holds (`streamItem`, `:282`).
    pub fn stream_item(&mut self, key: &str) -> Result<Option<Item>, EngineError> {
        if let Some(metadata) = self.metadata.read(key)? {
            return Ok(Some(metadata));
        }
        Ok(self.state.items.get(key).cloned())
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

#[cfg(test)]
mod memory_tests {
    use crate::State;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_restarted_turn_without_a_native_id_ends_the_run_it_activated() {
        // No `nativeTurnId`: the agent's `active_run` is the only link, and hydration must load
        // it or the end leaves the stored run active.
        let conn = home("active", &header("active"));
        let store = Shell::store(&conn);
        let mut before = State::default();
        before.repo.probe_passthrough = true;
        before
            .apply(
                &store,
                "active",
                r#"[{"type":"turn.started","agent":"root","trigger":"user"}]"#,
                1.0,
                None,
            )
            .unwrap();
        drop(before);
        let mut after = State::default();
        after.repo.probe_passthrough = true;
        after
            .apply(
                &store,
                "active",
                r#"[{"type":"turn.ended","agent":"root","outcome":"interrupted"}]"#,
                2.0,
                None,
            )
            .unwrap();
        let snapshot = after.repo.require_state(&store, "active").unwrap();
        let runs: Vec<String> = snapshot
            .borrow()
            .state
            .runs
            .values()
            .map(|run| run.state.clone())
            .collect();
        assert_eq!(runs, vec!["interrupted".to_owned()]);
    }

    #[test]
    fn a_committed_batch_keeps_no_transcript_in_the_state() {
        // The transcript is the sections' and the store's after a commit; keeping it in the
        // state as well would hold a long thread's messages outside the shared 8 MiB budget.
        let conn = home("memory", &header("memory"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        for index in 0..8 {
            state
                .apply(
                    &store,
                    "memory",
                    &format!(
                        r#"[{{"type":"item.upsert","agent":"root","item":"item-{index}","draft":{{"type":"message","role":"assistant","parts":[{{"type":"text","text":"m{index}"}}],"complete":true}}}}]"#
                    ),
                    1.0 + index as f64,
                    None,
                )
                .unwrap();
            let snapshot = state.repo.require_state(&store, "memory").unwrap();
            assert!(
                snapshot.borrow().state.items.is_empty(),
                "batch {index} left a committed item in the state"
            );
            assert!(
                snapshot
                    .borrow_mut()
                    .items
                    .read(&format!("item-{index}"))
                    .unwrap()
                    .is_some(),
                "the stored item is still readable through its section"
            );
        }
    }
}
