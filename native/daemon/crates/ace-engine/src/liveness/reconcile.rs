// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;
use std::rc::Rc;

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use crate::{Core, EngineError, State};

/// Inspect each owner after its children so a repaired child status reaches every ancestor.
pub async fn tree(core: &Rc<Core>, root: &str) -> Result<(), EngineError> {
    let owners = core.with_state(|state| super::thread_tree(core, state, root))??;
    for owner in owners.into_iter().rev() {
        crate::actor::mailbox::flush(Rc::clone(core), owner.clone(), core.executor.current()).await;
        core.store.atomic(|_| {
            core.with_state(|state| {
                refresh_children(core, state, &owner)?;
                reconcile_stopped(core, state, &owner)
            })?
        })?;
    }
    Ok(())
}

fn refresh_children(core: &Core, state: &mut State, owner: &str) -> Result<(), EngineError> {
    let Some(snapshot) = state.repo.state(&core.store, owner)? else {
        return Ok(());
    };
    let children = {
        let mut snapshot = snapshot.borrow_mut();
        snapshot.hydrate_agents()?;
        snapshot
            .state
            .agents
            .values()
            .filter(|record| record.agent.machine.is_none())
            .filter_map(|record| record.agent.child_thread_id.clone())
            .collect::<Vec<_>>()
    };
    for child in children {
        if let Some(status) = child_status(core, state, &child)? {
            refresh_edge(core, state, owner, &child, status)?;
        }
    }
    Ok(())
}

/// A startup candidate can have a parent whose stale done status excluded it from recovery.
/// Walk the indexed permission parent links for the recovered child, checking each actual edge.
pub(crate) fn ancestors(core: &Core, state: &mut State, id: &str) -> Result<(), EngineError> {
    let mut seen = HashSet::from([id.to_owned()]);
    let mut child = id.to_owned();
    let mut status = child_status(core, state, id)?;
    while let Some(child_status) = status {
        let Some(parent) =
            local_parent(core, state, &child)?.filter(|parent| seen.insert(parent.clone()))
        else {
            break;
        };
        if !refresh_edge(core, state, &parent, &child, child_status)? {
            break;
        }
        let Some(snapshot) = state.repo.state(&core.store, &parent)? else {
            break;
        };
        status = Some(status_value(&snapshot.borrow().state.status)?);
        child = parent;
    }
    Ok(())
}

pub(crate) fn local_parent(
    core: &Core,
    state: &mut State,
    child: &str,
) -> Result<Option<String>, EngineError> {
    let parent = stmt_cache::get_row(
        core.store.conn(),
        "SELECT parent FROM engine_permissions WHERE thread_id=?",
        vec![Cell::Text(child.to_owned())],
    )?
    .and_then(|row| {
        row.get("parent")
            .and_then(crate::repository::residency::cell_text)
            .map(str::to_owned)
    });
    let Some(parent) = parent else {
        return Ok(None);
    };
    Ok(local_edge(core, state, &parent, child)?.map(|_| parent))
}

fn child_status(core: &Core, state: &mut State, child: &str) -> Result<Option<Value>, EngineError> {
    let Some(row) = crate::recovery::threads::get(&core.store, child)? else {
        return Ok(None);
    };
    if matches!(
        row.status.get("state").and_then(Value::as_str),
        Some("done" | "new")
    ) && let Some(snapshot) = state.repo.state(&core.store, child)?
    {
        let pending = snapshot.borrow().state.indexes.pending_interactions.len();
        if pending != 0 {
            return Ok(Some(
                ace_json::json!({"state":"needs_you","interactions":pending}),
            ));
        }
    }
    Ok(Some(row.status))
}

fn status_value(status: &ace_core::thread_status::ThreadStatus) -> Result<Value, EngineError> {
    let serialized = ace_json::ser::to_string(status)
        .map_err(|error| EngineError::Records(error.to_string()))?;
    ace_json::parse(&serialized).map_err(|error| EngineError::Records(error.to_string()))
}

fn refresh_edge(
    core: &Core,
    state: &mut State,
    parent: &str,
    child: &str,
    status: Value,
) -> Result<bool, EngineError> {
    let Some(record) = local_edge(core, state, parent, child)? else {
        return Ok(false);
    };
    let previous = record
        .external_status
        .as_ref()
        .map(status_value)
        .transpose()?;
    if previous.as_ref() != Some(&status) {
        crate::delegation::update_child(
            core,
            state,
            core.ports.now(),
            parent,
            &ace_json::json!({"id":child,"status":status}),
        )?;
    }
    Ok(true)
}

fn local_edge(
    core: &Core,
    state: &mut State,
    parent: &str,
    child: &str,
) -> Result<Option<ace_core::state::AgentRecord>, EngineError> {
    let Some(snapshot) = state.repo.state(&core.store, parent)? else {
        return Ok(None);
    };
    let key = crate::delegation::child_agent_key(child);
    let Some(record) = snapshot.borrow_mut().agent(&key)? else {
        return Ok(None);
    };
    if record.agent.machine.is_some() || record.agent.child_thread_id.as_deref() != Some(child) {
        return Ok(None);
    }
    Ok(Some(record))
}

fn reconcile_stopped(core: &Core, state: &mut State, id: &str) -> Result<(), EngineError> {
    if state.sessions.is_closing(id)
        || state.session_opening(id)
        || state.workers.sends.is_active(id)
        || state.workers.steering.is_active(id)
        || state
            .actors
            .get(id)
            .is_some_and(|actor| actor.session_attached)
    {
        return Ok(());
    }
    let Some(snapshot) = state.repo.state(&core.store, id)? else {
        return Ok(());
    };
    let now = core.ports.now();
    let interrupted = {
        let mut snapshot = snapshot.borrow_mut();
        snapshot.hydrate_recovery()?;
        snapshot.state.process_exit.is_none()
            && crate::restart::lost_work(&snapshot.state, 0, None, now as i64).is_some()
    };
    let mut facts =
        crate::recovery::session_bound::settle_session_bound_tasks(core, id, &snapshot)?;
    if interrupted {
        facts.extend([
            ace_json::json!({"type":"process.exited","deliberate":false,"message":"The agent stopped unexpectedly"}),
            ace_json::json!({"type":"queue.changed","source":"provider","count":0}),
            super::notice::interrupted_notice(snapshot.borrow().state.root_key.as_deref(), now, super::notice::Interruption::Exit, None),
        ]);
    }
    if !facts.is_empty() {
        state.apply(
            &core.store,
            id,
            &ace_json::to_string(&Value::Array(facts.into())),
            now,
            None,
        )?;
    }
    for intent in crate::intents::header::headers(core.store.conn(), Some(id), None)? {
        if !super::resumable(&intent.kind) {
            crate::intents::lifecycle::mark(
                &core.store,
                &intent,
                "failed",
                Some("Owning provider session is no longer running"),
            )?;
            state.transition_release_guards(&core.store, &intent.command_id)?;
        }
    }
    if interrupted {
        crate::recovery::capture::hold_interrupted_in(core, state, id)?;
    }
    crate::queue::holds::sync(core, state, id, now)
}
