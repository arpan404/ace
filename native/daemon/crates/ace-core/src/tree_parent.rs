// SPDX-License-Identifier: Apache-2.0
//! Parent and root changes as agents are discovered and linked.

use crate::emit::{Event, get};
use crate::state::{ApplyContext, ThreadState};
use crate::tree::{AgentChange, change_agent, ensure_agent};
use crate::tree_links::reconcile_links;

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
    if clears_spawn && let Some(record) = state.agents.get_mut(key) {
        record.spawned_by_key = None;
    }
    let parent_agent_id = parent_key.and_then(|parent| {
        ensure_agent(state, parent, ctx, events)?;
        get(&state.agents, parent).map(|record| record.agent.id.clone())
    });
    if let Some(parent) = parent_key {
        if let Some(record) = state.agents.get_mut(key) {
            if record.parent_key.is_none() {
                record.appended("parentKey");
            }
            record.parent_key = Some(parent.to_owned());
        }
    } else if let Some(record) = state.agents.get_mut(key) {
        record.parent_key = None;
        record.appended.retain(|key| *key != "parentKey");
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
    state.appended("rootKey");
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
    if let Some(old) = old_root_key
        && old != key
    {
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
            record.appended("spawnedByKey");
            record.appended("spawnedByKey");
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
            record.appended("spawnedByKey");
            record.appended("spawnedByKey");
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
