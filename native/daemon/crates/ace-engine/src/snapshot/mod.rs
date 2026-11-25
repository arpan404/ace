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
        // Historical runs stay in their section too: only what an agent points at is resident.
        for turn in 0..5 {
            state
                .apply(
                    &store,
                    "memory",
                    &format!(
                        r#"[{{"type":"turn.started","agent":"root","trigger":"user","nativeTurnId":"turn-{turn}"}}]"#
                    ),
                    20.0 + turn as f64,
                    None,
                )
                .unwrap();
        }
        let snapshot = state.repo.require_state(&store, "memory").unwrap();
        assert!(
            snapshot.borrow().state.runs.len() <= 2,
            "runs are bounded by what the agents point at"
        );
    }
}

#[cfg(test)]
mod reload_fix_tests {
    use crate::State;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_turn_started_in_one_fold_and_ended_in_the_next_does_not_stay_active() {
        // The agent encoder omits `activeRun` when it is None; the stored row must not get the
        // old value back from the base JSON, or a reloaded thread shows as working.
        let conn = home("toggle", &header("toggle"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        state
            .apply(
                &store,
                "toggle",
                r#"[{"type":"turn.started","agent":"root","trigger":"user","nativeTurnId":"turn-1"}]"#,
                1.0,
                None,
            )
            .unwrap();
        state
            .apply(
                &store,
                "toggle",
                r#"[{"type":"turn.ended","agent":"root","nativeTurnId":"turn-1","outcome":"interrupted"}]"#,
                2.0,
                None,
            )
            .unwrap();
        drop(state);
        let mut after = State::default();
        after.repo.probe_passthrough = true;
        let snapshot = after.repo.require_state(&store, "toggle").unwrap();
        let record = snapshot
            .borrow_mut()
            .agents
            .read("root")
            .unwrap()
            .expect("the root agent");
        assert!(
            record.active_run.is_none(),
            "the ended turn left no active run"
        );
        let borrowed = snapshot.borrow();
        assert!(
            !matches!(
                borrowed.state.status,
                ace_core::status::ThreadStatus::Working { .. }
            ),
            "the reloaded thread is not working"
        );
    }

    #[test]
    fn a_thought_streaming_when_its_batch_commits_closes_on_the_next_turn_end() {
        // Same snapshot, no restart: the committed batch leaves the thought in its section, and
        // the end names no item, so the fold must load what the live index names itself.
        let conn = home("opennext", &header("opennext"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        state
            .apply(
                &store,
                "opennext",
                r#"[{"type":"turn.started","agent":"root","nativeTurnId":"t1","trigger":"user"},{"type":"item.delta","agent":"root","item":"thought","field":"reasoning","append":"Re"}]"#,
                2.0,
                None,
            )
            .unwrap();
        state
            .apply(
                &store,
                "opennext",
                r#"[{"type":"turn.ended","agent":"root","nativeTurnId":"t1","outcome":"interrupted"}]"#,
                3.0,
                None,
            )
            .unwrap();
        let snapshot = state.repo.require_state(&store, "opennext").unwrap();
        let item = snapshot
            .borrow_mut()
            .items
            .read("thought")
            .unwrap()
            .expect("the thought");
        assert!(item.complete(), "the ended turn closed the thought");
        assert!(snapshot.borrow().state.indexes.open_text.is_empty());
    }

    #[test]
    fn a_replayed_native_turn_does_not_open_a_second_run() {
        // The run a native turn id names loads on demand, so a replay is recognised as known.
        let conn = home("replay", &header("replay"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let start =
            r#"[{"type":"turn.started","agent":"root","trigger":"user","nativeTurnId":"turn-1"}]"#;
        state.apply(&store, "replay", start, 1.0, None).unwrap();
        state
            .apply(
                &store,
                "replay",
                r#"[{"type":"turn.ended","agent":"root","nativeTurnId":"turn-1","outcome":"completed"}]"#,
                2.0,
                None,
            )
            .unwrap();
        // The provider replays the older turn's start after it ended.
        state.apply(&store, "replay", start, 3.0, None).unwrap();
        let snapshot = state.repo.require_state(&store, "replay").unwrap();
        let borrowed = snapshot.borrow();
        assert_eq!(borrowed.state.runs.len(), 1, "the replayed turn is known");
        assert!(
            !matches!(
                borrowed.state.status,
                ace_core::status::ThreadStatus::Working { .. }
            ),
            "a replay does not leave a duplicate active run"
        );
    }
}

#[cfg(test)]
mod cleared_nested_tests {
    use crate::State;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_fresh_retry_does_not_keep_the_previous_until_or_message() {
        // A retry replaces the record; the encoder omits `until`/`message` when they are None,
        // and the stored base must not bring them back, or a reload shows a stale retry.
        let conn = home("retry", &header("retry"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        state
            .apply(
                &store,
                "retry",
                r#"[{"type":"retry","agent":"root","on":"network","attempt":1,"until":5000,"message":"overloaded"}]"#,
                1.0,
                None,
            )
            .unwrap();
        state
            .apply(
                &store,
                "retry",
                r#"[{"type":"retry","agent":"root","on":"network","attempt":2}]"#,
                2.0,
                None,
            )
            .unwrap();
        drop(state);
        let mut after = State::default();
        after.repo.probe_passthrough = true;
        let snapshot = after.repo.require_state(&store, "retry").unwrap();
        let record = snapshot
            .borrow_mut()
            .agents
            .read("root")
            .unwrap()
            .expect("the root agent");
        let retry = record.retry.expect("the retry");
        assert_eq!(retry.attempt, Some(2));
        assert!(retry.until.is_none(), "the old until is gone");
        assert!(retry.message.is_none(), "the old message is gone");
    }

    #[test]
    fn a_second_rate_limit_does_not_keep_the_first_until() {
        let conn = home("limit", &header("limit"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        state
            .apply(
                &store,
                "limit",
                r#"[{"type":"retry","agent":"root","on":"rate_limit","until":9000,"message":"slow down"}]"#,
                1.0,
                None,
            )
            .unwrap();
        state
            .apply(
                &store,
                "limit",
                r#"[{"type":"retry","agent":"root","on":"rate_limit"}]"#,
                2.0,
                None,
            )
            .unwrap();
        drop(state);
        let mut after = State::default();
        after.repo.probe_passthrough = true;
        let snapshot = after.repo.require_state(&store, "limit").unwrap();
        let record = snapshot
            .borrow_mut()
            .agents
            .read("root")
            .unwrap()
            .expect("the root agent");
        let limited = record.limited.expect("the limit");
        assert!(limited.until.is_none(), "the first limit's until is gone");
        assert!(limited.message.is_none());
    }

    #[test]
    fn a_corrupt_open_item_fails_the_fold_instead_of_dropping_its_key() {
        // A record that fails to decode must surface, never silently lose its open-text key: the
        // item would stream forever with no error.
        let conn = home("corrupt", &header("corrupt"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        state
            .apply(
                &store,
                "corrupt",
                r#"[{"type":"turn.started","agent":"root","trigger":"user"}]"#,
                1.0,
                None,
            )
            .unwrap();
        // The index names an item whose stored value cannot be decoded.
        ace_store::stmt_cache::run(
            &conn,
            "INSERT INTO engine_state_records VALUES (?,?,?,?)",
            vec![
                ace_store::Value::Text("corrupt".to_owned()),
                ace_store::Value::Text("items".to_owned()),
                ace_store::Value::Text("broken".to_owned()),
                ace_store::Value::Text("{not json".to_owned()),
            ],
        )
        .unwrap();
        ace_store::stmt_cache::run(
            &conn,
            "INSERT INTO engine_state_records VALUES (?,?,?,?)",
            vec![
                ace_store::Value::Text("corrupt".to_owned()),
                ace_store::Value::Text("openText".to_owned()),
                ace_store::Value::Text("broken".to_owned()),
                ace_store::Value::Text("true".to_owned()),
            ],
        )
        .unwrap();
        drop(state);
        let mut after = State::default();
        after.repo.probe_passthrough = true;
        let result = after.apply(
            &store,
            "corrupt",
            r#"[{"type":"turn.ended","agent":"root","outcome":"completed"}]"#,
            2.0,
            None,
        );
        assert!(result.is_err(), "the corrupt record surfaces");
    }
}
