// SPDX-License-Identifier: Apache-2.0
//! The snapshot's construction (`persistence.ts:19`-`:155`, `own`): a decoded thread state
//! whose record sections are dictionaries over the repository's shared budget. Index sections
//! are the live set, so their keys are loaded with the records they name.

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

use super::Snapshot;
use super::decode;
use super::sections;
use super::spec;
use crate::EngineError;
use crate::records::{self, RecordBudget, Records};

impl Snapshot {
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
}
