// SPDX-License-Identifier: Apache-2.0
//! The per-pass status inputs of `status-inputs.ts`: one immutable-fact view
//! per synchronous status or deadline derivation.

use std::collections::{HashMap, HashSet};

use crate::background_hold::holds_thread;
use crate::emit::get;
use crate::entity_model::BackgroundTask;
use crate::indexes::{live_tool_keys, pending_interaction_keys, running_task_keys};
use crate::items::Item;
use crate::liveness::{SubtreeSignalReader, transport_signal_at};
use crate::state::ThreadState;

/// Whether `task`'s agent finished its last turn on its own: no turn runs,
// and the last one completed rather than being stopped or failing (ADR 0109).
pub fn owner_turn_finished(state: &ThreadState, task: &BackgroundTask) -> bool {
    agent_turn_finished(state, &task.agent_id)
}

fn agent_turn_finished(state: &ThreadState, agent_id: &str) -> bool {
    let key = match get(&state.indexes.agent_keys_by_id, agent_id) {
        Some(key) => key,
        None => return false,
    };
    let record = match get(&state.agents, key) {
        Some(record) => record,
        None => return false,
    };
    if record.active_run.is_some() || record.last_run.is_none() {
        return false;
    }
    let last = record.last_run.clone().unwrap_or_default();
    state
        .runs
        .get(&last)
        .is_some_and(|run| run.state == "completed")
}

/// `holdsThread` for a live task in `state`. Work is past its agent's final
/// reply only once both its own agent and the thread's main agent finished
/// their turns.
pub fn task_holds_thread(state: &ThreadState, task: &BackgroundTask) -> bool {
    let root = state
        .root_key
        .as_ref()
        .and_then(|key| get(&state.agents, key));
    let replied = owner_turn_finished(state, task)
        && root.is_none_or(|root| {
            agent_turn_finished_by_id(state, &root.agent.id)
        });
    holds_thread(
        &crate::background_hold::HoldFacts {
            ambient: task_ambient(task),
            kind: &task.kind,
            internal: task.internal.unwrap_or(false),
            blocks_prompts: task.blocks_prompts.unwrap_or(false),
        },
        replied,
    )
}

/// Human truthiness for the stored ambient flag (never validated).
fn task_ambient(task: &BackgroundTask) -> bool {
    match &task.ambient {
        crate::json_io::Json::Null => false,
        crate::json_io::Json::Bool(value) => *value,
        crate::json_io::Json::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        crate::json_io::Json::String(value) => !value.is_empty(),
        crate::json_io::Json::Array(items) => !items.is_empty(),
        crate::json_io::Json::Object(map) => !map.is_empty(),
    }
}

fn agent_turn_finished_by_id(state: &ThreadState, agent_id: &str) -> bool {
    agent_turn_finished(state, agent_id)
}

/// Whether an item is live tool work.
pub fn is_live_tool(item: &Item) -> bool {
    match item {
        Item::ToolCall { call, .. } => matches!(
            call.status.as_str(),
            "running" | "pending" | "awaiting_approval"
        ),
        _ => false,
    }
}

/// One immutable-fact view per synchronous status or deadline pass.
pub struct StatusInputs<'a> {
    /// Waiting targets by agent id.
    pub waits_by_agent: HashMap<String, Vec<WaitEntry>>,
    /// The transport watermark for this pass.
    pub last_transport_signal_at: i64,
    /// Agent id to native key.
    pub by_id: &'a indexmap::IndexMap<String, String>,
    /// Pending interactions by agent id.
    pub interactions_by_agent: HashMap<String, Vec<&'a crate::entity_model::Interaction>>,
    /// Holding tasks by agent id.
    pub tasks_by_agent: HashMap<String, Vec<&'a BackgroundTask>>,
    /// Live tools by agent id.
    pub tools_by_agent: HashMap<String, Vec<&'a Item>>,
    /// The tree's parent links.
    pub children: &'a indexmap::IndexMap<String, indexmap::IndexMap<String, bool>>,
    /// The memoizing subtree signal reader for this pass.
    pub last_subtree_signal: SubtreeSignalReader<'a>,
    /// Every agent with live owned work.
    pub waiting_owners: HashSet<String>,
}

/// A wait entry: the agent whose tool waits, and on which children.
#[derive(Debug, Clone)]
pub struct WaitEntry {
    /// The waiting agent's id.
    pub agent_id: String,
    /// The awaited children, empty for all live children.
    pub targets: Vec<String>,
}

/// Build one view over the current state.
pub fn status_inputs(state: &ThreadState) -> StatusInputs<'_> {
    let mut interactions_by_agent: HashMap<String, Vec<_>> = HashMap::new();
    for key in pending_interaction_keys(state, None) {
        if let Some(interaction) = get(&state.interactions, &key) {
            interactions_by_agent
                .entry(interaction.agent_id.clone())
                .or_default()
                .push(interaction);
        }
    }
    let mut tasks_by_agent: HashMap<String, Vec<_>> = HashMap::new();
    for key in running_task_keys(state, None) {
        if let Some(task) = get(&state.tasks, &key) {
            if task_holds_thread(state, task) {
                tasks_by_agent
                    .entry(task.agent_id.clone())
                    .or_default()
                    .push(task);
            }
        }
    }
    let mut tools_by_agent: HashMap<String, Vec<&Item>> = HashMap::new();
    for key in live_tool_keys(state, None) {
        if let Some(item) = get(&state.items, &key) {
            if is_live_tool(item) {
                tools_by_agent
                    .entry(item.agent_id().to_owned())
                    .or_default()
                    .push(item);
            }
        }
    }
    let mut waits_by_agent: HashMap<String, Vec<WaitEntry>> = HashMap::new();
    for key in live_tool_keys(state, None) {
        let targets = get(&state.item_links, &key).and_then(|links| links.waiting_for.clone());
        let item = get(&state.items, &key);
        if let (Some(targets), Some(Item::ToolCall { call, .. })) = (targets, item) {
            waits_by_agent
                .entry(call.agent_id.clone())
                .or_default()
                .push(WaitEntry {
                    agent_id: call.agent_id.clone(),
                    targets,
                });
        }
    }
    let waiting_owners: HashSet<String> = interactions_by_agent
        .keys()
        .chain(tasks_by_agent.keys())
        .chain(tools_by_agent.keys())
        .cloned()
        .collect();
    StatusInputs {
        waits_by_agent,
        last_transport_signal_at: transport_signal_at(state),
        by_id: &state.indexes.agent_keys_by_id,
        interactions_by_agent,
        tasks_by_agent,
        tools_by_agent,
        children: &state.indexes.children_by_parent,
        last_subtree_signal: SubtreeSignalReader::new(state),
        waiting_owners,
    }
}

/// Any live owned work or completion-relevant child suppresses active-run silence.
pub fn suppresses_active_silence(
    waiting_owners: &HashSet<String>,
    agent_id: &str,
    live_children: usize,
) -> bool {
    waiting_owners.contains(agent_id) || live_children > 0
}
