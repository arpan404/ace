// SPDX-License-Identifier: Apache-2.0
//! The agent tree of `tree.ts`: placeholders for early frames, parenting,
//! native link reconciliation, and branch announcements for windowed readers.
//!
//! Every function returns `None` on a caller-contract violation (the id
//! sequence failing, which never happens with the real bindings); invalid
//! provider facts never reach this far, they become rejection notices.

use std::collections::HashSet;

use crate::emit::{Event, emit, get, put};
use crate::item_model::NativeRef;
use crate::state::{Agent, AgentRecord, ApplyContext, ThreadState};
use crate::status::AgentStatus;

/// A windowed reader may have forgotten this settled branch. Announce
/// parents first.
pub fn announce_agent_branch(state: &mut ThreadState, key: &str, events: &mut Vec<Event>) {
    let mut branch: Vec<Agent> = Vec::new();
    let mut seen = HashSet::new();
    let mut next: Option<String> = Some(key.to_owned());
    while let Some(current) = next {
        if !seen.insert(current.clone()) {
            break;
        }
        let record = match get(&state.agents, &current) {
            Some(record) => record,
            None => break,
        };
        branch.push(record.agent.clone());
        next = record.parent_key.clone();
    }
    let mut announced: Vec<String> = Vec::new();
    for event in events.iter() {
        if let Event::AgentCreated { agent } = event {
            announced.push(agent.id.clone());
        }
    }
    for agent in branch.iter().rev() {
        if !announced.iter().any(|id| id == &agent.id) {
            announced.push(agent.id.clone());
            emit(
                events,
                Event::AgentCreated {
                    agent: agent.clone(),
                },
            );
        }
    }
}

/// Insert the placeholder record for `key` when it is missing.
fn insert_placeholder(
    state: &mut ThreadState,
    key: &str,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    if state.agents.contains_key(key) {
        return Some(());
    }
    let parent_key = state.root_key.clone();
    let root = parent_key
        .as_ref()
        .and_then(|parent| state.agents.get(parent));
    let (parent_id, origin, provider, cwd) = match root {
        Some(root) => (
            Some(root.agent.id.clone()),
            "provider_subagent".to_owned(),
            root.agent.native.provider.clone(),
            root.agent.cwd.clone(),
        ),
        None => (
            None,
            "root".to_owned(),
            state.config.provider.clone(),
            String::new(),
        ),
    };
    let agent = Agent {
        id: ctx.ids.next("agent")?,
        thread_id: state.thread_id.clone(),
        child_thread_id: None,
        machine: None,
        parent_id,
        origin,
        lineage: None,
        native: NativeRef {
            provider,
            acp_agent_id: None,
            installation_id: None,
            instance_id: None,
            native_id: Some(key.to_owned()),
            path: None,
            forked_from_native_id: None,
            aliases: None,
        },
        fidelity: "placeholder".to_owned(),
        spawned_by: crate::json_io::Maybe::Missing,
        name: None,
        role: None,
        model: None,
        cwd,
        status: AgentStatus::Starting,
        background: false,
        created_at: ctx.now,
        ended_at: None,
    };
    let record = AgentRecord {
        agent,
        external_status: None,
        active_run: None,
        completion_relevant: None,
        last_run: None,
        native_runs: None,
        last_outcome_order: None,
        last_successful_outcome_order: None,
        last_error: None,
        process_settled_status: None,
        activity: "starting_turn".to_owned(),
        detail: None,
        last_signal_at: ctx.now,
        disconnected_at: None,
        limited: None,
        retry: None,
        wake_until: None,
        parent_key: parent_key.clone(),
        spawned_by_key: None,
    };
    let created = record.agent.clone();
    put(&mut state.agents, key.to_owned(), record);
    crate::indexes::refresh_agent_index(state, key, None);
    if state.root_key.is_none() {
        state.root_key = Some(key.to_owned());
    }
    emit(events, Event::AgentCreated { agent: created });
    Some(())
}

