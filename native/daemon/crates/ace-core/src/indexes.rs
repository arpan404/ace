// SPDX-License-Identifier: Apache-2.0
//! The live indexes of `indexes.ts`: which tools, texts, interactions and
//! tasks are live, and the native-key links joined as both sides arrive.

use crate::emit::{get, put, remove};
use crate::items::Item;
use crate::state::ThreadState;

/// Text the provider is still streaming: a turn's end closes it.
fn is_open_text(item: Option<&Item>) -> bool {
    let Some(item) = item else {
        return false;
    };
    if item.complete() {
        return false;
    }
    match item {
        Item::Reasoning { .. } | Item::Compaction { .. } => true,
        Item::Message { role, .. } => role == "assistant",
        _ => false,
    }
}

/// Refresh the live-tool and open-text flags for one item key.
pub fn refresh_item_index(state: &mut ThreadState, key: &str) {
    let item = get(&state.items, key);
    let live = matches!(
        item,
        Some(Item::ToolCall { call, .. })
            if ["running", "pending", "awaiting_approval"].contains(&call.status.as_str())
    );
    if live {
        put(&mut state.indexes.live_tools, key.to_owned(), true);
    } else {
        remove(&mut state.indexes.live_tools, key);
    }
    if is_open_text(item) {
        put(&mut state.indexes.open_text, key.to_owned(), true);
    } else {
        remove(&mut state.indexes.open_text, key);
    }
    if state.item_links.contains_key(key) {
        register_item_link(state, key);
    }
}

/// Refresh the pending flag for one interaction key.
pub fn refresh_interaction_index(state: &mut ThreadState, key: &str) {
    let pending =
        get(&state.interactions, key).is_some_and(|interaction| interaction.state == "pending");
    if pending {
        put(
            &mut state.indexes.pending_interactions,
            key.to_owned(),
            true,
        );
    } else {
        remove(&mut state.indexes.pending_interactions, key);
    }
}

/// Refresh the running flag for one task key.
pub fn refresh_task_index(state: &mut ThreadState, key: &str) {
    let task = get(&state.tasks, key);
    let running = match task {
        Some(task) if task.status == "running" => true,
        Some(task) if task.status == "unknown" => {
            state.uncertain_tasks.get(key).is_some_and(|held| *held)
        }
        _ => false,
    };
    if running {
        put(&mut state.indexes.running_tasks, key.to_owned(), true);
    } else {
        remove(&mut state.indexes.running_tasks, key);
    }
}

/// Refresh the id and parent links for one agent key.
pub fn refresh_agent_index(state: &mut ThreadState, key: &str, previous_parent_id: Option<&str>) {
    let (agent_id, parent_id) = match get(&state.agents, key) {
        Some(record) => (record.agent.id.clone(), record.agent.parent_id.clone()),
        None => return,
    };
    put(
        &mut state.indexes.agent_keys_by_id,
        agent_id.clone(),
        key.to_owned(),
    );
    if let Some(previous) = previous_parent_id
        && !previous.is_empty()
        && Some(previous) != parent_id.as_deref()
        && let Some(previous_children) = state.indexes.children_by_parent.get_mut(previous)
    {
        previous_children.shift_remove(key);
    }
    let Some(parent_id) = parent_id else {
        return;
    };
    let children = state
        .indexes
        .children_by_parent
        .entry(parent_id.clone())
        .or_default();
    put(children, key.to_owned(), true);
}

/// Remember that `agent_key` was spawned by `item_key` until the item lands.
pub fn register_spawn_link(state: &mut ThreadState, agent_key: &str, item_key: &str) {
    let agents = state
        .indexes
        .pending_spawn_links
        .entry(item_key.to_owned())
        .or_default();
    put(agents, agent_key.to_owned(), true);
}

/// Remember that `item_key` has links to join once its item lands.
pub fn register_item_link(state: &mut ThreadState, item_key: &str) {
    put(
        &mut state.indexes.pending_item_links,
        item_key.to_owned(),
        true,
    );
}

/// Live tool keys, optionally for one agent id.
pub fn live_tool_keys(state: &ThreadState, agent_id: Option<&str>) -> Vec<String> {
    state
        .indexes
        .live_tools
        .keys()
        .filter(|key| {
            agent_id
                .is_none_or(|id| get(&state.items, key).is_some_and(|item| item.agent_id() == id))
        })
        .cloned()
        .collect()
}

/// Pending interaction keys, optionally for one agent id.
pub fn pending_interaction_keys(state: &ThreadState, agent_id: Option<&str>) -> Vec<String> {
    state
        .indexes
        .pending_interactions
        .keys()
        .filter(|key| {
            agent_id.is_none_or(|id| {
                get(&state.interactions, key).is_some_and(|interaction| interaction.agent_id == id)
            })
        })
        .cloned()
        .collect()
}

/// Running task keys, optionally for one agent id.
pub fn running_task_keys(state: &ThreadState, agent_id: Option<&str>) -> Vec<String> {
    state
        .indexes
        .running_tasks
        .keys()
        .filter(|key| {
            agent_id.is_none_or(|id| get(&state.tasks, key).is_some_and(|task| task.agent_id == id))
        })
        .cloned()
        .collect()
}

/// Open text keys, optionally for one agent id.
pub fn open_text_keys(state: &ThreadState, agent_id: Option<&str>) -> Vec<String> {
    state
        .indexes
        .open_text
        .keys()
        .filter(|key| {
            agent_id
                .is_none_or(|id| get(&state.items, key).is_some_and(|item| item.agent_id() == id))
        })
        .cloned()
        .collect()
}
