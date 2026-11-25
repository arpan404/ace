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

pub use crate::tree_links::reconcile_links;
pub use crate::tree_parent::{ensure_initial_root, link_agent, see_agent, set_parent};

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
        appended: Vec::new(),
        extra: Default::default(),
    };
    let mut record = AgentRecord {
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
        appended: Vec::new(),
        extra: Default::default(),
    };
    if record.parent_key.is_some() {
        record.appended("parentKey");
    }
    let created = record.agent.clone();
    put(&mut state.agents, key.to_owned(), record);
    crate::indexes::refresh_agent_index(state, key, None);
    if state.root_key.is_none() {
        state.root_key = Some(key.to_owned());
        state.appended("rootKey");
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
///
/// The emitted fields follow the literal order of the TypeScript call's change set (parent,
/// origin, lineage, fidelity, native, cwd, name, role, model, background, machine), because
/// that object's key order is what `JSON.stringify` persists.
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
    if let Some(value) = change.parent_id
        && agent.parent_id != value
    {
        agent.parent_id = value.clone();
        out.parent_id = Some(value);
        any = true;
    }
    if let Some(value) = change.origin
        && agent.origin != value
    {
        agent.origin = value.clone();
        out.origin = Some(value);
        any = true;
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
            agent.appended("lineage");
            out.lineage = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.fidelity
        && agent.fidelity != value
    {
        agent.fidelity = value.clone();
        out.fidelity = Some(value);
        any = true;
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
    if let Some(value) = change.cwd
        && agent.cwd != value
    {
        agent.cwd = value.clone();
        out.cwd = Some(value);
        any = true;
    }
    if let Some(value) = change.name
        && agent.name.as_deref() != Some(value.as_str())
    {
        agent.name = Some(value.clone());
        agent.appended("name");
        out.name = Some(value);
        any = true;
    }
    if let Some(value) = change.role
        && agent.role.as_deref() != Some(value.as_str())
    {
        agent.role = Some(value.clone());
        agent.appended("role");
        out.role = Some(value);
        any = true;
    }
    if let Some(value) = change.model
        && agent.model.as_deref() != Some(value.as_str())
    {
        agent.model = Some(value.clone());
        agent.appended("model");
        out.model = Some(value);
        any = true;
    }
    if let Some(value) = change.background
        && agent.background != value
    {
        agent.background = value;
        out.background = Some(value);
        any = true;
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
            agent.appended("machine");
            out.machine = Some(value);
            any = true;
        }
    }
    if let Some(value) = change.child_thread_id
        && agent.child_thread_id != value
    {
        agent.child_thread_id = value.clone();
        agent.appended("childThreadId");
        out.child_thread_id = Some(value);
        any = true;
    }
    if let Some(value) = change.spawned_by {
        let current = match &agent.spawned_by {
            Maybe::Missing => None,
            Maybe::Null => Some(None),
            Maybe::Value(name) => Some(Some(name.clone())),
        };
        if current != Some(value.clone()) {
            if agent.spawned_by.is_missing() {
                agent.appended("spawnedBy");
            }
            agent.spawned_by = match value.clone() {
                None => Maybe::Null,
                Some(name) => Maybe::Value(name),
            };
            out.spawned_by = Some(value);
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
            parent_id: out.parent_id,
            origin: out.origin,
            lineage: out.lineage,
            fidelity: out.fidelity,
            native: out.native,
            cwd: out.cwd,
            name: out.name,
            role: out.role,
            model: out.model,
            background: out.background,
            machine: out.machine,
            child_thread_id: out.child_thread_id.unwrap_or(None),
            spawned_by: out.spawned_by,
        },
    );
    Some(())
}