/// Creates a conservative placeholder instead of discarding early frames.
pub fn ensure_agent<'a>(
    state: &'a mut ThreadState,
    key: &str,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<&'a mut AgentRecord> {
    insert_placeholder(state, key, ctx, events)?;
    state.agents.get_mut(key)
}

/// An `agent.updated` change set: only changed fields are emitted.
#[derive(Debug, Default)]
pub struct AgentChange {
    /// Independent ace child thread.
    pub child_thread_id: Option<Option<String>>,
    pub machine: Option<crate::item_meta::AgentMachine>,
    pub parent_id: Option<Option<String>>,
    pub origin: Option<String>,
    pub lineage: Option<crate::item_meta::ThreadLineage>,
    pub fidelity: Option<String>,
    pub native: Option<crate::item_model::NativeRef>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
    pub model: Option<String>,
    pub spawned_by: Option<Option<String>>,
    pub background: Option<bool>,
}

fn same_json(left: &Json, right: &Json) -> bool {
    crate::json_io::json_equal(left, right)
}

use crate::json_io::{Json, Maybe};

/// Emit the changed fields of one agent, like `changeAgent`.
pub fn change_agent(
    state: &mut ThreadState,
    key: &str,
    change: AgentChange,
    events: &mut Vec<Event>,
) -> Option<()> {
    let record = state.agents.get_mut(key)?;
    let agent = &mut record.agent;
    let mut out = AgentChange::default();
    let mut any = false;
    if let Some(value) = change.child_thread_id {
        if agent.child_thread_id != value {
            agent.child_thread_id = value.clone();
            out.child_thread_id = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.machine {
        let same = agent.machine.as_ref().is_some_and(|current| {
            same_json(
                &crate::json_io::to_value(current),
                &crate::json_io::to_value(&value),
            )
        });
        if !same {
            agent.machine = Some(value.clone());
            out.machine = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.parent_id {
        if agent.parent_id != value {
            agent.parent_id = value.clone();
            out.parent_id = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.origin {
        if agent.origin != value {
            agent.origin = value.clone();
            out.origin = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.lineage {
        let same = agent.lineage.as_ref().is_some_and(|current| {
            same_json(
                &crate::json_io::to_value(current),
                &crate::json_io::to_value(&value),
            )
        });
        if !same {
            agent.lineage = Some(value.clone());
            out.lineage = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.fidelity {
        if agent.fidelity != value {
            agent.fidelity = value.clone();
            out.fidelity = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.native {
        let same = same_json(
            &crate::json_io::to_value(&agent.native),
            &crate::json_io::to_value(&value),
        );
        if !same {
            agent.native = value.clone();
            out.native = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.cwd {
        if agent.cwd != value {
            agent.cwd = value.clone();
            out.cwd = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.name {
        if agent.name.as_deref() != Some(value.as_str()) {
            agent.name = Some(value.clone());
            out.name = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.role {
        if agent.role.as_deref() != Some(value.as_str()) {
            agent.role = Some(value.clone());
            out.role = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.model {
        if agent.model.as_deref() != Some(value.as_str()) {
            agent.model = Some(value.clone());
            out.model = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.spawned_by {
        let current = match &agent.spawned_by {
            Maybe::Missing => None,
            Maybe::Null => Some(None),
            Maybe::Value(name) => Some(Some(name.clone())),
        };
        if current != Some(value.clone()) {
            agent.spawned_by = match value.clone() {
                None => Maybe::Null,
                Some(name) => Maybe::Value(name),
            };
            out.spawned_by = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.background {
        if agent.background != value {
            agent.background = value;
            out.background = Some(value);
            any = true;
        }
    }
    if !any {
        return Some(());
    }
    let agent_id = agent.id.clone();
    emit(
        events,
        Event::AgentUpdated {
            agent_id,
            child_thread_id: out.child_thread_id.unwrap_or(None),
            machine: out.machine,
            parent_id: out.parent_id,
            origin: out.origin,
            lineage: out.lineage,
            fidelity: out.fidelity,
            native: out.native,
            cwd: out.cwd,
            name: out.name,
            role: out.role,
            model: out.model,
            spawned_by: out.spawned_by,
            background: out.background,
            ended_at: None,
        },
    );
    Some(())
}

/// Set one agent's parent, like `setParent`. Fails the fold on a cycle.
pub fn set_parent(
    state: &mut ThreadState,
    key: &str,
    parent_key: Option<&str>,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    ensure_agent(state, key, ctx, events)?;
    if parent_key == Some(key) {
        return None;
    }
    let clears_spawn = {
        let record = get(&state.agents, key)?;
        record.parent_key.as_deref() != parent_key
            && (record.spawned_by_key.is_some() || !record.agent.spawned_by.is_missing())
    };
    // Cycle check before touching state.
    if let Some(parent) = parent_key {
        let mut visited = std::collections::HashSet::new();
        let mut ancestor: Option<String> = Some(parent.to_owned());
        while let Some(name) = ancestor {
            if name == key {
                return None;
            }
            if !visited.insert(name.clone()) {
                break;
            }
            ancestor = get(&state.agents, &name)?.parent_key.clone();
        }
        ensure_agent(state, parent, ctx, events)?;
    }
    let record = get(&state.agents, key)?;
    let previous_parent_id = record.agent.parent_id.clone();
    if clears_spawn {
        if let Some(record) = state.agents.get_mut(key) {
            record.spawned_by_key = None;
        }
    }
    let parent_agent_id = parent_key.and_then(|parent| {
        ensure_agent(state, parent, ctx, events)?;
        get(&state.agents, parent).map(|record| record.agent.id.clone())
    });
    if let Some(parent) = parent_key {
        if let Some(record) = state.agents.get_mut(key) {
            record.parent_key = Some(parent.to_owned());
        }
    } else if let Some(record) = state.agents.get_mut(key) {
        record.parent_key = None;
    }
    let spawned = clears_spawn.then_some(None);
    change_agent(
        state,
        key,
        AgentChange {
            parent_id: Some(parent_agent_id),
            spawned_by: spawned,
            ..Default::default()
        },
        events,
    )?;
    crate::indexes::refresh_agent_index(state, key, previous_parent_id.as_deref());
    Some(())
}

/// Adopt `key` as the thread's root, reparenting a placeholder old root.
fn adopt_root(
    state: &mut ThreadState,
    key: &str,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let old_root_key = state.root_key.clone();
    state.root_key = Some(key.to_owned());
    set_parent(state, key, None, ctx, events)?;
    ensure_agent(state, key, ctx, events)?;
    change_agent(
        state,
        key,
        AgentChange {
            origin: Some("root".to_owned()),
            ..Default::default()
        },
        events,
    )?;
    if let Some(old) = old_root_key {
        if old != key {
            let reparent = get(&state.agents, &old).is_some_and(|record| {
                record.agent.fidelity == "placeholder" || record.agent.origin != "root"
            });
            if reparent {
                set_parent(state, &old, Some(key), ctx, events)?;
                change_agent(
                    state,
                    &old,
                    AgentChange {
                        origin: Some("provider_subagent".to_owned()),
                        ..Default::default()
                    },
                    events,
                )?;
            }
        }
    }
    Some(())
}

/// An unknown parent must exist before its child is assigned an ace id.
fn ensure_parent(
    state: &mut ThreadState,
    key: &str,
    parent_key: &str,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    if key == parent_key {
        return None;
    }
    ensure_agent(state, parent_key, ctx, events)?;
    // The first frame may belong to a child before its real root is known.
    if state.root_key.as_deref() == Some(key) {
        adopt_root(state, parent_key, ctx, events)?;
    }
    Some(())
}

/// Consume the initial root on the first fold.
pub fn ensure_initial_root(
    state: &mut ThreadState,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let initial = match state.initial_root.clone() {
        Some(initial) => initial,
        None => return Some(()),
    };
    state.initial_root = None;
    see_agent(
        state,
        &crate::facts::Fact::AgentSeen {
            agent: initial.agent,
            parent: None,
            spawned_by: initial.spawned_by,
            origin: "root".to_owned(),
            lineage: initial.lineage,
            fidelity: initial.fidelity,
            native: initial.native,
            cwd: initial.cwd,
            name: initial.name,
            role: initial.role,
            model: initial.model,
            background: initial.background,
            machine: initial.machine,
        },
        ctx,
        events,
    )
}

/// Fold one `agent.seen` fact.
pub fn see_agent(
    state: &mut ThreadState,
    fact: &crate::facts::Fact,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let crate::facts::Fact::AgentSeen {
        agent,
        parent,
        spawned_by,
        origin,
        lineage,
        fidelity,
        native,
        cwd,
        name,
        role,
        model,
        background,
        machine,
    } = fact
    else {
        return None;
    };
    if let Some(parent) = parent {
        ensure_parent(state, agent, parent, ctx, events)?;
    }
    ensure_agent(state, agent, ctx, events)?;
    if origin == "root" {
        adopt_root(state, agent, ctx, events)?;
    } else if let Some(parent) = parent {
        set_parent(state, agent, Some(parent), ctx, events)?;
    }
    if let Some(spawned_by) = spawned_by {
        if let Some(record) = state.agents.get_mut(agent) {
            record.spawned_by_key = Some(spawned_by.clone());
        }
        crate::indexes::register_spawn_link(state, agent, spawned_by);
    }
    change_agent(
        state,
        agent,
        AgentChange {
            origin: Some(origin.clone()),
            lineage: lineage.clone(),
            fidelity: Some(fidelity.clone()),
            native: Some(native.clone()),
            cwd: Some(cwd.clone()),
            name: name.clone(),
            role: role.clone(),
            model: model.clone(),
            background: *background,
            machine: machine.clone(),
            ..Default::default()
        },
        events,
    )?;
    reconcile_links(state, ctx, events)
}

/// Fold one `agent.linked` fact.
pub fn link_agent(
    state: &mut ThreadState,
    fact: &crate::facts::Fact,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let crate::facts::Fact::AgentLinked {
        agent,
        parent,
        spawned_by,
        background,
        name,
        model,
    } = fact
    else {
        return None;
    };
    if let Some(parent) = parent {
        ensure_parent(state, agent, parent, ctx, events)?;
    }
    ensure_agent(state, agent, ctx, events)?;
    if let Some(parent) = parent {
        set_parent(state, agent, Some(parent), ctx, events)?;
    }
    if let Some(spawned_by) = spawned_by {
        if let Some(record) = state.agents.get_mut(agent) {
            record.spawned_by_key = Some(spawned_by.clone());
        }
        crate::indexes::register_spawn_link(state, agent, spawned_by);
    }
    change_agent(
        state,
        agent,
        AgentChange {
            name: name.clone(),
            model: model.clone(),
            background: *background,
            ..Default::default()
        },
        events,
    )?;
    reconcile_links(state, ctx, events)
}

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
                    {
                        if let crate::item_model::ToolDetail::AgentSpawn {
                            child_agent_id, ..
                        } = &mut call.detail
                        {
                            *child_agent_id = Some(linked_id.clone());
                        }
                    }
                    if let Some(record) = state.agents.get_mut(&linked_key) {
                        record.spawned_by_key = Some(key.clone());
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
                    {
                        if let crate::item_model::ToolDetail::AgentMessage {
                            target_agent_id, ..
                        } = &mut call.detail
                        {
                            *target_agent_id = Some(linked_id.clone());
                        }
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
