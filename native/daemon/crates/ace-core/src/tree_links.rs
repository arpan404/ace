// SPDX-License-Identifier: Apache-2.0
//! Reconcile native agent references with stored transcript and tree records.

use crate::emit::{Event, emit, get, put};
use crate::state::{ApplyContext, ThreadState};
use crate::tree::{AgentChange, change_agent, ensure_agent};
use crate::tree_parent::set_parent;

/// Join native keys after either side of a link appears, in either order.
pub fn reconcile_links(
    state: &mut ThreadState,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let pending: Vec<(String, Vec<String>)> = state
        .indexes
        .pending_spawn_links
        .iter()
        .map(|(item, agents)| (item.clone(), agents.keys().cloned().collect()))
        .collect();
    for (item_key, agents) in pending {
        if get(&state.items, &item_key).is_none() {
            continue;
        }
        for key in agents {
            let spawned_by =
                get(&state.agents, &key).and_then(|record| record.spawned_by_key.clone());
            if spawned_by.as_deref() != Some(item_key.as_str()) {
                continue;
            }
            let item_id = get(&state.items, &item_key).map(|item| item.id().to_owned())?;
            change_agent(
                state,
                &key,
                AgentChange {
                    spawned_by: Some(Some(item_id)),
                    ..Default::default()
                },
                events,
            )?;
            let links = get(&state.item_links, &item_key)
                .cloned()
                .unwrap_or_default();
            if links.child_agent.is_none() {
                let mut links = links;
                links.child_agent = Some(key.clone());
                put(&mut state.item_links, item_key.clone(), links);
                crate::indexes::register_item_link(state, &item_key);
            }
        }
        state.indexes.pending_spawn_links.shift_remove(&item_key);
    }
    let pending_items: Vec<String> = state.indexes.pending_item_links.keys().cloned().collect();
    for key in pending_items {
        let links = match get(&state.item_links, &key) {
            Some(links) => links.clone(),
            None => {
                state.indexes.pending_item_links.shift_remove(&key);
                continue;
            }
        };
        let item = match get(&state.items, &key) {
            Some(item) => item.clone(),
            None => {
                state.indexes.pending_item_links.shift_remove(&key);
                continue;
            }
        };
        let crate::items::Item::ToolCall { call, .. } = &item else {
            state.indexes.pending_item_links.shift_remove(&key);
            continue;
        };
        let linked_key = match &call.detail {
            crate::item_model::ToolDetail::AgentSpawn { .. } => links.child_agent.clone(),
            crate::item_model::ToolDetail::AgentMessage { .. } => links.target_agent.clone(),
            _ => None,
        };
        let Some(linked_key) = linked_key else {
            state.indexes.pending_item_links.shift_remove(&key);
            continue;
        };
        let linked_id = {
            ensure_agent(state, &linked_key, ctx, events)?;
            get(&state.agents, &linked_key)?.agent.id.clone()
        };
        match &call.detail {
            crate::item_model::ToolDetail::AgentSpawn { .. } => {
                let current = match get(&state.items, &key) {
                    Some(crate::items::Item::ToolCall { call, .. }) => match &call.detail {
                        crate::item_model::ToolDetail::AgentSpawn { child_agent_id, .. } => {
                            child_agent_id.clone()
                        }
                        _ => None,
                    },
                    _ => None,
                };
                if current.as_deref() != Some(linked_id.as_str()) {
                    if let Some(crate::items::Item::ToolCall { call, .. }) =
                        state.items.get_mut(&key)
                        && let crate::item_model::ToolDetail::AgentSpawn { child_agent_id, .. } =
                            &mut call.detail
                    {
                        // packages/core/src/tree.ts:262 changes the existing detail.
                        *child_agent_id = Some(linked_id.clone());
                    }
                    if let Some(record) = state.agents.get_mut(&linked_key) {
                        record.spawned_by_key = Some(key.clone());
                        record.appended("spawnedByKey");
                    }
                    let owner = get(&state.indexes.agent_keys_by_id, &call.agent_id).cloned();
                    set_parent(state, &linked_key, owner.as_deref(), ctx, events)?;
                    change_agent(
                        state,
                        &linked_key,
                        AgentChange {
                            spawned_by: Some(Some(call.id.clone())),
                            ..Default::default()
                        },
                        events,
                    )?;
                    if let Some(item) = get(&state.items, &key) {
                        emit(events, Event::ItemUpdated { item: item.clone() });
                    }
                }
            }
            crate::item_model::ToolDetail::AgentMessage { .. } => {
                let current = match get(&state.items, &key) {
                    Some(crate::items::Item::ToolCall { call, .. }) => match &call.detail {
                        crate::item_model::ToolDetail::AgentMessage {
                            target_agent_id, ..
                        } => target_agent_id.clone(),
                        _ => None,
                    },
                    _ => None,
                };
                if current.as_deref() != Some(linked_id.as_str()) {
                    if let Some(crate::items::Item::ToolCall { call, .. }) =
                        state.items.get_mut(&key)
                        && let crate::item_model::ToolDetail::AgentMessage {
                            target_agent_id, ..
                        } = &mut call.detail
                    {
                        // packages/core/src/tree.ts:268 changes the existing detail.
                        *target_agent_id = Some(linked_id.clone());
                    }
                    if let Some(item) = get(&state.items, &key) {
                        emit(events, Event::ItemUpdated { item: item.clone() });
                    }
                }
            }
            _ => {}
        }
        state.indexes.pending_item_links.shift_remove(&key);
    }
    Some(())
}
